/**
 * Normalizes OpenAI Responses reasoning/tool-call history for safe replay.
 */
import {
  normalizeOpenAIResponsesFunctionCallId,
  replaceCompactionReplayOwnerContent,
  shouldNormalizeOpenAIResponsesToolCallId,
  splitOpenAIFunctionCallPairing,
} from "@openclaw/ai/transports";
import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { createToolCallOccurrenceQueue } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import type { AgentMessage } from "../runtime/index.js";
import { rewriteToolResultIds } from "../tool-call-id.js";

type OpenAIThinkingBlock = {
  type?: unknown;
  thinking?: unknown;
  thinkingSignature?: unknown;
};

type OpenAIToolCallBlock = {
  type?: unknown;
  id?: unknown;
};

type OpenAIReasoningSignature = {
  id: string;
  type: string;
};

function parseOpenAIReasoningSignature(value: unknown): OpenAIReasoningSignature | null {
  if (!value) {
    return null;
  }
  let candidate: { id?: unknown; type?: unknown } | null = null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return null;
    }
    try {
      candidate = JSON.parse(trimmed) as { id?: unknown; type?: unknown };
    } catch {
      return null;
    }
  } else if (typeof value === "object") {
    candidate = value as { id?: unknown; type?: unknown };
  }
  if (!candidate) {
    return null;
  }
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const type = typeof candidate.type === "string" ? candidate.type : "";
  if (!id.startsWith("rs_")) {
    return null;
  }
  if (type === "reasoning" || type.startsWith("reasoning.")) {
    return { id, type };
  }
  return null;
}

function parseTimestampMs(value: unknown): number | null {
  return parseDateFirstTimestampMs(value) ?? null;
}

function isOpenAIToolCallType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

function createOpenAIResponsesToolCallIdResolver() {
  const usedCallIds = new Set<string>();
  const occurrences = new Map<string, number>();
  const pendingByOriginalId = createToolCallOccurrenceQueue<string>();
  const normalizeId = (id: string) =>
    shouldNormalizeOpenAIResponsesToolCallId(id) ? normalizeOpenAIResponsesFunctionCallId(id) : id;

  return {
    resolveAssistantId(id: string): string {
      let rewritten = normalizeId(id);
      const { itemId } = splitOpenAIFunctionCallPairing(rewritten);
      let occurrence = occurrences.get(id) ?? 0;
      while (usedCallIds.has(splitOpenAIFunctionCallPairing(rewritten).callId)) {
        occurrence += 1;
        const suffix = sha256HexPrefixCore(`${id}:${occurrence}`, 24);
        rewritten = `call_${suffix}${itemId ? `|fc_${suffix}` : ""}`;
      }
      occurrences.set(id, occurrence);
      usedCallIds.add(splitOpenAIFunctionCallPairing(rewritten).callId);
      pendingByOriginalId.add(id, rewritten);
      return rewritten;
    },
    // The canonical result rewriter calls this once before synchronizing aliases.
    resolveToolResultId: (id: string): string => pendingByOriginalId.claim(id) ?? normalizeId(id),
  };
}

/**
 * OpenAI Responses rejects replayed `function_call.call_id`,
 * `function_call.id`, and matching `function_call_output.call_id` values
 * that exceed its 64-char `call_*` / `fc_*` shape. pi-ai skips its own
 * normalizer for same-model replay, then splits persisted `call_id|fc_id`
 * pairs directly into the provider payload, so OpenClaw must normalize here.
 */
export function normalizeOpenAIResponsesToolCallIds(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const resolver = createOpenAIResponsesToolCallIdResolver();
  const rewrittenMessages: AgentMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      rewrittenMessages.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      if (!Array.isArray(assistantMsg.content)) {
        rewrittenMessages.push(msg);
        continue;
      }

      let assistantChanged = false;
      const nextContent = assistantMsg.content.map((block) => {
        if (!block || typeof block !== "object") {
          return block;
        }
        const toolCallBlock = block as OpenAIToolCallBlock;
        if (!isOpenAIToolCallType(toolCallBlock.type) || typeof toolCallBlock.id !== "string") {
          return block;
        }

        const nextId = resolver.resolveAssistantId(toolCallBlock.id);
        if (nextId === toolCallBlock.id) {
          return block;
        }
        assistantChanged = true;
        return {
          ...block,
          id: nextId,
        } as typeof block;
      });

      if (!assistantChanged) {
        rewrittenMessages.push(msg);
        continue;
      }
      changed = true;
      rewrittenMessages.push(replaceCompactionReplayOwnerContent(assistantMsg, nextContent));
      continue;
    }

    if (role === "toolResult") {
      const next = rewriteToolResultIds({
        message: msg as Extract<AgentMessage, { role: "toolResult" }>,
        resolveId: resolver.resolveToolResultId,
      });
      if (next !== msg) {
        changed = true;
      }
      rewrittenMessages.push(next);
      continue;
    }

    rewrittenMessages.push(msg);
  }

  return changed ? rewrittenMessages : messages;
}

/**
 * OpenAI can reject replayed `function_call` items with an `fc_*` id if the
 * matching `reasoning` item is absent in the same assistant turn.
 *
 * When that pairing is missing, strip the `|fc_*` suffix from tool call ids so
 * shared model runtime omits `function_call.id` on replay.
 */
export function downgradeOpenAIFunctionCallReasoningPairs(
  messages: AgentMessage[],
): AgentMessage[] {
  let changed = false;
  const rewrittenMessages: AgentMessage[] = [];
  let pendingRewrittenIds: Map<string, string> | null = null;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      pendingRewrittenIds = null;
      rewrittenMessages.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      if (!Array.isArray(assistantMsg.content)) {
        pendingRewrittenIds = null;
        rewrittenMessages.push(msg);
        continue;
      }

      const localRewrittenIds = new Map<string, string>();
      let seenReplayableReasoning = false;
      let assistantChanged = false;
      const nextContent = assistantMsg.content.map((block) => {
        if (!block || typeof block !== "object") {
          return block;
        }

        const thinkingBlock = block as OpenAIThinkingBlock;
        if (
          thinkingBlock.type === "thinking" &&
          parseOpenAIReasoningSignature(thinkingBlock.thinkingSignature)
        ) {
          seenReplayableReasoning = true;
          return block;
        }

        const toolCallBlock = block as OpenAIToolCallBlock;
        if (!isOpenAIToolCallType(toolCallBlock.type) || typeof toolCallBlock.id !== "string") {
          return block;
        }

        const pairing = splitOpenAIFunctionCallPairing(toolCallBlock.id);
        if (seenReplayableReasoning || !pairing.itemId || !pairing.itemId.startsWith("fc_")) {
          return block;
        }

        assistantChanged = true;
        localRewrittenIds.set(toolCallBlock.id, pairing.callId);
        return {
          ...block,
          id: pairing.callId,
        } as typeof block;
      });

      pendingRewrittenIds = localRewrittenIds.size > 0 ? localRewrittenIds : null;
      if (!assistantChanged) {
        rewrittenMessages.push(msg);
        continue;
      }
      changed = true;
      rewrittenMessages.push(replaceCompactionReplayOwnerContent(assistantMsg, nextContent));
      continue;
    }

    if (role === "toolResult" && pendingRewrittenIds && pendingRewrittenIds.size > 0) {
      const localRewrittenIds = pendingRewrittenIds;
      const next = rewriteToolResultIds({
        message: msg as Extract<AgentMessage, { role: "toolResult" }>,
        resolveId: (id) => localRewrittenIds.get(id) ?? id,
      });
      if (next !== msg) {
        changed = true;
      }
      rewrittenMessages.push(next);
      continue;
    }

    pendingRewrittenIds = null;
    rewrittenMessages.push(msg);
  }

  return changed ? rewrittenMessages : messages;
}

/**
 * Extracts the Responses `phase` (commentary/final_answer) from a v1 textSignature, if present.
 * Used when dropping the paired msg_* id so phase metadata can be preserved independently.
 */
function extractTextSignaturePhase(signature: string): "commentary" | "final_answer" | undefined {
  if (!signature.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(signature) as { v?: unknown; phase?: unknown };
    if (parsed.v === 1 && (parsed.phase === "commentary" || parsed.phase === "final_answer")) {
      return parsed.phase;
    }
  } catch {
    // Not a structured signature; nothing to preserve.
  }
  return undefined;
}

/**
 * Drops reasoning from before a model route switch and clears paired message ids.
 * The transport owns orphan detection after preparing the actual replay payload.
 */
export function dropStaleOpenAIReasoning(
  messages: AgentMessage[],
  dropBefore?: number,
): AgentMessage[] {
  if (dropBefore === undefined) {
    return messages;
  }
  let anyChanged = false;
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") {
      out.push(msg);
      continue;
    }

    const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistantMsg.content)) {
      out.push(msg);
      continue;
    }
    const messageTimestamp = parseTimestampMs((assistantMsg as { timestamp?: unknown }).timestamp);
    // Timestamp-less legacy entries cannot prove they belong to the new route;
    // treat them as pre-switch so stale provider ids never re-enter replay.
    if (messageTimestamp !== null && messageTimestamp > dropBefore) {
      out.push(msg);
      continue;
    }

    let changed = false;
    let droppedReplayableReasoning = false;
    type AssistantContentBlock = (typeof assistantMsg.content)[number];

    const nextContent: AssistantContentBlock[] = [];
    for (const block of assistantMsg.content) {
      if (!block) {
        changed = true;
        continue;
      }
      if (typeof block !== "object") {
        nextContent.push(block);
        continue;
      }
      const record = block as OpenAIThinkingBlock;
      if (record.type !== "thinking") {
        nextContent.push(block);
        continue;
      }
      const signature = parseOpenAIReasoningSignature(record.thinkingSignature);
      if (!signature) {
        nextContent.push(block);
        continue;
      }
      changed = true;
      droppedReplayableReasoning = true;
    }

    if (!changed) {
      out.push(msg);
      continue;
    }

    anyChanged = true;
    if (nextContent.length === 0) {
      continue;
    }

    // When a replayable reasoning (rs_*) item is dropped after a model/fallback
    // switch, its paired assistant message id (msg_*) must be dropped too. The
    // Responses transport replays msg_* from a text block textSignature, so an
    // orphaned msg_* without its rs_* makes providers like Azure reject the next
    // turn (issue #88019). Drop the id from the signature, but keep any phase
    // metadata (commentary/final_answer) so the Responses phase contract survives.
    const finalContent = droppedReplayableReasoning
      ? nextContent.map((contentBlock) => {
          if (!contentBlock || typeof contentBlock !== "object") {
            return contentBlock;
          }
          if (contentBlock.type !== "text" || contentBlock.textSignature === undefined) {
            return contentBlock;
          }
          const phase = extractTextSignaturePhase(contentBlock.textSignature);
          const { textSignature: _droppedTextSignature, ...rest } = contentBlock;
          return phase !== undefined
            ? { ...rest, textSignature: JSON.stringify({ v: 1, phase }) }
            : rest;
        })
      : nextContent;

    out.push(replaceCompactionReplayOwnerContent(assistantMsg, finalContent));
  }

  return anyChanged ? out : messages;
}

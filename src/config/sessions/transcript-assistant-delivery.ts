import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantDeliveryTtsFacts, AssistantMessage } from "../../llm/types.js";
import {
  readAssistantDirectiveTextGroups,
  projectAssistantDisplayContent,
} from "../../shared/assistant-display-content.js";
import {
  extractAssistantPhaseText,
  extractAssistantTextForPhase,
  readAssistantTextBlocksForPhase,
  type AssistantPhase,
} from "../../shared/chat-message-content.js";
import { createTextPartCodeRegionResolver } from "../../shared/text/code-regions.js";
import { trimTextPreservingCode } from "../../shared/text/text-projection.js";
import { extractTtsDirectiveParts } from "../../tts/directive-facts.js";
import {
  parseInlineDirectiveParts,
  stripInlineDirectivePartsForDelivery,
} from "../../utils/directive-tags.js";
import type { LatestTranscriptAssistantText } from "./session-accessor.types.js";

type AssistantDirectiveMessage = {
  content?: unknown;
  openclawDelivery?: unknown;
  role?: unknown;
};

type AssistantDeliveryFacts = NonNullable<AssistantMessage["openclawDelivery"]>;

/** Turn-owned display preparation; source text precedes transcript-only hook rewrites. */
export type PrepareAssistantTranscriptMessage = (
  message: AssistantMessage,
  sourceText: string | undefined,
) => AssistantMessage;

/** Record display ownership without rewriting bytes used by runtime transcript identity. */
export function recordAssistantManagedMediaUrls<T extends AssistantDirectiveMessage>(
  message: T,
  urls: readonly string[] | undefined,
): T {
  const mediaUrls = Array.from(new Set(urls?.map((url) => url.trim()).filter(Boolean) ?? []));
  if (message.role === "assistant" && mediaUrls.length > 0) {
    Object.assign(message, {
      openclawDelivery: {
        ...(isRecord(message.openclawDelivery) ? message.openclawDelivery : {}),
        mediaUrls,
      },
    });
  }
  return message;
}

function mergeTtsFacts(
  current: AssistantDeliveryTtsFacts | undefined,
  next: AssistantDeliveryTtsFacts,
): AssistantDeliveryTtsFacts {
  return {
    tagged: true,
    ...((current?.text ?? next.text) != null ? { text: current?.text ?? next.text } : {}),
    ...(current?.directives || next.directives
      ? { directives: [...(current?.directives ?? []), ...(next.directives ?? [])] }
      : {}),
  };
}

/** Record final delivery facts; only explicitly prepared display copies rewrite text. */
// TRANSITIONAL(marker-retirement): retire live fact extraction once model-emitted
// controls stop. Display parsing still serves retained transcripts.
export function applyAssistantDeliveryDirectives<T extends AssistantDirectiveMessage>(
  message: T,
  options?: { managedMediaUrls?: readonly string[]; stripForDisplay?: true },
): T {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  const finalBlocks = readAssistantTextBlocksForPhase(message, "final_answer");
  const blocks = finalBlocks.length ? finalBlocks : readAssistantTextBlocksForPhase(message);
  let facts: AssistantDeliveryFacts | undefined;
  for (const group of readAssistantDirectiveTextGroups(blocks)) {
    const next = applyAssistantDeliveryTextBlocks(group, options?.stripForDisplay);
    if (!next) {
      continue;
    }
    const priorTts = facts?.tts;
    facts = Object.assign(facts ?? {}, next);
    if (next.tts) {
      facts.tts = mergeTtsFacts(priorTts, next.tts);
    }
    if (next.replyToId) {
      delete facts.replyToCurrent;
    } else if (next.replyToCurrent) {
      delete facts.replyToId;
    }
  }
  if (facts) {
    const currentFacts = isRecord(message.openclawDelivery) ? message.openclawDelivery : undefined;
    const mergedFacts = mergeAssistantDeliveryFacts(currentFacts, facts);
    Object.assign(message, { openclawDelivery: mergedFacts });
  }
  return recordAssistantManagedMediaUrls(message, options?.managedMediaUrls);
}

/** Merge only persisted facts; text interpretation and runtime authority stay separate. */
export function mergeAssistantDeliveryFacts(
  current: Record<string, unknown> | undefined,
  next: AssistantDeliveryFacts,
): AssistantDeliveryFacts {
  const merged = { ...current, ...next };
  if (next.replyToId) {
    delete merged.replyToCurrent;
  } else if (next.replyToCurrent) {
    delete merged.replyToId;
  }
  return merged;
}

/** One raw directive scope reuses native multipart/code ownership and fact extraction. */
function applyAssistantDeliveryTextBlocks(
  blocks: ReturnType<typeof readAssistantTextBlocksForPhase>,
  stripForDisplay?: true,
): AssistantDeliveryFacts | undefined {
  const original = blocks.map((block) => block.text);
  const parsed = parseInlineDirectiveParts(original);
  const stripped = stripInlineDirectivePartsForDelivery(parsed.map((part) => part.text));
  const tts = extractTtsDirectiveParts(stripped.map((part) => part.text));
  const codeRegions =
    blocks.length > 1
      ? createTextPartCodeRegionResolver(tts.map((part) => part.cleanedText))
      : undefined;
  let facts: AssistantDeliveryFacts | undefined;
  for (const [index, block] of blocks.entries()) {
    const reply = expectDefined(parsed[index], "parsed assistant part");
    const speech = expectDefined(tts[index], "prepared assistant speech part");
    const hasDeliveryFacts = reply.hasAudioTag || reply.hasReplyTag || Boolean(speech.facts);
    if (speech.cleanedText === original[index] && !hasDeliveryFacts) {
      continue;
    }
    if (stripForDisplay) {
      block.text = speech.facts
        ? trimTextPreservingCode(speech.cleanedText, "both", codeRegions?.(index))
        : speech.cleanedText;
    }
    if (!hasDeliveryFacts) {
      continue;
    }
    facts ??= {};
    Object.assign(facts, {
      ...(reply.audioAsVoice ? { audioAsVoice: true as const } : {}),
      ...(reply.replyToCurrent ? { replyToCurrent: true as const } : {}),
      ...(reply.replyToExplicitId ? { replyToId: reply.replyToExplicitId } : {}),
      ...(speech.facts ? { tts: mergeTtsFacts(facts.tts, speech.facts) } : {}),
    });
  }
  return facts;
}

/** Clean one phase's display text together so code ownership survives native block splits. */
export function stripAssistantDeliveryDirectivePartsForDisplay(texts: readonly string[]): string[] {
  const content = texts.map((text) => ({ type: "text", text }));
  applyAssistantDeliveryDirectives({ role: "assistant", content }, { stripForDisplay: true });
  return content.map((block) => block.text);
}

/** Clean a display string without rewriting its durable source or deriving runtime authority. */
export function stripAssistantDeliveryDirectivesForDisplay(text: string): string {
  return expectDefined(
    stripAssistantDeliveryDirectivePartsForDisplay([text])[0],
    "single display part",
  );
}

/** Project authored display text while retaining literal interpretation and original model bytes. */
export function projectAssistantDirectiveDisplayText(
  message: unknown,
  phase?: AssistantPhase,
): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const source = projectAssistantDisplayContent(message);
  if (!Array.isArray(source.content)) {
    const text = phase
      ? extractAssistantTextForPhase(source, { phase })
      : extractAssistantPhaseText(source);
    return text === undefined ? undefined : stripAssistantDeliveryDirectivesForDisplay(text);
  }
  const content = source.content.map((block) => (isRecord(block) ? { ...block } : block));
  const prepared: Record<string, unknown> = { ...source, content };
  delete prepared.text;
  if (phase === "commentary") {
    for (const blocks of readAssistantDirectiveTextGroups(
      readAssistantTextBlocksForPhase(prepared, phase),
    )) {
      applyAssistantDeliveryTextBlocks(blocks, true);
    }
  } else {
    applyAssistantDeliveryDirectives(prepared, { stripForDisplay: true });
  }
  return phase
    ? extractAssistantTextForPhase(prepared, { phase })
    : extractAssistantPhaseText(prepared);
}

/** Decode only persisted delivery facts; transcript records cannot supply runtime authority. */
function readAssistantDeliveryFacts(value: unknown): AssistantDeliveryFacts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const facts: AssistantDeliveryFacts = {};
  if (value.audioAsVoice === true) {
    facts.audioAsVoice = true;
  }
  if (typeof value.replyToId === "string" && value.replyToId.trim()) {
    facts.replyToId = value.replyToId;
  } else if (value.replyToCurrent === true) {
    facts.replyToCurrent = true;
  }
  if (Array.isArray(value.mediaUrls)) {
    const mediaUrls = value.mediaUrls.filter(
      (url): url is string => typeof url === "string" && url.trim().length > 0,
    );
    if (mediaUrls.length) {
      facts.mediaUrls = mediaUrls;
    }
  }
  if (value.textPhaseRequiresTerminal === true) {
    facts.textPhaseRequiresTerminal = true;
  }
  if (isRecord(value.tts) && value.tts.tagged === true) {
    const tts: AssistantDeliveryTtsFacts = { tagged: true };
    if (typeof value.tts.text === "string") {
      tts.text = value.tts.text;
    }
    if (Array.isArray(value.tts.directives)) {
      tts.directives = value.tts.directives.flatMap((directive) => {
        if (!isRecord(directive) || !isRecord(directive.values)) {
          return [];
        }
        const entries = Object.entries(directive.values);
        if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
          return [];
        }
        const values = Object.fromEntries(entries);
        return [
          {
            ...(typeof directive.provider === "string" ? { provider: directive.provider } : {}),
            values,
          },
        ];
      });
    }
    facts.tts = tts;
  }
  return Object.keys(facts).length ? facts : undefined;
}

/** SQLite and retained JSONL readers expose the same authored text and delivery facts. */
export function projectAssistantTranscriptText(
  message: unknown,
  id?: unknown,
): LatestTranscriptAssistantText | undefined {
  if (!isRecord(message) || message.role !== "assistant") {
    return undefined;
  }
  const text = extractAssistantPhaseText(message);
  if (!text?.trim()) {
    return undefined;
  }
  const openclawDelivery = readAssistantDeliveryFacts(message.openclawDelivery);
  return {
    ...(typeof id === "string" && id ? { id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
    ...(openclawDelivery ? { openclawDelivery } : {}),
  };
}

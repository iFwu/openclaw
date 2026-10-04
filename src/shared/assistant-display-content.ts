import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage } from "../llm/types.js";

export const ASSISTANT_DISPLAY_CONTENT_FIELD = "openclawDisplayContent";

type AssistantModelContentBlock = AssistantMessage["content"][number];

/** Literal interpretation describes text only, never delivery or writer authority. */
export function isAssistantLiteralTextBlock(value: unknown): boolean {
  const block = asOptionalRecord(value);
  return (
    block?.textInterpretation === "literal" &&
    typeof block.text === "string" &&
    (block.type === "text" || block.type === "input_text" || block.type === "output_text")
  );
}

/** Prepared text is a separate directive scope; raw-native parts keep their multipart owner. */
export function readAssistantDirectiveTextGroups<T>(blocks: readonly T[]): T[][] {
  const groups: T[][] = [];
  let current: T[] | undefined;
  for (const block of blocks) {
    if (isAssistantLiteralTextBlock(block)) {
      current = undefined;
    } else {
      if (!current) {
        current = [];
        groups.push(current);
      }
      current.push(block);
    }
  }
  return groups;
}

function isAssistantModelContentBlock(value: unknown): value is AssistantModelContentBlock {
  const block = asOptionalRecord(value);
  if (!block) {
    return false;
  }
  if (block.type === "text") {
    return typeof block.text === "string";
  }
  if (block.type === "thinking") {
    return typeof block.thinking === "string";
  }
  return (
    block.type === "toolCall" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    asOptionalRecord(block.arguments) !== undefined
  );
}

export function retainAssistantModelContent(
  blocks: readonly unknown[],
): AssistantMessage["content"] {
  return blocks.filter(isAssistantModelContentBlock).map((block) => Object.assign({}, block));
}

export function readAssistantDisplayContent(message: unknown): Record<string, unknown>[] {
  const record = asOptionalRecord(message);
  if (!record) {
    return [];
  }
  const display = record[ASSISTANT_DISPLAY_CONTENT_FIELD];
  const content = Array.isArray(display) ? display : record.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

export function projectAssistantDisplayContent(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const display = message[ASSISTANT_DISPLAY_CONTENT_FIELD];
  if (message.role !== "assistant" || !Array.isArray(display)) {
    return message;
  }
  const { [ASSISTANT_DISPLAY_CONTENT_FIELD]: _, ...rest } = message;
  return { ...rest, content: display };
}

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stripMarkdown } from "../shared/text/strip-markdown.js";
import { normalizeProgressCardInput, ProgressCardInputError } from "./progress-card-input.js";

/** Projects readable notes and checklists independently through the shared Markdown owner. */
export function projectProgressCardChannelUpdate(input: unknown) {
  const record = asOptionalRecord(input);
  if (!record) {
    return undefined;
  }
  try {
    const normalized = normalizeProgressCardInput(record);
    const steps = normalized.steps ?? [];
    const explanation = normalized.markdown
      ? stripMarkdown(normalized.markdown, { linkStyle: "label", stripHtml: true })
          .replace(/\s+/g, " ")
          .trim()
      : undefined;
    return {
      steps,
      ...(explanation ? { explanation, explanationFormat: "plain" as const } : {}),
    };
  } catch (error) {
    if (error instanceof ProgressCardInputError) {
      return undefined;
    }
    throw error;
  }
}

import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";
import { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";
import { trimTextPreservingCode } from "../shared/text/text-projection.js";
import { replaceOutsideCodeRegionParts } from "../utils/directive-tags.js";

const APPEND_INERT_TEXT = /^[\p{L}\p{M}\p{N} .,!?]*$/u;

type SpeechBlockEdit = { start: number; end: number; body: string };

/** Prove a completed speech paragraph inert under ordinary, same-line appends. */
export function proveTtsDirectiveAppendInert(
  source: string,
  projected: string,
): { cleanedText: string; acceptsAppend: (delta: string) => boolean } | undefined {
  // No line boundary, reference syntax, or unpaired code delimiter may acquire
  // new Markdown ownership while this proof is retained. Syntax appends revoke it.
  if (/[\r\n\t]/u.test(source)) {
    return undefined;
  }
  const edits: SpeechBlockEdit[] = [];
  const part = extractTtsDirectivePartsWithEdits([source], (edit) => edits.push(edit))[0];
  if (
    !part?.facts ||
    !edits.length ||
    !projected ||
    part.cleanedText.trim() !== projected ||
    trimTextPreservingCode(part.cleanedText) !== projected
  ) {
    return undefined;
  }
  let cursor = 0;
  let regions: ReturnType<typeof findCodeRegions> | undefined;
  for (const edit of edits) {
    if (
      !APPEND_INERT_TEXT.test(source.slice(cursor, edit.start)) ||
      !APPEND_INERT_TEXT.test(edit.body.replaceAll("`", ""))
    ) {
      return undefined;
    }
    for (
      let at = source.indexOf("`", edit.start);
      at >= 0 && at < edit.end;
      at = source.indexOf("`", at + 1)
    ) {
      regions ??= findCodeRegions(source);
      if (!isInsideCode(at, regions)) {
        return undefined;
      }
    }
    cursor = edit.end;
  }
  if (!APPEND_INERT_TEXT.test(source.slice(cursor))) {
    return undefined;
  }
  return { cleanedText: part.cleanedText, acceptsAppend: (delta) => APPEND_INERT_TEXT.test(delta) };
}

/** Extract final-text TTS syntax into persisted facts, leaving markdown code spans unchanged. */
export function extractTtsDirectiveFacts(text: string): {
  cleanedText: string;
  facts?: AssistantDeliveryTtsFacts;
} {
  return expectDefined(extractTtsDirectiveParts([text])[0], "single TTS directive part");
}

export function extractTtsDirectiveParts(texts: readonly string[]): Array<{
  cleanedText: string;
  facts?: AssistantDeliveryTtsFacts;
}> {
  return extractTtsDirectivePartsWithEdits(texts);
}

function extractTtsDirectivePartsWithEdits(
  texts: readonly string[],
  onSpeechBlock?: (edit: SpeechBlockEdit) => void,
): Array<{
  cleanedText: string;
  facts?: AssistantDeliveryTtsFacts;
}> {
  const parts: Array<{ cleanedText: string; facts?: AssistantDeliveryTtsFacts }> = texts.map(
    (cleanedText) => ({ cleanedText }),
  );
  if (!/\[\[\s*\/?\s*tts(?:\s*:|\s*\]\])/iu.test(texts.join("\n"))) {
    return parts;
  }
  const replaceStage = (
    regex: RegExp,
    replacement: (
      captures: unknown[],
      facts: AssistantDeliveryTtsFacts,
      offset: number,
      match: string,
    ) => string,
  ) => {
    const cleanedTexts = replaceOutsideCodeRegionParts(
      parts.map((part) => part.cleanedText),
      regex,
      (match, captures, offset, _source, partIndex) => {
        const part = expectDefined(parts[partIndex], "TTS directive start part");
        return replacement(captures, (part.facts ??= { tagged: true }), offset, match);
      },
    );
    cleanedTexts.forEach((cleanedText, index) => {
      expectDefined(parts[index], "TTS directive result part").cleanedText = cleanedText;
    });
  };

  const blockRegex = /\[\[\s*tts\s*:\s*text\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*:\s*text\s*\]\]/gi;
  replaceStage(blockRegex, ([inner], next, offset, match) => {
    onSpeechBlock?.({ start: offset, end: offset + match.length, body: String(inner) });
    if (next.text == null) {
      next.text = String(inner).trim();
    }
    return "";
  });

  const plainBlockRegex = /\[\[\s*tts\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*\]\]/gi;
  replaceStage(plainBlockRegex, ([inner], next) => {
    const visible = String(inner).trim();
    if (next.text == null) {
      next.text = visible;
    }
    return visible;
  });

  const directiveRegex = /\[\[\s*tts\s*:\s*([^\]]+)\]\]/gi;
  replaceStage(directiveRegex, ([body], next) => {
    const tokens = String(body).split(/\s+/).filter(Boolean);
    let provider: string | undefined;
    const values: Record<string, string> = {};
    for (const token of tokens) {
      const eqIndex = token.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }
      const rawKey = token.slice(0, eqIndex).trim();
      const rawValue = token.slice(eqIndex + 1).trim();
      if (!rawKey || !rawValue) {
        continue;
      }
      const key = normalizeLowercaseStringOrEmpty(rawKey);
      if (key === "provider") {
        provider = normalizeLowercaseStringOrEmpty(rawValue) || undefined;
        continue;
      }
      values[key] = rawValue;
    }
    if (provider || Object.keys(values).length > 0) {
      next.directives ??= [];
      next.directives.push({ ...(provider ? { provider } : {}), values });
    }
    return "";
  });

  const bareTagRegex = /\[\[\s*tts\s*\]\]/gi;
  replaceStage(bareTagRegex, () => "");

  const closingTagRegex = /\[\[\s*\/\s*tts(?:\s*:\s*[^\]]*)?\]\]/gi;
  replaceStage(closingTagRegex, () => "");

  return parts;
}

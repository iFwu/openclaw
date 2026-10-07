import { describe, expect, it } from "vitest";
import { TelegramConfigSchema } from "../config-api.js";

describe("Telegram retained progress configuration", () => {
  it.each([true, false])("preserves persist=%s and an explicitly disabled line cap", (persist) => {
    const streaming = {
      mode: "progress" as const,
      progress: { persist, maxLineChars: false as const },
    };
    const parsed = TelegramConfigSchema.parse({ streaming });
    expect(parsed.streaming).toEqual(streaming);
  });
  it.each([0, -1, true])("rejects invalid maxLineChars=%s", (maxLineChars) => {
    expect(
      TelegramConfigSchema.safeParse({ streaming: { progress: { maxLineChars } } }).success,
    ).toBe(false);
  });
});

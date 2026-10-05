import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: Record<string, unknown> };

function accepts(value: unknown): boolean {
  return validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey: "workboard.manifest.owner-cap",
    value,
  }).ok;
}

describe("Workboard owner-cap plugin configuration", () => {
  it.each([
    {},
    { dispatch: {} },
    { dispatch: { maxRunningPerOwner: 1 } },
    { dispatch: { maxRunningPerOwner: 2 } },
  ])("accepts configuration %j", (value) => {
    expect(accepts(value)).toBe(true);
  });

  it.each([0, -1, 1.5, "2", null, true])("rejects invalid capacity %j", (maxRunningPerOwner) => {
    expect(accepts({ dispatch: { maxRunningPerOwner } })).toBe(false);
  });

  it("rejects unknown top-level and dispatch settings", () => {
    expect(accepts({ maxRunningPerOwner: 2 })).toBe(false);
    expect(accepts({ dispatch: { maxRunningPerOwner: 2, override: true } })).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import { resolveCronPreflight } from "./run-fallback-policy.js";

vi.mock("./model-preflight.runtime.js", () => ({
  preflightCronModelProvider: async ({ provider }: { provider: string }) =>
    provider === "alpha"
      ? {
          status: "unavailable",
          reason: "local test endpoint unavailable",
          provider,
          model: "main",
          baseUrl: "http://127.0.0.1:9",
          retryAfterMs: 0,
        }
      : { status: "available" },
}));
const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      model: {
        primary: "alpha/main",
        fallbacks: ["global/tail"],
        fallbackChains: {
          "alpha/main": ["beta/backup", "gamma/next"],
          "beta/backup": ["other/chain"],
        },
      },
    },
  },
};
function job(fallbacks?: string[]): CronJob {
  return {
    id: "policy-test",
    name: "Policy",
    schedule: { kind: "at", at: "2026-10-03T00:00:00Z" },
    sessionTarget: "isolated",
    wakeMode: "now",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    payload: {
      kind: "agentTurn",
      message: "test",
      ...(fallbacks !== undefined ? { fallbacks } : {}),
    },
    state: {},
  };
}
describe("cron preflight selected root", () => {
  it("retains A as policy root after preflight picks B and preserves A's remaining flat ladder", async () => {
    const result = await resolveCronPreflight({
      cfg,
      job: job(),
      agentId: "main",
      provider: "alpha",
      model: "main",
    });
    expect(result).toMatchObject({
      ok: true,
      provider: "beta",
      model: "backup",
      modelFallbacksOverride: ["gamma/next", "global/tail"],
      fallbackPolicyRoot: { provider: "alpha", model: "main" },
    });
  });
  it("keeps an explicit list authoritative without giving it an implicit per-model root", async () => {
    const result = await resolveCronPreflight({
      cfg,
      job: job(["explicit/last"]),
      agentId: "main",
      provider: "beta",
      model: "backup",
    });
    expect(result.ok).toBe(true);
    expect(result).not.toMatchObject({
      fallbackPolicyRoot: expect.objectContaining({ provider: expect.any(String) }),
    });
  });
});

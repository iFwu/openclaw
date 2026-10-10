// Plugin Sdk Surface Report tests cover plugin sdk surface report script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  collectPluginSdkSurfaceReport,
  evaluatePluginSdkSurfaceReport,
  readPluginSdkSurfaceBudgets,
} from "../../scripts/plugin-sdk-surface-report.mts";

const pluginSdkSurfaceBudgetEnvPattern = /^OPENCLAW_PLUGIN_SDK_MAX_/u;

function baseSurfaceReportEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !pluginSdkSurfaceBudgetEnvPattern.test(key)),
  );
}

function runSurfaceReport(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/plugin-sdk-surface-report.mts", "--check"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...baseSurfaceReportEnv(),
        ...env,
      },
    },
  );
}

type SurfaceReport = ReturnType<typeof collectPluginSdkSurfaceReport>;
let surfaceReport: SurfaceReport;

describe("plugin SDK surface report", () => {
  beforeAll(() => {
    surfaceReport = collectPluginSdkSurfaceReport();
  });

  it("rejects unknown CLI options before collecting SDK stats", () => {
    for (const args of [["--chekc"], ["chekc", "--help"]]) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/plugin-sdk-surface-report.mts", ...args],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(`Unknown plugin SDK surface report option: ${args[0]}`);
      expect(result.stderr).not.toContain("at ");
    }
  });

  it("prints help before collecting SDK stats", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/plugin-sdk-surface-report.mts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/plugin-sdk-surface-report.mts",
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("all SDK entrypoints:");
  });

  it("rejects loose numeric budget env vars before collecting SDK stats", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS: "1e9",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS must be a non-negative integer",
    );
    expect(result.stderr).not.toContain("at ");
  });

  it("rejects unsafe budget env vars before collecting SDK stats", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS: "9007199254740992",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_ENTRYPOINTS must be a safe non-negative integer",
    );
    expect(result.stderr).not.toContain("at ");
  });

  it("accepts exact deprecated export budget overrides by public entrypoint", () => {
    const budgetConfig = readPluginSdkSurfaceBudgets({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT: JSON.stringify({ core: 3 }),
    });

    expect(evaluatePluginSdkSurfaceReport(surfaceReport, budgetConfig)).not.toContain(
      expect.stringContaining("public deprecated exports in core"),
    );
  });

  it("keeps wildcard and deprecated surface budgets pinned to current source counts", () => {
    expect(readPluginSdkSurfaceBudgets({}).budgets.publicWildcardReexports).toBe(
      surfaceReport.publicWildcards.count,
    );
    const channelMessage = surfaceReport.publicStats.byEntrypoint.get("channel-message");
    expect(channelMessage).toBeDefined();
    expect(
      readPluginSdkSurfaceBudgets({}).publicDeprecatedExportsByEntrypointBudget["channel-message"],
    ).toBe(channelMessage?.deprecatedExports);
  });

  it("accepts frozen named facades while rejecting missing deprecated reexports", () => {
    expect(surfaceReport.deprecatedBarrelWithoutReexports).toEqual([]);
    const report = {
      ...surfaceReport,
      deprecatedBarrelWithoutReexports: ["channel-message"],
    };

    expect(evaluatePluginSdkSurfaceReport(report, readPluginSdkSurfaceBudgets({}))).toContain(
      "deprecated barrel entrypoints without reexports: channel-message",
    );
  });

  it("keeps approval store internals out of the deprecated infra barrel", () => {
    const source = fs.readFileSync("src/plugin-sdk/infra-runtime.ts", "utf8");
    expect(source).not.toMatch(/export\s+(?:type\s+)?\*\s+from\s+["'][^"']*exec-approvals/u);

    for (const internalName of [
      "ensureExecApprovalsSnapshot",
      "persistAllowAlwaysDecisionLocked",
      "recordAllowlistMatchesUseLocked",
      "resolveExecApprovalsLocked",
      "restoreExecApprovalsSnapshotLocked",
      "updateExecApprovals",
    ]) {
      expect(source).not.toContain(internalName);
    }
  });

  it("reports total and callable exports without imposing growth caps", () => {
    const report = {
      ...surfaceReport,
      publicStats: {
        ...surfaceReport.publicStats,
        totals: {
          ...surfaceReport.publicStats.totals,
          exports: 1_000_000,
          callableExports: 1_000_000,
        },
      },
    };
    expect(evaluatePluginSdkSurfaceReport(report, readPluginSdkSurfaceBudgets({}))).toEqual([]);
    expect(
      evaluatePluginSdkSurfaceReport(
        { ...report, leakedForbiddenExports: ["test-utils"] },
        readPluginSdkSurfaceBudgets({}),
      ),
    ).toContain("forbidden public subpaths: test-utils");
  });

  it("rejects deprecated export growth by public entrypoint", () => {
    const budgetConfig = readPluginSdkSurfaceBudgets({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT: JSON.stringify({ core: 1 }),
    });

    expect(evaluatePluginSdkSurfaceReport(surfaceReport, budgetConfig)).toContain(
      "public deprecated exports in core 3 > 1",
    );
  });
});

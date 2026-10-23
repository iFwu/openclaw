import { expect, it, vi, type Mock } from "vitest";
import type { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronUpdateOptions } from "../cron/service/state.js";
import type { CronJobPatch, CronToolsAllowProvenance } from "../cron/types.js";
import type { RunExit } from "../process/supervisor/types.js";
import type { GatewayCronState } from "./server-cron.js";

type WatchedRun = {
  exit: ReturnType<typeof createDeferred<RunExit>>;
  startedAtMs: number;
  cancel: Mock<() => void>;
  detachOutput: Mock;
  wait: Mock<() => Promise<RunExit>>;
};

type StreamUpdateTestHarness = {
  createWatchedRun: () => WatchedRun;
  mockCronSupervisor: (...runs: WatchedRun[]) => {
    spawn: Mock<() => Promise<WatchedRun & { runId: string }>>;
    cancelScope: Mock;
  };
  createCronConfig: (name: string) => OpenClawConfig;
  loadCronService: (cfg: OpenClawConfig) => GatewayCronState;
};

export function registerGatewayCronStreamUpdateTests({
  createWatchedRun,
  mockCronSupervisor,
  createCronConfig,
  loadCronService,
}: StreamUpdateTestHarness) {
  it.each(["command", "command and payload"] as const)(
    "keeps an external account stream alive when a source-invalidating %s update is rejected",
    async (change) => {
      const watched = createWatchedRun();
      const replacement = createWatchedRun();
      const { spawn, cancelScope } = mockCronSupervisor(watched, replacement);
      const cfg = createCronConfig("server-cron-stream-source-authority");
      cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
      const state = loadCronService(cfg);
      const owner = {
        agentId: "main",
        sessionKey: "agent:main:discord:direct:sender",
        accountId: "work",
      };
      const provenance: CronToolsAllowProvenance = {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "external", channel: "discord" },
      };
      try {
        const added = await state.cron.add(
          {
            name: "account stream",
            enabled: true,
            schedule: { kind: "stream", command: ["source"] },
            sessionTarget: "isolated",
            wakeMode: "now",
            owner,
            delivery: { mode: "none" },
            payload: { kind: "agentTurn", message: "Report events", toolsAllow: ["read"] },
          },
          {
            scheduledToolPolicy: {
              version: 1,
              mode: "account",
              ownerSessionKey: owner.sessionKey,
              ownerAccountId: owner.accountId,
            },
            toolsAllowProvenance: provenance,
          },
        );
        const job = "job" in added ? added.job : added;
        const sourceIdentity = job.state.streamSourceIdentity;
        const previous = structuredClone(state.cron.getJob(job.id));
        const patch: CronJobPatch = {
          schedule: { kind: "stream", command: ["replacement-source"] },
          ...(change === "command and payload"
            ? { payload: { kind: "agentTurn", message: "Report different events" } }
            : {}),
        };

        await expect(state.cron.update(job.id, patch)).rejects.toThrow(
          "would invalidate its authenticated source channel",
        );
        expect(spawn).toHaveBeenCalledOnce();
        expect(watched.cancel).not.toHaveBeenCalled();
        expect(cancelScope).not.toHaveBeenCalled();
        expect(watched.detachOutput).not.toHaveBeenCalled();
        expect(state.cron.getJob(job.id)).toEqual(previous);
        expect(state.cron.getJob(job.id)?.state.streamSourceIdentity).toBe(sourceIdentity);

        const commitGuard = vi.fn();
        const options: CronUpdateOptions = { commitGuard };
        await state.cron.updateWithPrecondition(
          job.id,
          patch,
          () => {
            options.toolsAllowProvenance = provenance;
          },
          options,
        );
        expect(commitGuard).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(watched.cancel).toHaveBeenCalledOnce();
        expect(watched.detachOutput).toHaveBeenCalled();
        expect(state.cron.getJob(job.id)?.schedule).toEqual(patch.schedule);
        expect(state.cron.getJob(job.id)?.state.streamSourceIdentity).not.toBe(sourceIdentity);
      } finally {
        await state.stopStreamWatchers();
        state.cron.stop();
      }
    },
  );
  it("keeps a stream source running when a conditional or invalid update is rejected", async () => {
    const watched = createWatchedRun();
    const { cancel, detachOutput } = watched;
    const { spawn } = mockCronSupervisor(watched);
    const cfg = createCronConfig("server-cron-stream-rejected-update");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    const state = loadCronService(cfg);

    try {
      const added = await state.cron.add({
        name: "stream source",
        enabled: true,
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "event" },
        schedule: { kind: "stream", command: ["source"] },
        sessionTarget: "main",
      });
      const streamJob = "job" in added ? added.job : added;
      const sourceIdentity = streamJob.state.streamSourceIdentity;
      await expect(
        state.cron.updateWithPrecondition(streamJob.id, { enabled: false }, () => {
          throw new Error("revision mismatch");
        }),
      ).rejects.toThrow("revision mismatch");
      await expect(
        state.cron.update(streamJob.id, {
          schedule: { kind: "stream", command: [] },
        }),
      ).rejects.toThrow("non-empty command argv array");
      await state.cron.update(streamJob.id, {
        schedule: { kind: "stream", command: ["source"] },
      });

      expect(spawn).toHaveBeenCalledOnce();
      expect(cancel).not.toHaveBeenCalled();
      expect(detachOutput).not.toHaveBeenCalled();
      expect(state.cron.getJob(streamJob.id)?.enabled).toBe(true);
      expect(state.cron.getJob(streamJob.id)?.state.streamSourceIdentity).toBe(sourceIdentity);
    } finally {
      await state.stopStreamWatchers?.();
      state.cron.stop();
    }
  });
}

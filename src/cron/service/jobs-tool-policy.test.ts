import { describe, expect, it } from "vitest";
import type { CronStoredJob } from "../types.js";
import {
  cronJobMessageActionAuthorityInputsEqual,
  reconcileToolsAllowAuthority,
  reconcileCronChannelRequesterAuthority,
} from "./jobs-tool-policy.js";

function toolJob(toolsAllow: string[] | undefined): CronStoredJob {
  return {
    id: "job-1",
    name: "job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    payload: {
      kind: "script",
      script: "return {}",
      ...(toolsAllow ? { toolsAllow } : {}),
    },
    state: {},
  } as unknown as CronStoredJob;
}

describe("reconcileToolsAllowAuthority exec pin", () => {
  it("stamps the restrict-only pin only for exec-granting caps with the server fact", () => {
    const job = toolJob(["exec", "read"]);
    reconcileToolsAllowAuthority({
      job,
      previouslyUsedToolRuntime: true,
      explicitlyMutatesToolsAllow: true,
      toolsAllowExecTarget: { version: 1, host: "gateway", ask: "always" },
    });
    expect(job.toolsAllowExecTarget).toEqual({ version: 1, host: "gateway", ask: "always" });
    expect(job.toolsAllowExecTargetRequirement).toEqual({
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    });
  });

  it("never stamps a pin onto a cap that does not grant exec", () => {
    const job = toolJob(["read"]);
    reconcileToolsAllowAuthority({
      job,
      previouslyUsedToolRuntime: true,
      explicitlyMutatesToolsAllow: true,
      toolsAllowExecTarget: { version: 1, host: "gateway" },
    });
    expect(job.toolsAllowExecTarget).toBeUndefined();
    expect(job.toolsAllowExecTargetRequirement).toBeUndefined();
  });

  it("clears the pin when the cap is explicitly rewritten without the server fact", () => {
    const job = toolJob(["exec"]);
    job.toolsAllowExecTarget = { version: 1, host: "gateway", ask: "always" };
    job.toolsAllowExecTargetRequirement = {
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    };
    reconcileToolsAllowAuthority({
      job,
      previouslyUsedToolRuntime: true,
      explicitlyMutatesToolsAllow: true,
    });
    expect(job.toolsAllowExecTarget).toBeUndefined();
    expect(job.toolsAllowExecTargetRequirement).toBeUndefined();
  });

  it("keeps the pin across edits that do not touch the cap", () => {
    const job = toolJob(["exec"]);
    job.toolsAllowExecTarget = { version: 1, host: "gateway", ask: "always" };
    job.toolsAllowExecTargetRequirement = {
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    };
    reconcileToolsAllowAuthority({
      job,
      previouslyUsedToolRuntime: true,
      explicitlyMutatesToolsAllow: false,
    });
    expect(job.toolsAllowExecTarget).toEqual({ version: 1, host: "gateway", ask: "always" });
    expect(job.toolsAllowExecTargetRequirement).toEqual({
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    });
  });

  it("drops the pin when the job stops using a tool runtime cap", () => {
    const job = toolJob(undefined);
    job.toolsAllowExecTarget = { version: 1, host: "gateway" };
    job.toolsAllowExecTargetRequirement = {
      version: 1,
      target: { version: 1, host: "gateway" },
      grantIndex: 0,
    };
    reconcileToolsAllowAuthority({
      job,
      previouslyUsedToolRuntime: true,
      explicitlyMutatesToolsAllow: false,
      toolsAllowExecTarget: { version: 1, host: "gateway" },
    });
    expect(job.toolsAllowExecTarget).toBeUndefined();
    expect(job.toolsAllowExecTargetRequirement).toBeUndefined();
  });
});

describe("account read authority inputs", () => {
  it("binds a recorded caller origin to executable inputs but not display metadata", () => {
    const job = {
      ...toolJob(["message"]),
      payload: { kind: "agentTurn" as const, message: "read", toolsAllow: ["message"] },
      owner: { sessionKey: "agent:main:local", accountId: "work" },
      scheduledToolPolicy: {
        version: 1 as const,
        mode: "account" as const,
        ownerSessionKey: "agent:main:local",
        ownerAccountId: "work",
      },
      toolsAllowProvenance: {
        version: 1 as const,
        source: "authenticated-requester" as const,
        callerOrigin: { kind: "local" as const },
      },
    } satisfies CronStoredJob;

    expect(
      cronJobMessageActionAuthorityInputsEqual(job, {
        ...job,
        description: "display only",
        displayName: "Readable name",
      }),
    ).toBe(true);
    expect(
      cronJobMessageActionAuthorityInputsEqual(job, {
        ...job,
        payload: { ...job.payload, message: "read something else" },
      }),
    ).toBe(false);
  });
});

describe("external scheduled origin across operator edits", () => {
  function externalJob(): CronStoredJob {
    return {
      id: "external-reminder",
      name: "reminder",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "at", at: "2030-01-01T12:00:00.000Z" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Report progress", toolsAllow: ["message"] },
      owner: {
        agentId: "ops",
        sessionKey: "agent:ops:telegram:direct:123",
        accountId: "secondary",
      },
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:ops:telegram:direct:123",
        ownerAccountId: "secondary",
      },
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "external", channel: "telegram" },
        channelRequester: {
          version: 1,
          channel: "telegram",
          accountId: "secondary",
          senderId: "123",
        },
      },
      delivery: { mode: "announce", channel: "telegram", to: "123", accountId: "secondary" },
      state: {},
    };
  }

  it.each(["schedule", "failureAlert"] as const)(
    "keeps external channel on %s edits without retaining requester execution authority",
    (field) => {
      const previousJob = externalJob();
      const job = structuredClone(previousJob);
      if (field === "schedule") {
        job.schedule = { kind: "at", at: "2030-01-01T13:00:00.000Z" };
      } else {
        job.failureAlert = { after: 1, channel: "telegram", to: "-123", accountId: "default" };
      }
      reconcileCronChannelRequesterAuthority({ job, previousJob });
      expect(job.toolsAllowProvenance?.callerOrigin).toEqual({
        kind: "external",
        channel: "telegram",
      });
      expect(job.toolsAllowProvenance?.channelRequester).toBeUndefined();
      expect(job.scheduledToolPolicy).toEqual(previousJob.scheduledToolPolicy);
      expect(job.delivery).toEqual(previousJob.delivery);
      expect(cronJobMessageActionAuthorityInputsEqual(previousJob, job)).toBe(false);
    },
  );

  it.each(["stream", "on-exit"] as const)(
    "never treats %s command changes as rescheduling",
    (kind) => {
      const previousJob = externalJob();
      previousJob.schedule =
        kind === "stream" ? { kind, command: ["source"] } : { kind, command: "source" };
      const unchangedSource = structuredClone(previousJob);
      unchangedSource.failureAlert = { after: 1 };
      reconcileCronChannelRequesterAuthority({ job: unchangedSource, previousJob });
      expect(unchangedSource.toolsAllowProvenance?.callerOrigin).toEqual({
        kind: "external",
        channel: "telegram",
      });
      const job = structuredClone(previousJob);
      job.schedule =
        kind === "stream"
          ? { kind, command: ["different-source"] }
          : { kind, command: "different-source" };
      reconcileCronChannelRequesterAuthority({ job, previousJob });
      expect(job.toolsAllowProvenance?.callerOrigin).toEqual({ kind: "unknown" });
    },
  );

  it("does not ignore explicit retention changes during timed schedule conversion", () => {
    const previousJob = externalJob();
    previousJob.schedule = { kind: "every", everyMs: 60_000 };
    const job = structuredClone(previousJob);
    job.schedule = { kind: "at", at: "2030-01-01T13:00:00.000Z" };
    job.deleteAfterRun = true;
    reconcileCronChannelRequesterAuthority({
      job,
      previousJob,
      scheduleRetentionIsImplicit: false,
    });
    expect(job.toolsAllowProvenance?.callerOrigin).toEqual({ kind: "unknown" });
  });

  it("does not preserve local read authority when rescheduled", () => {
    const previousJob = externalJob();
    previousJob.toolsAllowProvenance = {
      version: 1,
      source: "final-executable-surface",
      callerOrigin: { kind: "local" },
    };
    const job = structuredClone(previousJob);
    job.schedule = { kind: "at", at: "2030-01-01T13:00:00.000Z" };
    reconcileCronChannelRequesterAuthority({ job, previousJob });
    expect(job.toolsAllowProvenance?.callerOrigin).toEqual({ kind: "unknown" });
  });

  it.each(["payload", "delivery", "owner", "cap", "unknown"] as const)(
    "does not recover external origin across %s changes",
    (field) => {
      const previousJob = externalJob();
      if (field === "unknown") {
        previousJob.toolsAllowProvenance = {
          version: 1,
          source: "final-executable-surface",
          callerOrigin: { kind: "unknown" },
        };
      }
      const job = structuredClone(previousJob);
      job.schedule = { kind: "at", at: "2030-01-01T13:00:00.000Z" };
      if (field === "payload") {
        job.payload = { kind: "agentTurn", message: "Do different work", toolsAllow: ["message"] };
      }
      if (field === "delivery") {
        job.delivery = { mode: "announce", channel: "telegram", to: "456" };
      }
      if (field === "owner") {
        job.owner = { sessionKey: "agent:ops:telegram:direct:456", accountId: "other" };
      }
      if (field === "cap") {
        job.payload.toolsAllow = ["message", "exec"];
      }
      reconcileCronChannelRequesterAuthority({ job, previousJob });
      expect(job.toolsAllowProvenance?.callerOrigin).toEqual({ kind: "unknown" });
      expect(job.toolsAllowProvenance?.channelRequester).toBeUndefined();
    },
  );
});

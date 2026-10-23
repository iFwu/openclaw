import type { CronConfig } from "../config/types.cron.js";
import { cloneCronJobForMutation, finalizeUpdatedJob } from "../cron/service/jobs-mutation.js";
import {
  assertCronCallerOriginMutation,
  reconcileCronChannelRequesterAuthority,
} from "../cron/service/jobs-tool-policy.js";
import { applyJobPatch } from "../cron/service/jobs.js";
import type { CronUpdateOptions } from "../cron/service/state.js";
import { cronStreamScheduleKey } from "../cron/stream-schedule.js";
import type { CronStoredJob, CronJobPatch } from "../cron/types.js";

/** Preview the service-owned authority decision before stopping a live stream source. */
export function shouldStopCronStreamSource(
  current: CronStoredJob,
  patch: CronJobPatch,
  params: {
    defaultAgentId?: string;
    nowMs: number;
    cronConfig?: CronConfig;
    options?: CronUpdateOptions;
  },
): boolean {
  const validated = cloneCronJobForMutation(current);
  applyJobPatch(validated, patch, {
    defaultAgentId: params.defaultAgentId,
    scheduleValidationNowMs: params.nowMs,
    cronConfig: params.cronConfig,
    scheduledToolPolicy: params.options?.scheduledToolPolicy,
    toolsAllowProvenance: params.options?.toolsAllowProvenance,
    toolsAllowExecTarget: params.options?.toolsAllowExecTarget,
  });
  finalizeUpdatedJob({
    job: current,
    nextJob: validated,
    now: params.nowMs,
    schedulingInputsRequested: true,
    scheduleChanged: patch.schedule !== undefined,
    explicitTriggerState: patch.state,
  });
  // Preview the same source-authority decision before touching the watcher;
  // only the service mutation owner consumes commit guards and runtime grants.
  const reauthorize = patch.payload !== undefined && Object.hasOwn(patch.payload, "toolsAllow");
  reconcileCronChannelRequesterAuthority({
    job: validated,
    previousJob: current,
    toolsAllowProvenance: params.options?.toolsAllowProvenance,
    reauthorize,
    reauthorizeCallerOrigin: reauthorize,
    scheduleRetentionIsImplicit: patch.deleteAfterRun === undefined,
  });
  assertCronCallerOriginMutation(current, validated);
  return !(
    validated.enabled &&
    validated.schedule.kind === "stream" &&
    current.schedule.kind === "stream" &&
    cronStreamScheduleKey(validated.schedule) === cronStreamScheduleKey(current.schedule)
  );
}

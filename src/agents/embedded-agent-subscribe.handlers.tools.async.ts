import { isExecToolName } from "./embedded-agent-subscribe.handlers.tools.start.js";
import type { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.handlers.types.js";
import { readAsyncStartedTaskIds } from "./embedded-agent-tool-results.js";
import { readToolResultDetails } from "./tool-result-error.js";

export function recordAsyncToolResult(
  toolMetas: EmbeddedAgentSubscribeState["toolMetas"],
  args: Record<string, unknown>,
  result: unknown,
  isToolError: boolean,
): void {
  const current = toolMetas.at(-1);
  if (current?.asyncStarted) {
    Object.assign(current, readAsyncStartedTaskIds(result));
  }
  if (
    typeof current?.toolName !== "string" ||
    (!isExecToolName(current.toolName) && current.toolName !== "process")
  ) {
    return;
  }
  const details = readToolResultDetails(result);
  if (
    typeof details?.sessionId !== "string" ||
    details.sessionId.length === 0 ||
    typeof details.startedAt !== "number" ||
    !Number.isFinite(details.startedAt)
  ) {
    return;
  }
  const asyncExec = { sessionId: details.sessionId, startedAt: details.startedAt };
  if (current.asyncStarted && details.status === "running") {
    current.asyncExec = asyncExec;
  }
  if (
    current.toolName !== "process" ||
    (args.action !== "poll" && args.action !== "log") ||
    args.sessionId !== asyncExec.sessionId ||
    !((!isToolError && details.status === "completed") || details.status === "failed") ||
    !(
      (typeof details.exitCode === "number" && Number.isFinite(details.exitCode)) ||
      (typeof details.exitSignal === "string" && details.exitSignal.trim().length > 0) ||
      (typeof details.exitSignal === "number" &&
        Number.isFinite(details.exitSignal) &&
        details.exitSignal > 0)
    )
  ) {
    return;
  }
  // Slugs can be reused after retention; only this process generation settles
  // earlier running results. Side-effect and async-start history stay intact.
  for (const entry of toolMetas) {
    if (
      entry.asyncExec?.sessionId === asyncExec.sessionId &&
      entry.asyncExec.startedAt === asyncExec.startedAt
    ) {
      entry.asyncExec.settled = true;
    }
  }
}

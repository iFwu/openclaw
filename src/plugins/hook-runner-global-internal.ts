import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createLiveHookRegistryFacade,
  hookRunnerGlobalState as state,
} from "./hook-runner-global-state.js";
import { createHookRunner, type HookRunner } from "./hooks.js";

/** Create the process runner for an active request scope without widening the Plugin SDK. */
export function ensureGlobalHookRunner(): HookRunner {
  if (!state.hookRunner) {
    state.hookRunner = createHookRunner(createLiveHookRegistryFacade(state), {
      logger: createSubsystemLogger("plugins"),
      catchErrors: true,
      failurePolicyByHook: {
        before_agent_run: "fail-closed",
        before_install: "fail-closed",
        before_tool_call: "fail-closed",
      },
    });
  }
  return state.hookRunner;
}

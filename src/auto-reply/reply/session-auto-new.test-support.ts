import "./session-auto-new.js";
import type { SessionAutoNewDependencies } from "./session-auto-new.js";

type SessionAutoNewTestApi = {
  evaluateJevSessionDependency: (
    params: Parameters<SessionAutoNewDependencies["evaluate"]>[0] & {
      fetchFn?: typeof globalThis.fetch;
    },
  ) => ReturnType<SessionAutoNewDependencies["evaluate"]>;
  testing: {
    setDependencies(overrides?: Partial<SessionAutoNewDependencies>): void;
  };
};

function getTestApi(): SessionAutoNewTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionAutoNewTestApi")
  ];
  if (!api) {
    throw new Error("session auto-new test API is unavailable");
  }
  return api as SessionAutoNewTestApi;
}

export const { evaluateJevSessionDependency, testing } = getTestApi();

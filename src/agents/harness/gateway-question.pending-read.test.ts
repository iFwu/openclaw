import { expect, it } from "vitest";
import {
  hasPendingAgentQuestionForSession,
  registerPendingAgentQuestion,
} from "./gateway-question.js";

it("reads native question presence without claiming or settling its authority", () => {
  const sessionKey = "agent:main:pending-question-read";
  expect(hasPendingAgentQuestionForSession(undefined)).toBe(false);
  expect(hasPendingAgentQuestionForSession(sessionKey)).toBe(false);
  const pending = registerPendingAgentQuestion({
    sessionKey,
    questionId: "read-only",
    questions: [],
  });
  try {
    expect(hasPendingAgentQuestionForSession(` ${sessionKey} `)).toBe(true);
    expect(pending.isResolving()).toBe(false);
    expect(hasPendingAgentQuestionForSession("agent:main:other")).toBe(false);
  } finally {
    pending.dispose();
  }
  expect(hasPendingAgentQuestionForSession(sessionKey)).toBe(false);
});

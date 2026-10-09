import { beforeEach, expect, it, vi } from "vitest";
import { publishUserProfileAliasChange } from "../state/user-profile-events.js";
import {
  bumpGatewayAccessRevision,
  readGatewayAccessRevision,
  readGatewayAccessRevisionState,
} from "./gateway-access-revision.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), isEnabled: vi.fn(() => true) }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));
beforeEach(() => {
  log.debug.mockClear();
  log.isEnabled.mockReturnValue(true);
});

it("records the revision producer without exposing its session or profile subject", () => {
  const before = readGatewayAccessRevisionState();
  const total = readGatewayAccessRevision();
  bumpGatewayAccessRevision({ source: "session-change", subject: "synthetic-private-session" });
  expect(readGatewayAccessRevision()).toBe(total + 1);
  expect(log.debug).toHaveBeenCalledExactlyOnceWith("gateway access revision advanced", {
    source: "session-change",
    previous: before.gateway,
    current: before.gateway + 1,
    profileAlias: before.profileAlias,
    subjectHash: expect.stringMatching(/^[a-f0-9]{16}$/),
  });
  expect(JSON.stringify(log.debug.mock.calls)).not.toContain("synthetic-private-session");
});

it("advances access authority even when producer debug logging is disabled", () => {
  log.isEnabled.mockReturnValue(false);
  const before = readGatewayAccessRevision();
  bumpGatewayAccessRevision({ source: "session-change", subject: "synthetic-private-session" });
  expect(readGatewayAccessRevision()).toBe(before + 1);
  expect(log.debug).not.toHaveBeenCalled();
});

it("attributes profile alias changes to their independent revision owner", () => {
  const before = readGatewayAccessRevisionState();
  const total = readGatewayAccessRevision();
  publishUserProfileAliasChange();
  expect(readGatewayAccessRevision()).toBe(total + 1);
  expect(readGatewayAccessRevisionState()).toEqual({
    ...before,
    profileAlias: before.profileAlias + 1,
  });
  expect(log.debug).toHaveBeenCalledExactlyOnceWith("profile alias access revision advanced", {
    source: "profile-alias",
    previous: before.profileAlias,
    current: before.profileAlias + 1,
  });
});

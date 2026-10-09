import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readUserProfileAliasRevision } from "../state/user-profile-events.js";

let revision = 0;
const log = createSubsystemLogger("gateway/access");

type AccessRevisionChange = {
  source:
    | "session-change"
    | "session-identity"
    | "session-sharing"
    | "operator-role"
    | "unspecified";
  subject?: string;
};

/** Marks Gateway access decisions stale across asynchronously yielded reads. */
export function bumpGatewayAccessRevision(
  change: AccessRevisionChange = { source: "unspecified" },
): void {
  const previous = revision;
  revision += 1;
  if (log.isEnabled("debug")) {
    log.debug("gateway access revision advanced", {
      source: change.source,
      previous,
      current: revision,
      profileAlias: readUserProfileAliasRevision(),
      ...(change.subject
        ? { subjectHash: createHash("sha256").update(change.subject).digest("hex").slice(0, 16) }
        : {}),
    });
  }
}

export function readGatewayAccessRevisionState() {
  return { gateway: revision, profileAlias: readUserProfileAliasRevision() };
}

export function readGatewayAccessRevision(): number {
  // Both owners advance monotonically; alias grants can change a page without changing its caller.
  return revision + readUserProfileAliasRevision();
}

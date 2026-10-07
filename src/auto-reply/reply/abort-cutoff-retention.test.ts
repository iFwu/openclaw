import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSessionPendingInputs,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { MsgContext } from "../templating.js";
import {
  retainAbortCutoffInput,
  prepareCancelledChannelInputTarget,
  stageChannelInputSource,
  retainCancelledUserTurnInput,
} from "./abort-cutoff-retention.js";
import {
  createTypingController,
  runTestInlineActions,
} from "./get-reply-inline-actions.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

describe("durable source retention at an abort cutoff", () => {
  const fixture = useTempSessionsFixture("cutoff-source-retention-");
  const sessionKey = "agent:main:telegram:group:-123:topic:3";
  const entry: SessionEntry = {
    sessionId: "cutoff-source-session",
    updatedAt: 1,
    abortCutoffMessageSid: "10",
    abortCutoffTimestamp: 1000,
  };
  const scope = () => ({
    agentId: "main",
    sessionKey,
    sessionId: entry.sessionId,
    storePath: fixture.storePath(),
  });
  const ctx: MsgContext = {
    RawBody: "original  caption\n  code",
    Provider: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "-123:topic:3",
    AccountId: "default",
    MessageSid: "7",
    MessageThreadId: 3,
    Timestamp: 700,
    media: [{ path: "/tmp/cutoff-source.png", contentType: "image/png", messageId: "7" }],
  };
  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { ...entry });
  });
  const params = () => ({
    ctx,
    cfg: { session: { store: fixture.storePath() } },
    agentId: "main",
    sessionKey,
    storePath: fixture.storePath(),
    entry,
    workspaceDir: fixture.sessionsDir(),
  });

  it("retains original text and media as cancelled before settling a durable source", async () => {
    const adopted = vi.fn(() => {
      const pending = listSessionPendingInputs(scope());
      expect(pending.total).toBe(1);
      expect(pending.items[0]).toMatchObject({
        state: "cancelled",
        message: { role: "user", content: ctx.RawBody },
      });
      expect(readPersistedMediaFacts(pending.items[0]!.message)).toEqual([
        expect.objectContaining({ contentType: "image/png", messageId: "7" }),
      ]);
    });
    const opts = { turnAdoptionLifecycle: { admission: "exclusive" as const, onAdopted: adopted } };
    await retainAbortCutoffInput({ ...params(), opts });
    await retainAbortCutoffInput({ ...params(), opts });
    expect(adopted).toHaveBeenCalledTimes(2);
    expect(listSessionPendingInputs(scope()).total).toBe(1);
  });

  it("routes a stale durable input through the real inline owner without executing a reply", async () => {
    const adopted = vi.fn();
    const typing = createTypingController();
    const inbound = buildTestCtx({
      ...ctx,
      Body: ctx.RawBody,
      CommandBody: ctx.RawBody,
      CommandAuthorized: true,
      SessionKey: sessionKey,
    });
    const result = await runTestInlineActions({
      ctx: inbound,
      typing,
      cleanedBody: ctx.RawBody ?? "",
      command: {
        surface: "telegram",
        channel: "telegram",
        channelId: "telegram",
        isAuthorizedSender: true,
      },
      overrides: {
        cfg: params().cfg,
        agentId: "main",
        sessionKey,
        sessionEntry: entry,
        sessionStore: { [sessionKey]: entry },
        storePath: fixture.storePath(),
        workspaceDir: fixture.sessionsDir(),
        opts: { turnAdoptionLifecycle: { admission: "exclusive", onAdopted: adopted } },
      },
    });
    expect(result).toEqual({ kind: "reply", reply: undefined });
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(adopted).toHaveBeenCalledOnce();
    expect(listSessionPendingInputs(scope()).items).toMatchObject([
      { state: "cancelled", message: { content: ctx.RawBody } },
    ]);
  });

  it("retains an authorized pre-buffer source through its captured native store without executing it", async () => {
    const retain = prepareCancelledChannelInputTarget({
      target: { ...scope(), sessionEntry: entry, config: params().cfg },
      assertCurrent: () => {},
    });
    const input = {
      text: "untouched raw source",
      idempotencyKey: "original-source:user",
      timestamp: 700,
      media: [{ url: "telegram:file/original-ref", kind: "image", hydrationSuppressed: true }],
    };
    await retain(input);
    await retain(input);
    expect(listSessionPendingInputs(scope()).total).toBe(1);
    expect(listSessionPendingInputs(scope()).items).toMatchObject([
      { state: "cancelled", message: { content: input.text } },
    ]);
    await expect(retain({ ...input, text: "replacement text" })).rejects.toThrow(
      "original source bytes",
    );
  });

  it("does not retain or settle an input against a replacement session", async () => {
    await upsertSessionEntryCore(scope(), { ...entry, sessionId: "replacement-session" });
    const adopted = vi.fn();
    await expect(
      retainAbortCutoffInput({
        ...params(),
        opts: { turnAdoptionLifecycle: { admission: "exclusive", onAdopted: adopted } },
      }),
    ).rejects.toThrow("captured cutoff");
    expect(adopted).not.toHaveBeenCalled();
    expect(listSessionPendingInputs({ ...scope(), sessionId: "replacement-session" }).total).toBe(
      0,
    );
  });

  it("does not settle a source when its original target was revoked", async () => {
    const adopted = vi.fn();
    await expect(
      retainAbortCutoffInput({
        ...params(),
        opts: {
          isCommandTargetCurrent: () => false,
          turnAdoptionLifecycle: { admission: "exclusive", onAdopted: adopted },
        },
      }),
    ).rejects.toThrow("target changed");
    expect(adopted).not.toHaveBeenCalled();
    expect(listSessionPendingInputs(scope()).total).toBe(0);
  });
  it("stages raw original media before hydration and consumes it through one normal aggregate", async () => {
    const source = await stageChannelInputSource({
      input: {
        text: "original caption",
        idempotencyKey: "early-source:user",
        media: [{ url: "telegram:file/stable-ref", kind: "image", hydrationSuppressed: true }],
      },
      target: { ...scope(), sessionEntry: entry, config: params().cfg },
      assertCurrent: () => {},
      assertAdmittedCurrent: () => {},
      assertRetainedCurrent: () => {},
    });
    expect(source).toBeDefined();
    expect(listSessionPendingInputs(scope()).items).toMatchObject([
      { state: "queued", message: { content: "original caption" } },
    ]);
    const aggregate = createUserTurnTranscriptRecorder({
      input: {
        text: "collected original caption",
        idempotencyKey: "early-aggregate:user",
        media: [{ path: "/tmp/hydrated-a.png", kind: "image" }],
      },
      target: { ...scope(), sessionEntry: entry, config: params().cfg },
      pendingInputSources: [source!],
    });
    expect(await aggregate.stageApproved?.({ runId: "aggregate", assertCurrent: () => {} })).toBe(
      true,
    );
    expect(listSessionPendingInputs(scope()).total).toBe(1);
    expect((await aggregate.persistApproved())?.appended).toBe(true);
    expect(listSessionPendingInputs(scope()).total).toBe(0);
    expect(source!.isPendingInputConsumed?.()).toBe(true);
    aggregate.finishPendingInput?.("interrupted");
  });

  it("reuses stable cancelled source bytes after failed dedupe without hydrating a new original", async () => {
    const input = {
      text: "stable caption",
      idempotencyKey: "hydration-retry:user",
      timestamp: 700,
      media: [{ url: "telegram:file/stable-ref", kind: "image", hydrationSuppressed: true }],
    };
    const stage = (value = input) =>
      stageChannelInputSource({
        input: value,
        target: { ...scope(), sessionEntry: entry, config: params().cfg },
        assertCurrent: () => {},
        assertAdmittedCurrent: () => {},
        assertRetainedCurrent: () => {},
      });
    const source = await stage();
    expect(retainCancelledUserTurnInput(source)).toBe(true);
    expect(await stage()).toBeUndefined();
    expect(listSessionPendingInputs(scope()).total).toBe(1);
    await expect(stage({ ...input, text: "changed caption" })).rejects.toThrow(
      "original source bytes",
    );
    await expect(
      stage({ ...input, media: [{ ...input.media[0]!, url: "telegram:file/different-ref" }] }),
    ).rejects.toThrow("original source bytes");
  });

  it("rejects revoked storage authority before cancelling an early original receipt", async () => {
    let current = true;
    const source = await stageChannelInputSource({
      input: { text: "original", idempotencyKey: "revoked-early:user" },
      target: { ...scope(), sessionEntry: entry, config: params().cfg },
      assertCurrent: () => {},
      assertAdmittedCurrent: () => {},
      assertRetainedCurrent: () => {
        if (!current) {
          throw new Error("revoked storage authority");
        }
      },
    });
    const aggregate = createUserTurnTranscriptRecorder({
      input: { text: "collected original", idempotencyKey: "revoked-aggregate:user" },
      target: { ...scope(), sessionEntry: entry, config: params().cfg },
      pendingInputSources: [source!],
    });
    await aggregate.resolveMessage();
    current = false;
    expect(() => retainCancelledUserTurnInput(aggregate)).toThrow(
      "Failed to retain cancelled input sources",
    );
    let rejection: unknown;
    try {
      retainCancelledUserTurnInput(source);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "revoked storage authority" }),
    ]);
    expect(listSessionPendingInputs(scope()).items).toMatchObject([{ state: "queued" }]);
    source?.finishPendingInput?.("interrupted");
  });
});

import type { Message } from "grammy/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareTelegramInputSource,
  readTelegramInputSource,
} from "./bot-handlers.input-source.js";
import type { TelegramSessionState } from "./bot-handlers.message-context.js";

const { retainInput, stageInput, getEntry, recorder } = vi.hoisted(() => ({
  retainInput: vi.fn(),
  stageInput: vi.fn(),
  getEntry: vi.fn(),
  recorder: { resolveMessage: async () => undefined, message: undefined },
}));
vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  stageChannelInputSource: (...args: unknown[]) => stageInput(...args),
  retainCancelledChannelInputSource: (...args: unknown[]) => retainInput(...args),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: (...args: unknown[]) => getEntry(...args),
}));

const message = (id = 7): Message => ({
  message_id: id,
  date: 10,
  chat: { id: -123, type: "supergroup", title: "source" },
  from: { id: 42, is_bot: false, first_name: "source" },
  message_thread_id: 3,
  caption: "  original caption\ncode",
  photo: [{ file_id: "photo-ref", file_unique_id: "photo-ref", width: 1, height: 1 }],
});
const state = (): TelegramSessionState => ({
  agentId: "main",
  sessionKey: "agent:main:telegram:group:-123:topic:3",
  storePath: "/tmp/test-store",
  sessionEntry: { sessionId: "original-session", updatedAt: 1 },
  bindingMode: { kind: "none" },
  model: undefined,
});

beforeEach(() => {
  retainInput.mockReset().mockResolvedValue(true);
  stageInput.mockReset().mockResolvedValue(recorder);
  getEntry.mockReset().mockReturnValue(state().sessionEntry);
});
describe("Telegram original source retention", () => {
  it("retains immutable caption and unresolved original media before terminal source settlement", async () => {
    const msg = message();
    const current = state();
    const terminal = vi.fn(async () => {
      expect(retainInput).toHaveBeenCalledOnce();
    });
    await prepareTelegramInputSource({
      msg,
      cfg: {},
      accountId: "default",
      state: current,
      resolveState: async () => current,
      assertOwnerCurrent: () => {},
      onRetained: terminal,
    });
    expect(stageInput).toHaveBeenCalledOnce();
    expect(retainInput).not.toHaveBeenCalled();
    msg.caption = "synthetic replacement";
    const source = readTelegramInputSource(msg)!;
    await Promise.all([source.retain(), source.retain()]);
    expect(stageInput).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        input: expect.objectContaining({
          text: "  original caption\ncode",
          media: [
            expect.objectContaining({
              url: "telegram:file/photo-ref",
              hydrationSuppressed: true,
              messageId: "7",
            }),
          ],
        }),
      }),
    );
    expect(terminal).toHaveBeenCalledOnce();
    expect(await source.resolveDisposition()).toBe("retained");
  });

  it("partitions older stopped and newer executing original messages before assembly", async () => {
    const captured = state();
    const current = {
      ...captured,
      sessionEntry: { ...captured.sessionEntry!, abortCutoffMessageSid: "8" },
    };
    const old = message(7);
    const fresh = message(9);
    const terminal = vi.fn().mockResolvedValue(undefined);
    for (const msg of [old, fresh]) {
      await prepareTelegramInputSource({
        msg,
        cfg: {},
        accountId: "default",
        state: captured,
        resolveState: async () => current,
        assertOwnerCurrent: () => {},
        onRetained: terminal,
      });
    }
    expect(await readTelegramInputSource(old)!.resolveDisposition()).toBe("retained");
    expect(await readTelegramInputSource(fresh)!.resolveDisposition()).toBe("execution");
    expect(terminal).toHaveBeenCalledOnce();
    expect(retainInput).toHaveBeenCalledOnce();
  });

  it("keeps a failed native cancellation retryable and never settles its ingress source", async () => {
    retainInput.mockRejectedValueOnce(new Error("retention write failed"));
    const msg = message();
    const current = state();
    const terminal = vi.fn().mockResolvedValue(undefined);
    await prepareTelegramInputSource({
      msg,
      cfg: {},
      accountId: "default",
      state: current,
      resolveState: async () => current,
      assertOwnerCurrent: () => {},
      onRetained: terminal,
    });
    const source = readTelegramInputSource(msg)!;
    await expect(source.retain()).rejects.toThrow("retention write failed");
    expect(terminal).not.toHaveBeenCalled();
    await source.retain();
    expect(terminal).toHaveBeenCalledOnce();
  });

  it("does not transfer a retained source to a new route or session incarnation", async () => {
    const msg = message();
    const captured = state();
    const terminal = vi.fn().mockResolvedValue(undefined);
    await prepareTelegramInputSource({
      msg,
      cfg: {},
      accountId: "default",
      state: captured,
      resolveState: async () => ({ ...captured, sessionKey: "agent:main:replacement" }),
      assertOwnerCurrent: () => {},
      onRetained: terminal,
    });
    await expect(readTelegramInputSource(msg)!.retain()).rejects.toThrow("route changed");
    expect(retainInput).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  });
  it("settles an already retained original without creating another execution receipt", async () => {
    stageInput.mockResolvedValue(undefined);
    const msg = message();
    const current = state();
    const terminal = vi.fn().mockResolvedValue(undefined);
    await prepareTelegramInputSource({
      msg,
      cfg: {},
      accountId: "default",
      state: current,
      resolveState: async () => current,
      assertOwnerCurrent: () => {},
      onRetained: terminal,
    });
    expect(await readTelegramInputSource(msg)!.resolveDisposition()).toBe("retained");
    expect(terminal).toHaveBeenCalledOnce();
    expect(retainInput).not.toHaveBeenCalled();
  });
});

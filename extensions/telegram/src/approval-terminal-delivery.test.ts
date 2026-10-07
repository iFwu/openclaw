import { describe, expect, it, vi } from "vitest";
import { deliverGuardTerminal } from "./approval-terminal-delivery.js";
describe("guard terminal delivery", () => {
  it("edits once across concurrent event/callback and sends no companion receipt", async () => {
    const edit = vi.fn(async () => {}),
      fallback = vi.fn(async () => {});
    await Promise.all([1, 2, 3].map(() => deliverGuardTerminal({ key: "same", edit, fallback })));
    expect(edit).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });
  it("sends exactly one fallback on confirmed missing card", async () => {
    const edit = vi.fn(async () => {
      throw new Error("400: Bad Request: message to edit not found");
    });
    const fallback = vi.fn(async () => {});
    await Promise.all([1, 2].map(() => deliverGuardTerminal({ key: "missing", edit, fallback })));
    expect(fallback).toHaveBeenCalledTimes(1);
  });
  it("does not duplicate an unknown edit/send outcome or swallow its error", async () => {
    const edit = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    });
    const fallback = vi.fn(async () => {});
    await expect(deliverGuardTerminal({ key: "timeout", edit, fallback })).rejects.toThrow(
      "ETIMEDOUT",
    );
    await expect(deliverGuardTerminal({ key: "timeout", edit, fallback })).rejects.toThrow(
      "ETIMEDOUT",
    );
    expect(edit).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });
  it("not modified is already delivered", async () => {
    const fallback = vi.fn(async () => {});
    await deliverGuardTerminal({
      key: "unchanged",
      edit: async () => {
        throw new Error("400: Bad Request: message is not modified");
      },
      fallback,
    });
    expect(fallback).not.toHaveBeenCalled();
  });
});

import { Socket } from "node:net";
import { expect, vi } from "vitest";

/** Pure SDK transport fixtures must never connect or fetch, including mock leaks. */
export function forbidResponsesTestNetwork() {
  const connect = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Unexpected network connection in isolated Responses fixture");
  });
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected fetch in isolated Responses fixture"));
  return () => {
    try {
      expect(connect).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      fetch.mockRestore();
    }
  };
}

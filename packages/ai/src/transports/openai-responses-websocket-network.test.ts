import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { forbidResponsesTestNetwork } from "./openai-responses-websocket-network.test-support.js";

describe("Responses fixture network boundary", () => {
  it("blocks connect synchronously and records an unexpected attempt", () => {
    const verify = forbidResponsesTestNetwork();
    const socket = new Socket();
    try {
      expect(() => socket.connect({ host: "127.0.0.1", port: 1 })).toThrow(
        "Unexpected network connection",
      );
    } finally {
      socket.destroy();
      expect(verify).toThrow();
    }
  });

  it("blocks fetch and records an unexpected attempt", async () => {
    const verify = forbidResponsesTestNetwork();
    try {
      await expect(fetch("http://127.0.0.1:1/")).rejects.toThrow("Unexpected fetch");
    } finally {
      expect(verify).toThrow();
    }
  });

  it("accepts a fixture that makes no network attempt", () => {
    const verify = forbidResponsesTestNetwork();
    expect(verify).not.toThrow();
  });
});

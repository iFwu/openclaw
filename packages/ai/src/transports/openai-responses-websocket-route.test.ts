import OpenAI from "openai";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { forbidResponsesTestNetwork } from "./openai-responses-websocket-network.test-support.js";
import { prepareWebSocketConnection } from "./openai-responses-websocket-route.js";

const initialHost = getAiTransportHost();
let verifyNoNetwork: (() => void) | undefined;
beforeEach(() => {
  verifyNoNetwork = forbidResponsesTestNetwork();
});
afterEach(() => {
  configureAiTransportHost(initialHost);
  verifyNoNetwork?.();
});

describe("Responses WebSocket final credential identity", () => {
  it("keeps actual SDK Authorization and socket identity together across account switches", () => {
    const prepare = (authorization: string) =>
      prepareWebSocketConnection(
        new OpenAI({
          apiKey: "synthetic-proxy-placeholder",
          defaultHeaders: { Authorization: authorization },
        }),
        { Authorization: authorization, "x-stable": "same" },
      );
    const a = prepare("Bearer synthetic-account-a");
    const b = prepare("Bearer synthetic-account-b");
    const again = prepare("Bearer synthetic-account-a");
    expect(
      // Verify the installed SDK handshake policy, not a replacement mock.
      // eslint-disable-next-line no-underscore-dangle
      a.client._buildWebSocketHeaders({ Authorization: "Bearer synthetic-proxy-placeholder" })
        .authorization,
    ).toBe("Bearer synthetic-account-a");
    expect(
      // eslint-disable-next-line no-underscore-dangle
      b.client._buildWebSocketHeaders({ Authorization: "Bearer synthetic-proxy-placeholder" })
        .authorization,
    ).toBe("Bearer synthetic-account-b");
    expect(a.identity).not.toBe(b.identity);
    expect(a.identity).toBe(again.identity);
  });

  it("resolves a SDK default Authorization sentinel before the actual handshake", () => {
    configureAiTransportHost({
      ...initialHost,
      resolveSecretSentinel: (value) =>
        value.replace("synthetic-protected-value", "synthetic-resolved-value"),
    });
    const prepared = prepareWebSocketConnection(
      new OpenAI({
        apiKey: "synthetic-placeholder",
        defaultHeaders: { authorization: "Bearer synthetic-protected-value" },
      }),
      {},
    );
    // eslint-disable-next-line no-underscore-dangle
    const headers = prepared.client._buildWebSocketHeaders({
      Authorization: "Bearer synthetic-placeholder",
    });
    expect(headers.authorization).toBe("Bearer synthetic-resolved-value");
    expect(JSON.stringify(headers)).not.toContain("synthetic-protected-value");
  });
});

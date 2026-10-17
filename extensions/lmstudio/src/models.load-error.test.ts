import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { ensureLmstudioModelLoaded } from "./models.fetch.js";

describe("LM Studio model-load error transport", () => {
  it.each([
    { timeoutMs: undefined, loaded: true },
    { timeoutMs: 30_000, loaded: false },
  ])(
    "allows a slow cold load without overriding an explicit timeout ($loaded)",
    async (testCase) => {
      const timeoutError = new DOMException("Model load timed out", "TimeoutError");
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(timeoutError), delay);
        return controller.signal;
      });
      const modelKey = "qwen3-8b-instruct";
      const fetchImpl: typeof fetch = async (_url, init) => {
        if (init?.method !== "POST") {
          return Response.json({ models: [{ type: "llm", key: modelKey, loaded_instances: [] }] });
        }
        await new Promise<void>((resolve, reject) => {
          const signal = init.signal;
          const onAbort = () => {
            clearTimeout(timer);
            reject(timeoutError);
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, 45_000);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        return Response.json({ status: "loaded", instance_id: "cold-load-instance" });
      };
      try {
        const result = ensureLmstudioModelLoaded({
          baseUrl: "http://slow-model.localhost:1234/v1",
          modelKey,
          timeoutMs: testCase.timeoutMs,
          fetchImpl,
        }).then(
          (key) => ({ loaded: true, key }),
          () => ({ loaded: false, key: undefined }),
        );
        await vi.advanceTimersByTimeAsync(45_000);
        expect(await result).toEqual({
          loaded: testCase.loaded,
          key: testCase.loaded ? modelKey : undefined,
        });
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    },
  );

  it("redacts actual outbound credentials reflected by a model-load HTTP server", async () => {
    let responseStatus = 502;
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            models: [{ type: "llm", key: "qwen3-8b-instruct", loaded_instances: [] }],
          }),
        );
        return;
      }
      const authorization = request.headers.authorization;
      const proxyAuthorization = request.headers["x-proxy-auth"];
      if (typeof authorization !== "string" || typeof proxyAuthorization !== "string") {
        response.writeHead(500);
        response.end("missing expected authentication headers");
        return;
      }
      const reflected = `upstream rejected ${authorization}; proxy ${proxyAuthorization}`;
      response.writeHead(responseStatus, { "Content-Type": "application/json" });
      response.end(responseStatus === 200 ? JSON.stringify({ status: reflected }) : reflected);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("LM Studio test server did not bind to a local port");
      }
      for (const [status, expected] of [
        [502, "LM Studio model load failed (502): upstream rejected ***; proxy ***"],
        [200, "LM Studio model load returned unexpected status: upstream rejected ***; proxy ***"],
      ] as const) {
        responseStatus = status;
        await expect(
          ensureLmstudioModelLoaded({
            baseUrl: `http://127.0.0.1:${address.port}`,
            modelKey: "qwen3-8b-instruct",
            apiKey: "sk-test",
            headers: { "X-Proxy-Auth": "opaque-short" },
          }),
        ).rejects.toThrow(expected);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

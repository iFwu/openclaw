import { describe, expect, it } from "vitest";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { markPluginRegistryActive } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

describe("plugin local-service acquisition", () => {
  it("preserves the host receiver and plugin scope through async acquisition", async () => {
    const observations: Array<{ receiver: PluginRuntime["llm"]; pluginId: string | undefined }> =
      [];
    const runtime = createPluginRuntimeMock();
    runtime.llm.acquireLocalService = async function (this: PluginRuntime["llm"]) {
      await Promise.resolve();
      observations.push({
        receiver: this,
        pluginId: getPluginRuntimeGatewayRequestScope()?.pluginId,
      });
      return undefined;
    };
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime,
      activateGlobalSideEffects: false,
    });
    const firstRecord = createPluginRecord({ id: "first", origin: "bundled" });
    const secondRecord = createPluginRecord({ id: "second", origin: "bundled" });
    builder.registry.plugins.push(firstRecord, secondRecord);
    markPluginRegistryActive(builder.registry);
    const first = builder.createApi(firstRecord, { config: {} });
    const second = builder.createApi(secondRecord, { config: {} });
    expect(first.runtime.llm.acquireLocalService).toBe(first.runtime.llm.acquireLocalService);
    expect(second.runtime.llm.acquireLocalService).toBe(second.runtime.llm.acquireLocalService);
    expect(first.runtime.llm.acquireLocalService).not.toBe(second.runtime.llm.acquireLocalService);
    const target = { providerId: "fixture", baseUrl: "http://127.0.0.1:1234" };

    await Promise.all([
      first.runtime.llm.acquireLocalService(target),
      second.runtime.llm.acquireLocalService(target),
    ]);

    for (const observation of observations) {
      expect(observation.receiver).toBe(runtime.llm);
    }
    expect(
      observations
        .map((entry) => entry.pluginId)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["first", "second"]);
  });
});

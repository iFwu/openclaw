import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { runWithOperatorToolGatewayAuthority } from "./operator-tool-gateway-authority.js";
import type { OperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.types.js";
import {
  createSyntheticPluginRuntimeClient,
  mergePluginRuntimeClientInternal,
} from "./server-plugin-runtime-client.js";

/** Retains operator attribution and authority only for the awaited tool invocation. */
export async function withOperatorToolGatewayAuthority<T>(
  authority: Omit<OperatorToolGatewayAuthority, "signal">,
  run: () => Promise<T>,
): Promise<T> {
  const lifetime = new AbortController();
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context;
  const captured =
    context && (authority.operatorRunAuthority || authority.operatorRoleActor?.kind !== "system")
      ? await captureGatewayOperatorRunAuthority({
          client:
            scope?.client && !authority.operatorRunAuthority
              ? scope.client
              : createSyntheticPluginRuntimeClient({
                  authenticatedUserProfile: authority.authenticatedUserProfile,
                  operatorRoleActor: authority.operatorRoleActor,
                  operatorRunAuthority: authority.operatorRunAuthority,
                  scopes: [...authority.scopes],
                }),
          context,
          hasCurrentClientAuthority: scope?.hasCurrentClientAuthority,
        })
      : undefined;
  try {
    authority.assertCurrent?.();
    captured?.authority.assertCurrent();
    return await runWithOperatorToolGatewayAuthority(
      {
        ...authority,
        operatorRunAuthority: captured?.authority ?? authority.operatorRunAuthority,
        signal: lifetime.signal,
      },
      () =>
        captured && scope?.client
          ? withPluginRuntimeGatewayRequestScope(
              {
                ...scope,
                client: mergePluginRuntimeClientInternal(scope.client, {
                  operatorRunAuthority: captured.authority,
                }),
              },
              run,
            )
          : run(),
    );
  } finally {
    lifetime.abort(new Error("operator tool invocation authority expired"));
    captured?.release();
  }
}

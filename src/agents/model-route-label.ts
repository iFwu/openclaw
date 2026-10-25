import { stripSelfProviderModelPrefix } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { type ModelRef, modelKey } from "./model-ref-shared.js";

/** Keep discovery and activation labels aligned without widening the public Plugin SDK. */
export function resolveConfiguredRouteModelLabel(params: {
  configuredRef: string | undefined;
  resolved: ModelRef;
  profileId?: string;
}): string {
  const configuredRef = params.configuredRef?.trim();
  const configuredModel =
    configuredRef && params.profileId && configuredRef.endsWith(`@${params.profileId}`)
      ? configuredRef.slice(0, configuredRef.length - params.profileId.length - 1)
      : (configuredRef ?? "");
  const strippedConfiguredModel = stripSelfProviderModelPrefix(
    params.resolved.provider,
    configuredModel,
  );
  const model =
    configuredModel && strippedConfiguredModel === params.resolved.model
      ? configuredModel
      : params.resolved.model;
  return modelKey(params.resolved.provider, model);
}

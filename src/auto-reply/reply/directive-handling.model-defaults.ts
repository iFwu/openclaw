import {
  persistStickyModelSelectionBestEffort,
  type StickyModelSelectionDispatchOutcome,
} from "../../agents/sticky-model-selection.js";
import type { ModelOverrideSelection } from "../../sessions/model-overrides.js";
import { rememberTelegramDmModelSelection } from "../../sessions/telegram-dm-model-selection.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import { canPersistSessionDirectiveDefaults } from "./directive-handling.shared.js";

export async function persistDirectiveModelDefaults(
  params: HandleDirectiveOnlyParams & {
    agentId: string;
    modelSelection?: ModelOverrideSelection;
    validateSelection: () => string | undefined;
  },
): Promise<{
  errorText?: string;
  configuredDefaultUpdate?: StickyModelSelectionDispatchOutcome;
  dmTopicDefaultUpdated?: boolean;
}> {
  const selection = params.modelSelection;
  if (!selection) {
    return {};
  }
  const errorText = params.validateSelection();
  if (errorText) {
    return { errorText };
  }
  const dmTopicDefaultUpdated =
    params.directives.modelScope !== "session" &&
    canPersistSessionDirectiveDefaults(params) &&
    (await rememberTelegramDmModelSelection({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      sessionStore: params.sessionStore,
      selection,
      assertCurrent: () => {
        const error = params.validateSelection();
        if (error) {
          throw new Error(error);
        }
      },
    }));
  const currentError = params.validateSelection();
  if (currentError) {
    return { errorText: currentError, dmTopicDefaultUpdated };
  }
  const configuredDefaultUpdate =
    params.canPersistStickyModelSelection === true && params.stickyModelSelectionTarget
      ? persistStickyModelSelectionBestEffort({
          agentId: params.agentId,
          model: `${selection.provider}/${selection.model}`,
          target: params.stickyModelSelectionTarget,
        })
      : undefined;
  return { configuredDefaultUpdate, dmTopicDefaultUpdated };
}

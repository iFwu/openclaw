import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { generateConversationLabel } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { getTelegramRuntime } from "./runtime.js";
export { resolveAutoTopicLabelConfig } from "./auto-topic-label-config.js";

const activeLabels = resolveGlobalSingleton(
  Symbol.for("openclaw.telegramActiveTopicLabels"),
  () => new Set<string>(),
);

function pendingLabels() {
  return getTelegramRuntime().state.openKeyedStore<string>({
    namespace: "telegram.pending-topic-labels",
    maxEntries: 2048,
  });
}

async function bindPendingLabel(
  key: string,
  previous: string | undefined,
  generation: string,
): Promise<boolean> {
  if (previous === generation) return true;
  const store = pendingLabels();
  if (previous === undefined) {
    return (
      (await store.registerIfAbsent(key, generation)) || (await store.lookup(key)) === generation
    );
  }
  if (!store.observe || !store.compareAndApply)
    throw new Error("Topic labels require atomic generation binding.");
  const observed = await store.observe(key);
  if (observed.value !== previous) return observed.value === generation;
  const result = await store.compareAndApply(key, observed.comparison, {
    operation: "update",
    action: "set",
    value: generation,
  });
  return result.status !== "conflict" || result.current.value === generation;
}

export async function prepareTelegramTopicLabel(params: {
  key: string;
  sessionId?: string;
  firstTurn: boolean;
  userMessage: string;
}): Promise<boolean> {
  const store = pendingLabels();
  const generation = params.sessionId ?? "";
  const pending = await store.lookup(params.key);
  if (!params.firstTurn && pending !== generation && pending !== "") return false;
  if (!(await bindPendingLabel(params.key, pending, generation))) return false;
  const text = params.userMessage.trim();
  return Boolean(text && !text.startsWith("/"));
}

/** Settle only a successful label; failed or replaced turns retain no naming authority. */
export async function runTelegramTopicLabelOnce(params: {
  key: string;
  sessionId?: string;
  isCurrent: () => boolean;
  run: () => Promise<boolean>;
}): Promise<void> {
  const generation = params.sessionId ?? "";
  const identity = JSON.stringify([params.key, generation]);
  if (activeLabels.has(identity) || !params.isCurrent()) return;
  activeLabels.add(identity);
  try {
    const store = pendingLabels();
    if (!store.deleteIfEqual)
      throw new Error("Topic labels require atomic pending-state settlement.");
    const pending = await store.lookup(params.key);
    if (
      pending !== generation &&
      (pending !== "" || !(await bindPendingLabel(params.key, pending, generation)))
    )
      return;
    if (params.isCurrent() && (await params.run())) {
      await store.deleteIfEqual(params.key, generation);
    }
  } finally {
    activeLabels.delete(identity);
  }
}

export async function generateTelegramTopicLabel(params: {
  userMessage: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
}): Promise<string | null> {
  return await generateConversationLabel({
    ...params,
    maxLength: 128,
  });
}

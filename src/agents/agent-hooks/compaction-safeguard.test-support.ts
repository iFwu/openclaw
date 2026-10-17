import type { Model } from "openclaw/plugin-sdk/llm";
import type { summarizeInStages } from "../compaction.js";
import "./compaction-safeguard.js";

type CompactionSafeguardTestApi = {
  setSummarizeInStagesForTest(next?: typeof summarizeInStages): void;
  collectToolFailures: CallableFunction;
  formatToolFailuresSection: CallableFunction;
  splitPreservedRecentTurns: CallableFunction;
  buildPreservedTurnsSection: CallableFunction;
  buildCompactionStructureInstructions: CallableFunction;
  buildStructuredFallbackSummary: CallableFunction;
  prependPreviousSummaryForRedistill: CallableFunction;
  appendSummarySection: CallableFunction;
  resolveRecentTurnsPreserve: CallableFunction;
  resolveQualityGuardMaxRetries: CallableFunction;
  extractOpaqueIdentifiers: CallableFunction;
  auditSummaryQuality: CallableFunction;
  capCompactionSummary: CallableFunction;
  budgetCompactionSummary: CallableFunction;
  formatFileOperations: CallableFunction;
  computeAdaptiveChunkRatio: CallableFunction;
  readWorkspaceContextForSummary: CallableFunction;
  BASE_CHUNK_RATIO: number;
  MIN_CHUNK_RATIO: number;
  SAFETY_MARGIN: number;
  MAX_COMPACTION_SUMMARY_CHARS: number;
  MAX_FILE_OPS_SECTION_CHARS: number;
  MAX_FILE_OPS_LIST_CHARS: number;
  SUMMARY_TRUNCATED_MARKER: string;
  CONTEXT_TRUNCATED_MARKER: string;
  MAX_SPLIT_TURN_CONTEXT_CHARS: number;
};

function getTestApi(): CompactionSafeguardTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.compactionSafeguardTestApi")
  ];
  if (!api) {
    throw new Error("compaction safeguard test API is unavailable");
  }
  return api as CompactionSafeguardTestApi;
}

export const testing = getTestApi();

export function createAnthropicModelFixture(overrides: Partial<Model> = {}): Model {
  return {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    api: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

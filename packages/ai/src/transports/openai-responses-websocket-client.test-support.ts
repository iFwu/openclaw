import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { WebSocketError } from "openai/resources/responses/internal-base.js";
import { getAiTransportHost } from "../host.js";
import {
  responsesPromptObserver,
  type ResponsesPromptObservation,
} from "./openai-responses-contracts.js";
import {
  withProviderAcceptanceObserver,
  type ProviderAcceptance,
} from "./transport-stream-shared.js";

export type StreamMessage =
  | { type: "open" }
  | { type: "error"; error: Error }
  | { type: "close"; code: number }
  | { type: "delay"; ms: number }
  | { type: "message"; message: Record<string, unknown> };
export type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

export const initialHost = getAiTransportHost();
export const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

export function userMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: text, timestamp };
}

export function completedEvent(
  responseId: string,
  content?: string | Array<Record<string, unknown>>,
) {
  const output =
    typeof content === "string"
      ? [
          {
            id: `msg_${responseId}`,
            type: "message",
            status: "completed",
            content: [
              {
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.test/source",
                    title: "source",
                    start_index: 0,
                    end_index: content.length,
                  },
                ],
                logprobs: [{ token: content, logprob: -0.1, bytes: [], top_logprobs: [] }],
                text: content,
                type: "output_text",
              },
            ],
            role: "assistant",
            phase: "final_answer",
          },
        ]
      : (content ?? []);
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output,
      usage: {
        input_tokens: 5,
        output_tokens: output.length > 0 ? 3 : 0,
        total_tokens: output.length > 0 ? 8 : 5,
      },
    },
  };
}

export function message(event: Record<string, unknown>): StreamMessage {
  return { type: "message", message: event };
}

export function wrappedSdkServerError(params: {
  code: string;
  message: string;
  param?: string;
  status: number;
}): WebSocketError {
  const event = {
    type: "error",
    error: {
      type: "invalid_request_error",
      code: params.code,
      message: params.message,
      param: params.param ?? null,
    },
    status: params.status,
  };
  return new WebSocketError(JSON.stringify(event), event as never);
}

export function toolCallResponse(responseId: string): StreamMessage[] {
  const functionCall = {
    type: "function_call",
    id: "fc_read",
    call_id: "call_read",
    name: "read",
    arguments: '{"path":"README.md"}',
    status: "completed",
  };
  return [
    message({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...functionCall, arguments: "", status: "in_progress" },
    }),
    message({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fc_read",
      delta: '{"path":"README.md"}',
    }),
    message({
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: "fc_read",
      name: "read",
      arguments: '{"path":"README.md"}',
    }),
    message({
      type: "response.output_item.done",
      output_index: 0,
      item: functionCall,
    }),
    message(completedEvent(responseId, [functionCall])),
  ];
}

export function sdkCompletion(responseId: string): SdkResponse {
  return sdkEvent(completedEvent(responseId));
}

export function sdkEvent(event: Record<string, unknown>): SdkResponse {
  return {
    data: (async function* () {
      yield event;
    })(),
    response: new Response(null, { status: 200 }),
  };
}

export async function run(
  context: Context,
  overrides: {
    model?: Model<"openai-responses">;
    transport?: "sse" | "websocket" | "websocket-cached" | "auto";
    sessionId?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onPayload?: (payload: unknown) => Promise<unknown>;
    headers?: Record<string, string>;
    cacheRetention?: "none" | "short";
    observations?: ResponsesPromptObservation[];
    onCompactionRejected?: () => void;
    acceptanceObserver?: (acceptance: ProviderAcceptance) => void;
    onActiveResponse?: () => void;
  } = {},
): Promise<AssistantMessage> {
  const options = {
    apiKey: "test-key",
    sessionId: overrides.sessionId ?? "session-1",
    transport: overrides.transport ?? "websocket-cached",
    reasoningEffort: "low",
    timeoutMs: overrides.timeoutMs,
    signal: overrides.signal,
    onPayload: overrides.onPayload,
    headers: overrides.headers,
    cacheRetention: overrides.cacheRetention,
    onCompactionRejected: overrides.onCompactionRejected,
    onActiveResponse: overrides.onActiveResponse,
  };
  if (overrides.acceptanceObserver) {
    withProviderAcceptanceObserver(options, overrides.acceptanceObserver);
  }
  if (overrides.observations) {
    responsesPromptObserver.set(options, (observation) =>
      overrides.observations?.push(observation),
    );
  }
  const stream = await createOpenAIResponsesTransportStreamFn()(
    overrides.model ?? model,
    context,
    options as never,
  );
  return stream.result();
}

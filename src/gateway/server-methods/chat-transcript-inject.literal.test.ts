import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { AssistantMessage } from "../../llm/types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";

const literal = "Literal [[reply_to:other]] [[audio_as_voice]] [[tts:text]]say this[[/tts:text]]";

describe("prepared literal transcript injection", () => {
  it.each(["literal", "explicit", "mixed"] as const)(
    "preserves interpreted blocks and admitted facts through native persistence (%s)",
    async (mode) => {
      await withOpenClawTestState({ label: "prepared-literal-inject" }, async (state) => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:literal",
          sessionId: "literal-session",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const content = [
          {
            type: "text",
            text: literal,
            textInterpretation: "literal",
            textSignature: "authored-literal",
          },
          ...(mode === "mixed"
            ? [
                {
                  type: "text",
                  text: "[[reply_to_current]]Raw answer.",
                  textSignature: "raw-answer",
                },
              ]
            : []),
        ];
        const openclawDelivery: AssistantMessage["openclawDelivery"] =
          mode === "literal" ? undefined : { audioAsVoice: true };
        const append = await appendInjectedAssistantMessageToTranscript({
          ...scope,
          message: literal,
          content,
          ...(openclawDelivery ? { openclawDelivery } : {}),
        });
        expect(append).toMatchObject({ ok: true, messageId: expect.any(String) });
        const database = openOpenClawAgentDatabase({ ...scope, env: state.env });
        expect(database.path.startsWith(state.stateDir + path.sep)).toBe(true);
        const records = await loadTranscriptEvents(scope);
        const event = records.find((row) => isRecord(row) && row.id === append.messageId);
        if (!isRecord(event) || event.type !== "message" || !isRecord(event.message)) {
          throw new Error("missing injected message");
        }
        const message = event.message;
        expect(message.content).toEqual(content);
        const projected = projectChatDisplayMessage(message);
        expect(projected).toMatchObject({
          content: [
            content[0],
            ...(mode === "mixed"
              ? [{ type: "text", text: "Raw answer.", textSignature: "raw-answer" }]
              : []),
          ],
        });
        expect(message).not.toHaveProperty("openclawDelivery.replyToId");
        expect(message).not.toHaveProperty("openclawDelivery.tts");
        if (mode === "literal") {
          expect(message).not.toHaveProperty("openclawDelivery");
        } else {
          expect(message).toHaveProperty("openclawDelivery.audioAsVoice", true);
        }
        if (mode === "mixed") {
          expect(message).toHaveProperty("openclawDelivery.replyToCurrent", true);
        }
      });
    },
  );
});

import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { setBlockReplyDelivery } from "./block-reply-delivery.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

const baseParams = {
  isHeartbeat: false,
  didLogHeartbeatStrip: false,
  replyToMode: "off" as const,
};

function response(payload: ReplyPayload, start: number, end = start): ReplyPayload {
  return setReplyPayloadMetadata(payload, {
    assistantMessageStartIndex: start,
    assistantMessageIndex: end,
  });
}

const mediaUrl = "/tmp/shared-response.png";

const deliveryCases = [
  { outcome: "delivered", pending: false, sameResponseMedia: [] },
  { outcome: "recovery-owned", pending: true, sameResponseMedia: [] },
  { outcome: "failed-deliver", pending: false, sameResponseMedia: [] },
  { outcome: "failed-before-deliver", pending: false, sameResponseMedia: [mediaUrl] },
] as const;

describe.each(deliveryCases)(
  "response media with $outcome receipt",
  ({ outcome, pending, sameResponseMedia }) => {
    it.each(["direct", "pipeline"] as const)(
      "uses only the current response's %s receipts",
      async (transport) => {
        const sent = setReplyPayloadMetadata({ mediaUrl }, { assistantMessageIndex: 1 });
        const pipeline =
          transport === "pipeline"
            ? createBlockReplyPipeline({
                onBlockReply: () => {
                  setBlockReplyDelivery(Promise.resolve({ outcome, pending }));
                },
                timeoutMs: 0,
              })
            : null;
        try {
          if (pipeline) {
            pipeline.enqueue(sent);
            await pipeline.flush({ force: true });
          }
          const { replyPayloads } = await buildReplyPayloads({
            ...baseParams,
            blockStreamingEnabled: transport === "pipeline",
            blockReplyPipeline: pipeline,
            directBlockDeliveries: pipeline ? [] : [{ payload: sent, outcome, pending }],
            payloads: [
              response({ text: "Earlier response", mediaUrl }, 0),
              response({ text: "Same response", mediaUrl }, 1, 2),
              response({ text: "Later response", mediaUrl }, 3),
            ],
          });
          expect(
            replyPayloads.map((payload) => ({
              text: payload.text,
              media: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
            })),
          ).toEqual([
            { text: "Earlier response", media: [mediaUrl] },
            { text: "Same response", media: sameResponseMedia },
            { text: "Later response", media: [mediaUrl] },
          ]);
        } finally {
          pipeline?.stop();
        }
      },
    );
  },
);

describe("completed response text spans", () => {
  it.each(["direct", "pipeline"] as const)(
    "recognizes all %s blocks in one response without suppressing another response",
    async (transport) => {
      const blocks = [
        setReplyPayloadMetadata({ text: "Alpha" }, { assistantMessageIndex: 1 }),
        setReplyPayloadMetadata({ text: "Beta" }, { assistantMessageIndex: 2 }),
      ];
      const pipeline =
        transport === "pipeline"
          ? createBlockReplyPipeline({
              onBlockReply: () => {
                setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }));
              },
              timeoutMs: 0,
            })
          : null;
      try {
        if (pipeline) {
          for (const block of blocks) {
            pipeline.enqueue(block);
          }
          await pipeline.flush({ force: true });
        }
        const { replyPayloads } = await buildReplyPayloads({
          ...baseParams,
          blockStreamingEnabled: transport === "pipeline",
          blockReplyPipeline: pipeline,
          directBlockDeliveries: pipeline
            ? []
            : blocks.map((payload) => ({ payload, outcome: "delivered" })),
          payloads: [response({ text: "Alpha\nBeta" }, 1, 2), response({ text: "Alpha\nBeta" }, 3)],
        });
        expect(replyPayloads.map((payload) => payload.text)).toEqual(["Alpha\nBeta"]);
      } finally {
        pipeline?.stop();
      }
    },
  );

  it("retries an unsent span suffix while an identical prefix keeps queue custody", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: (payload) => {
        setBlockReplyDelivery(
          Promise.resolve(
            getReplyPayloadMetadata(payload)?.assistantMessageIndex === 1
              ? { outcome: "recovery-owned", pending: true }
              : { outcome: "failed-before-deliver" },
          ),
        );
      },
      timeoutMs: 0,
    });
    try {
      pipeline.enqueue(
        setReplyPayloadMetadata(
          { text: "Echo" },
          { assistantMessageIndex: 1, blockSourceText: "Echo\n" },
        ),
      );
      pipeline.enqueue(
        setReplyPayloadMetadata(
          { text: "Echo" },
          { assistantMessageIndex: 2, blockSourceText: "Echo" },
        ),
      );
      await pipeline.flush({ force: true });
      const { replyPayloads } = await buildReplyPayloads({
        ...baseParams,
        blockStreamingEnabled: true,
        blockReplyPipeline: pipeline,
        payloads: [response({ text: "Echo\nEcho" }, 1, 2)],
      });
      expect(replyPayloads.map((payload) => payload.text)).toEqual(["Echo"]);
    } finally {
      pipeline.stop();
    }
  });
});

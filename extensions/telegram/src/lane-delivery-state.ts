type LaneDeliverySnapshot = {
  delivered: boolean;
  skippedNonSilent: number;
  failedNonSilent: number;
};

export type LaneDeliveryStateTracker = {
  markDelivered: () => void;
  noteMessageIds: (ids: readonly string[]) => void;
  latestMessageId: () => number | undefined;
  markNonSilentSkip: () => void;
  markNonSilentFailure: () => void;
  snapshot: () => LaneDeliverySnapshot;
};

export function createLaneDeliveryStateTracker(): LaneDeliveryStateTracker {
  let latestMessageId: number | undefined;
  const state: LaneDeliverySnapshot = {
    delivered: false,
    skippedNonSilent: 0,
    failedNonSilent: 0,
  };
  return {
    noteMessageIds: (ids) => {
      for (const id of ids) {
        const value = Number(id);
        if (Number.isSafeInteger(value) && value > 0) {
          latestMessageId = Math.max(latestMessageId ?? 0, value);
        }
      }
    },
    latestMessageId: () => latestMessageId,
    markDelivered: () => {
      state.delivered = true;
    },
    markNonSilentSkip: () => {
      state.skippedNonSilent += 1;
    },
    markNonSilentFailure: () => {
      state.failedNonSilent += 1;
    },
    snapshot: () => ({ ...state }),
  };
}

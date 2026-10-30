// SDK queue admission remains separate from the SDK-independent stack decoder.
import { prepareMainStack } from "../../jdwp-main-stack";
import { createQueueStackGate, type QueueIdentity, type QueueNotice } from "./sdk-queue-stack-policy";
import type { StackEvidence } from "../../jdwp-main-stack";
export type { StackEvidence, Frame } from "../../jdwp-main-stack";

export async function prepareQueueMain(request: Parameters<typeof prepareMainStack>[0], signal: AbortSignal,
  now: () => number = () => Math.floor(performance.now())) {
  const prepared = await prepareMainStack(request, signal, now);
  let attempted = false;
  return {
    async sample(expected: QueueIdentity, authorize: () => Promise<QueueNotice>, requestActive: () => boolean,
      evidence: StackEvidence) {
      if (attempted) throw Error("Queue stack already attempted");
      attempted = true; signal.throwIfAborted();
      const gate = createQueueStackGate(expected), notice = await authorize();
      signal.throwIfAborted();
      return prepared.sample(() => {
        signal.throwIfAborted();
        const status = gate.reserve(notice, now(), requestActive());
        if (status !== "sample-reserved") throw Error(`Queue stack refused: ${status}`);
      }, evidence);
    },
    resolveFrames: prepared.resolveFrames,
  };
}

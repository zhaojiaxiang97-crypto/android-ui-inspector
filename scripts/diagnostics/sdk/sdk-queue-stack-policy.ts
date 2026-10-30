// Offline admission policy only: no adb, JDWP, launch or SDK calls.
export type QueueIdentity = {
  apkSha256: string; sdkVersion: string; pid: number; startTicks: string;
  processInstance: string; requestId: string;
};
export type QueueNotice = {
  identity: QueueIdentity; postedMs: number; observedMs: number;
  enteredMs: number; settledMs: number; receivedHostMs: number;
};
const clock = (n: number) => Number.isSafeInteger(n) && n >= 0;
function validIdentity(i: QueueIdentity) {
  return Boolean(i && /^[a-f0-9]{64}$/.test(i.apkSha256) && typeof i.sdkVersion === "string"
    && i.sdkVersion.length > 0 && i.sdkVersion.length <= 128 && Number.isSafeInteger(i.pid) && i.pid > 0
    && /^\d+$/.test(i.startTicks) && typeof i.processInstance === "string" && i.processInstance.length > 0
    && i.processInstance.length <= 128 && (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(i.requestId)
      || /^[a-f0-9]{16}$/.test(i.requestId)));
}
function sameIdentity(a: QueueIdentity, b: QueueIdentity) {
  return validIdentity(a) && validIdentity(b)
    && (["apkSha256", "sdkVersion", "pid", "startTicks", "processInstance", "requestId"] as const)
      .every(key => a[key] === b[key]);
}

/** Reservation is consumed before attaching: a failed or missed sample never retries. */
export function createQueueStackGate(expected: QueueIdentity) {
  if (!validIdentity(expected)) throw new Error("Invalid queue observation identity");
  const identity = { ...expected };
  let consumed = false;
  return {
    reserve(notice: QueueNotice, nowHostMs: number, requestActive: boolean) {
      if (consumed) return "already-attempted";
      if (!requestActive) return "request-ended";
      if (!notice || !sameIdentity(identity, notice.identity)) return "identity-mismatch";
      if (![notice.postedMs, notice.observedMs, notice.receivedHostMs, nowHostMs].every(clock)
        || notice.observedMs < notice.postedMs || nowHostMs < notice.receivedHostMs) return "invalid-time";
      // Host and device clocks are never subtracted from one another.
      if (nowHostMs - notice.receivedHostMs > 250) return "stale-notice";
      if (notice.enteredMs !== -1 || notice.settledMs !== -1) return "task-not-queued";
      const waited = notice.observedMs - notice.postedMs;
      if (waited < 500) return "too-early";
      if (waited >= 2500) return "too-late";
      consumed = true;
      return "sample-reserved";
    },
  };
}

/** Post-check using device monotonic timestamps; this never certifies startup performance. */
export function queueStackEvidenceMatches(expected: QueueIdentity, notice: QueueNotice, final: {
  identity: QueueIdentity; postedMs: number; enteredMs: number; settledMs: number;
}, sample: {
  identity: QueueIdentity; startedDeviceMs: number; resumedDeviceMs: number;
  resumeVerified: boolean; forwardRemoved: boolean; frames: number;
}) {
  const boundary = final.enteredMs === -1 ? final.settledMs : final.enteredMs;
  return sameIdentity(expected, notice.identity) && sameIdentity(expected, final.identity)
    && sameIdentity(expected, sample.identity) && clock(notice.observedMs) && notice.observedMs >= notice.postedMs
    && notice.enteredMs === -1 && notice.settledMs === -1
    && notice.observedMs - notice.postedMs >= 500 && notice.observedMs - notice.postedMs < 2500
    && clock(final.postedMs) && final.postedMs === notice.postedMs
    && clock(final.settledMs) && final.settledMs > final.postedMs
    && clock(boundary) && boundary >= final.postedMs && boundary <= final.settledMs
    && clock(sample.startedDeviceMs) && clock(sample.resumedDeviceMs)
    && sample.startedDeviceMs >= notice.observedMs && sample.startedDeviceMs >= final.postedMs
    && sample.resumedDeviceMs >= sample.startedDeviceMs && sample.resumedDeviceMs < boundary
    && sample.resumeVerified === true && sample.forwardRemoved === true
    && Number.isSafeInteger(sample.frames) && sample.frames > 0 && sample.frames <= 32;
}

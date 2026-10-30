import { randomUUID } from "node:crypto";

/** A strict capture must not enqueue a second tree after the first UI timeout. */
export async function requestSdkTree<T extends { stdout: Buffer; code: number | null }>(
  call: (request: string) => Promise<T>, singleAttempt: boolean, signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    const request = randomUUID();
    const reply = await sdkTreePhase(`capture-${attempt}`, () => call(request), request);
    signal?.throwIfAborted();
    if (!reply.stdout.toString("utf8").includes("error=View tree timed out")) return reply;
    if (singleAttempt || attempt === 2) {
      throw new Error(singleAttempt
        ? "SDK 控件树超时：目标 App 页面尚未就绪，请稍后重试。"
        : "SDK 控件树连续超时：目标 App 页面尚未就绪，请稍后重试。");
    }
  }
}
export async function sdkTreePhase<T>(phase: string, call: () => Promise<T>, request = randomUUID()): Promise<T> {
  const started = performance.now();
  try { return await call(); }
  finally { console.log(`[sdk-tree] phase=${phase} request=${request} elapsedMs=${Math.round(performance.now() - started)}`); }
}

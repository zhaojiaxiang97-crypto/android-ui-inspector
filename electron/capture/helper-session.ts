import { z } from "zod";
import type { DisplayFrame } from "../../shared/types";
import { assertSameHelperServiceEvidence, isFreshHelperRecoveryEvidence,
  type HelperObservationEvidence, type HelperRecoveryEvidence } from "../../shared/helper-observation";
import { withoutCommandSignal } from "../device/command-context";
import { runCommand } from "../device/runtime";
import { openOwnedDebugForward, type ForwardExecute, type OwnedDebugForward } from "../platform/owned-debug-forward";
import { HelperCaptureError, readHelperToken } from "./accessibility-helper";
import { readHelperCapabilities, readHelperObservation, type HelperFetch } from "./helper-observation";

export type AccessibilityHelperSession = {
  read: (adbPath: string, packageName: string, frame: DisplayFrame, signal: AbortSignal) => ReturnType<typeof readHelperObservation>;
  release: () => Promise<void>;
  close: () => Promise<void>;
};
type Dependencies = { readToken?: () => string; execute?: ForwardExecute; choosePort?: () => Promise<number>; fetch?: HelperFetch };

/** Lazily owns one forward for one authorized desktop session. No install, pairing or permission changes. */
export function createAccessibilityHelperSession(options: { sessionId: string; serial: string; signal: AbortSignal }, deps: Dependencies = {}): AccessibilityHelperSession {
  if (!z.uuid().safeParse(options.sessionId).success || !/^[\w.-]+$/.test(options.serial)) throw new Error("Helper 会话身份无效。");
  const lifetime = new AbortController();
  let closed = false, boundAdb: string | undefined, boundToken: string | undefined, boundPackage: string | undefined, serviceId: string | undefined;
  let forward: OwnedDebugForward | undefined, active: ReturnType<typeof readHelperObservation> | undefined;
  let last: HelperObservationEvidence | undefined, closing: Promise<void> | undefined, releasing: Promise<void> | undefined;
  let rejectedRead: HelperRecoveryEvidence | undefined;
  function reject(message: string): never { throw new HelperCaptureError("helper-session", message); }
  const execute: ForwardExecute = deps.execute ?? ((args, timeout) => withoutCommandSignal(async () => {
    const result = await runCommand(boundAdb!, args, timeout);
    if (result.code !== 0) throw new HelperCaptureError("helper-forward", "Helper 转发命令失败。");
    return result.stdout.toString("utf8");
  }));
  const release = () => releasing ??= (async () => {
    const owned = forward;
    forward = undefined;
    await owned?.close();
  })().finally(() => { releasing = undefined; });
  const close = () => closing ??= (async () => {
    closed = true;
    lifetime.abort(new Error("Helper 调试授权已结束。"));
    options.signal.removeEventListener("abort", revoked);
    await active?.catch(() => undefined);
    await release();
  })();
  const revoked = () => { void close().catch(() => undefined); };
  options.signal.addEventListener("abort", revoked, { once: true });
  if (options.signal.aborted) revoked();
  const checkForward = async () => {
    if (!forward) reject("Helper 转发已关闭。");
    const output = await execute(["-s", options.serial, "forward", "--list"], 750);
    if (typeof output !== "string" || Buffer.byteLength(output) > 8192) reject("Helper 转发清单无效。");
    const rows = output.trim().split(/\r?\n/).filter(Boolean).map(row => row.trim().split(/\s+/));
    if (rows.length > 128 || rows.some(row => row.length !== 3)) reject("Helper 转发清单无效。");
    const found = rows.filter(row => row[0] === options.serial && row[1] === `tcp:${forward!.port}`);
    if (found.length !== 1 || found[0][2] !== "tcp:18888") reject("Helper 转发绑定已变化，已停止采集。");
  };
  const read: AccessibilityHelperSession["read"] = (adbPath, packageName, frame, callerSignal) => {
    if (closed || lifetime.signal.aborted || options.signal.aborted) return Promise.reject(new Error("Helper 调试授权已结束。"));
    if (active || releasing) return Promise.reject(new Error("Helper 当前仍有观察或清理未结束。"));
    const signal = AbortSignal.any([lifetime.signal, options.signal, callerSignal, AbortSignal.timeout(30_000)]);
    const work = (async () => {
      try {
        signal.throwIfAborted();
        const readToken = deps.readToken ?? (() => readHelperToken(process.env.ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE));
        const token = readToken();
        if (boundAdb !== undefined && adbPath !== boundAdb || boundToken !== undefined && token !== boundToken || boundPackage !== undefined && packageName !== boundPackage)
          reject("Helper 配对或设备连接已变化；请结束当前调试后重新授权。");
        boundAdb = adbPath; boundToken = token; boundPackage = packageName;
        if (!forward) {
          forward = await openOwnedDebugForward(options.serial, "tcp:18888", signal, execute, deps.choosePort);
          signal.throwIfAborted();
          const capabilities = await readHelperCapabilities(forward.port, token, signal, deps.fetch);
          if (serviceId !== undefined && capabilities.serviceInstanceId !== serviceId) reject("Helper 服务已重启；请重新授权调试。");
          serviceId = capabilities.serviceInstanceId;
        } else await checkForward();
        const observed = await readHelperObservation(forward.port, token, packageName, frame, signal, deps.fetch);
        if (observed.helperObservation.serviceInstanceId !== serviceId) reject("Helper 服务已重启；请重新授权调试。");
        if (last) assertSameHelperServiceEvidence(last, observed.helperObservation);
        if (rejectedRead && !isFreshHelperRecoveryEvidence(rejectedRead, observed.helperObservation))
          reject("Helper 观察未晚于上次失败读取，或显示器/服务身份已变化；请重新观察。");
        await checkForward();
        signal.throwIfAborted();
        if (readToken() !== token) reject("Helper 配对在采集期间已变化；请重新授权调试。");
        last = observed.helperObservation;
        rejectedRead = undefined;
        return observed;
      } catch (error) {
        let failure = error;
        if (error instanceof HelperCaptureError && error.recoveryEvidence) {
          try {
            const evidence = error.recoveryEvidence, previous = rejectedRead ?? last;
            if (evidence.serviceInstanceId !== serviceId || previous && !isFreshHelperRecoveryEvidence(previous, evidence))
              reject("Helper 失败读取的服务、显示器或采集时序已变化；请重新观察。");
            await checkForward();
            signal.throwIfAborted();
            const currentToken = deps.readToken ?? (() => readHelperToken(process.env.ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE));
            if (currentToken() !== boundToken) reject("Helper 配对在采集期间已变化；请重新授权调试。");
            rejectedRead = evidence;
          } catch {
            // Keep only the bounded reason codes; an untrusted connection must not authorize another read.
            failure = new HelperCaptureError("helper-session", "Helper 失败读取的会话或来源证据无效，已停止恢复。", { diagnostics: error.diagnostics });
          }
        }
        try { await release(); }
        catch { throw new HelperCaptureError("helper-cleanup", "Helper 采集失败且转发归属已变化；未移除其他连接，请检查设备连接。"); }
        throw failure;
      }
    })();
    active = work;
    void work.finally(() => { if (active === work) active = undefined; }).catch(() => undefined);
    return work;
  };
  return { read, release, close };
}

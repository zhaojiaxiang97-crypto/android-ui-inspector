import { z } from "zod";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DebugInputAction, DisplayFrame } from "../../shared/types";
import { helperInputRequest, type HelperInputReply, type HelperInputRequest } from "../../shared/helper-input";
import type { HelperConditionWaitHint, HelperConditionWaitRequest } from "../../shared/helper-condition-wait";
import { assertSameHelperServiceEvidence, helperRecoverySourceReason, isFreshHelperRecoveryEvidence, isHelperObservationEvidence, isHelperWindowMotionRecoveryEvidence,
  type HelperObservationEvidence, type HelperRecoveryEvidence } from "../../shared/helper-observation";
import { withoutCommandSignal } from "../device/command-context";
import { runCommand } from "../device/runtime";
import { openOwnedDebugForward, type ForwardExecute, type OwnedDebugForward } from "../platform/owned-debug-forward";
import { HelperCaptureError, readHelperToken } from "./accessibility-helper";
import { readHelperCapabilities, readHelperObservation, type HelperFetch } from "./helper-observation";
import { readHelperConditionWait } from "./helper-condition-wait";
import { HelperInputError, readHelperInput } from "./helper-input";
import { hasWindowTransitionHelperDiagnostics, hasSystemOnlyHelperFocusGapDiagnostics } from "../../shared/helper-observation-diagnostics";
import type { HelperRecoveryDiagnostics } from "../../shared/helper-recovery-diagnostics";
import { readControlledHelperObservation } from "./helper-read-control";

export type AccessibilityHelperSession = {
  read: (adbPath: string, packageName: string, frame: DisplayFrame, signal: AbortSignal,
    afterResponse?: () => Promise<void>, remainingBudgetMs?: number) => ReturnType<typeof readHelperObservation>;
  wait: (adbPath: string, packageName: string, frame: DisplayFrame,
    condition: Pick<HelperConditionWaitRequest, "selector" | "state" | "timeoutMs">, signal: AbortSignal) => Promise<HelperConditionWaitHint | null>;
  input?: (adbPath: string, packageName: string, frame: DisplayFrame, evidence: HelperObservationEvidence,
    action: DebugInputAction, signal: AbortSignal, target?: HelperInputRequest["target"]) => Promise<HelperInputReply>;
  release: () => Promise<void>;
  close: () => Promise<void>;
};
type Dependencies = { readToken?: () => string; execute?: ForwardExecute; choosePort?: () => Promise<number>; fetch?: HelperFetch };

/** Lazily owns one forward for one authorized desktop session. No install, pairing or permission changes. */
export function createAccessibilityHelperSession(options: { sessionId: string; serial: string; signal: AbortSignal }, deps: Dependencies = {}): AccessibilityHelperSession {
  if (!z.uuid().safeParse(options.sessionId).success || !/^[\w.-]+$/.test(options.serial)) throw new Error("Helper 会话身份无效。");
  const lifetime = new AbortController();
  let closed = false, boundAdb: string | undefined, boundToken: string | undefined, boundPackage: string | undefined, serviceId: string | undefined;
  let forward: OwnedDebugForward | undefined, active: Promise<unknown> | undefined;
  let last: HelperObservationEvidence | undefined, closing: Promise<void> | undefined, releasing: Promise<void> | undefined;
  let rejectedRead: HelperRecoveryEvidence | undefined;
  let waitCursor: HelperConditionWaitHint | undefined, waitUnsupported = false;
  let inputUncertain = false;
  let consumedCaptureId: string | undefined, inputCursor: HelperInputReply | undefined;
  let supportsInput = false;
  const sameFrame = (a: HelperConditionWaitRequest["display"], b: HelperConditionWaitRequest["display"]) =>
    a.width === b.width && a.height === b.height && a.rotation === b.rotation;
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
  const read: AccessibilityHelperSession["read"] = (adbPath, packageName, frame, callerSignal, afterResponse, remainingBudgetMs) => {
    if (closed || lifetime.signal.aborted || options.signal.aborted) return Promise.reject(new Error("Helper 调试授权已结束。"));
    if (active || releasing) return Promise.reject(new Error("Helper 当前仍有观察或清理未结束。"));
    if (remainingBudgetMs !== undefined && (!Number.isFinite(remainingBudgetMs) || remainingBudgetMs < 1 || remainingBudgetMs > 30000))
      return Promise.reject(new HelperCaptureError("helper-control", "Helper 受控读取剩余预算无效。"));
    const signal = AbortSignal.any([lifetime.signal, options.signal, callerSignal,
      AbortSignal.timeout(remainingBudgetMs === undefined ? 30000 : Math.max(1, Math.floor(remainingBudgetMs)))]);
    const readStarted = performance.now();
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
          supportsInput = capabilities.capabilities.guardedInput === true;
        } else await checkForward();
        const observed = remainingBudgetMs === undefined
          ? await readHelperObservation(forward.port, token, packageName, frame, signal, deps.fetch, afterResponse)
          : await readControlledHelperObservation(forward.port, token, { sessionId: options.sessionId, serviceInstanceId: serviceId!, packageName },
            frame, signal, remainingBudgetMs - (performance.now() - readStarted), deps.fetch, afterResponse);
        if (observed.helperObservation.serviceInstanceId !== serviceId) reject("Helper 服务已重启；请重新授权调试。");
        if (last) assertSameHelperServiceEvidence(last, observed.helperObservation);
        if (waitCursor && (observed.helperObservation.timing.startedAtMs < waitCursor.finishedAtMs
          || !sameFrame(observed.helperObservation.displayBefore, waitCursor.display)))
          reject("Helper 观察未晚于设备等待，或显示器已变化。");
        if (inputCursor && (observed.helperObservation.timing.startedAtMs < inputCursor.finishedAtMs
          || !sameFrame(observed.helperObservation.displayBefore, inputCursor.display)))
          reject("Helper 观察未晚于设备输入，或显示器已变化。");
        if (rejectedRead && !isFreshHelperRecoveryEvidence(rejectedRead, observed.helperObservation, packageName))
          reject("Helper 观察未晚于上次失败读取，或显示器/服务身份已变化；请重新观察。");
        await checkForward();
        signal.throwIfAborted();
        if (readToken() !== token) reject("Helper 配对在采集期间已变化；请重新授权调试。");
        last = structuredClone(observed.helperObservation);
        waitCursor = undefined;
        inputCursor = undefined;
        rejectedRead = undefined;
        return observed;
      } catch (error) {
        let failure = error;
        if (error instanceof HelperCaptureError && error.recoveryEvidence
          && (hasWindowTransitionHelperDiagnostics(error.recoveryEvidence.diagnostics) || hasSystemOnlyHelperFocusGapDiagnostics(error.recoveryEvidence.diagnostics)
            || isHelperWindowMotionRecoveryEvidence(error.recoveryEvidence, packageName, frame))
          && inputCursor?.dispatchState !== "sent") {
          // No after-input receipt means this new exception stays a hard, incomplete read.
          failure = new HelperCaptureError(error.code, error.message, { diagnostics: error.diagnostics,
            recoveryDiagnostics: { version: 1, ...error.recoveryDiagnostics, session: "sent_receipt_required" } });
        } else if (error instanceof HelperCaptureError && error.recoveryEvidence) {
          let recoveryDiagnostics: HelperRecoveryDiagnostics = { version: 1, ...error.recoveryDiagnostics, session: "binding_check_failed" };
          try {
            const evidence = error.recoveryEvidence, previous = rejectedRead ?? last;
            if (evidence.serviceInstanceId !== serviceId) {
              recoveryDiagnostics.session = "service_changed";
              reject("Helper 失败读取的服务、显示器或采集时序已变化；请重新观察。");
            }
            if (previous) {
              recoveryDiagnostics.source = helperRecoverySourceReason(previous, evidence, packageName);
              if (recoveryDiagnostics.source !== "accepted") {
                recoveryDiagnostics.session = "source_rejected";
                reject("Helper 失败读取的服务、显示器或采集时序已变化；请重新观察。");
              }
            }
            if (waitCursor && (evidence.timing.startedAtMs < waitCursor.finishedAtMs || !sameFrame(evidence.displayBefore, waitCursor.display))) {
              recoveryDiagnostics.session = "before_wait_receipt";
              reject("Helper 失败读取早于设备等待，不能用作恢复水位。");
            }
            if (inputCursor && (evidence.timing.startedAtMs < inputCursor.finishedAtMs || !sameFrame(evidence.displayBefore, inputCursor.display))) {
              recoveryDiagnostics.session = "before_input_receipt";
              reject("Helper 失败读取早于设备输入，不能用作恢复水位。");
            }
            await checkForward();
            signal.throwIfAborted();
            const currentToken = deps.readToken ?? (() => readHelperToken(process.env.ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE));
            if (currentToken() !== boundToken) reject("Helper 配对在采集期间已变化；请重新授权调试。");
            rejectedRead = evidence;
            failure = new HelperCaptureError(error.code, error.message, { diagnostics: error.diagnostics, recoveryEvidence: evidence,
              recoveryDiagnostics: { ...recoveryDiagnostics, session: "accepted" } });
          } catch {
            // Keep only the bounded reason codes; an untrusted connection must not authorize another read.
            failure = new HelperCaptureError("helper-session", "Helper 失败读取的会话或来源证据无效，已停止恢复。", {
              diagnostics: error.diagnostics, recoveryDiagnostics });
          }
        }
        try { await release(); }
        catch { throw new HelperCaptureError("helper-cleanup", "Helper 采集失败且转发归属已变化；未移除其他连接，请检查设备连接。", {
          diagnostics: failure instanceof HelperCaptureError ? failure.diagnostics : undefined,
          recoveryDiagnostics: { version: 1, session: "cleanup_failed", ...(failure instanceof HelperCaptureError ? failure.recoveryDiagnostics : {}),
            cleanupFailed: true } }); }
        throw failure;
      }
    })();
    active = work;
    void work.finally(() => { if (active === work) active = undefined; }).catch(() => undefined);
    return work;
  };
  const wait: AccessibilityHelperSession["wait"] = (adbPath, packageName, frame, condition, callerSignal) => {
    if (closed || lifetime.signal.aborted || options.signal.aborted) return Promise.reject(new Error("Helper 调试授权已结束。"));
    if (active || releasing) return Promise.reject(new Error("Helper 当前仍有观察或清理未结束。"));
    const signal = AbortSignal.any([lifetime.signal, options.signal, callerSignal, AbortSignal.timeout(3000)]);
    const work = (async () => {
      try {
        signal.throwIfAborted();
        const readToken = deps.readToken ?? (() => readHelperToken(process.env.ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE));
        const token = readToken();
        if (!last || last.captureId === consumedCaptureId || !serviceId || !forward || adbPath !== boundAdb || token !== boundToken || packageName !== boundPackage
          || !sameFrame(frame, waitCursor?.display ?? last.displayAfter))
          reject("Helper 等待缺少当前授权观察，或配对、设备、显示器已变化。");
        await checkForward();
        signal.throwIfAborted();
        if (waitUnsupported) return null;
        const hint = await readHelperConditionWait(forward!.port, token, { version: 1, sessionId: options.sessionId,
          requestId: randomUUID(), serviceInstanceId: serviceId!, packageName, selector: condition.selector,
          state: condition.state, display: frame, timeoutMs: condition.timeoutMs }, signal, deps.fetch);
        await checkForward();
        signal.throwIfAborted();
        if (readToken() !== token) reject("Helper 配对在等待期间已变化；请重新授权调试。");
        if (!hint) { waitUnsupported = true; return null; }
        const watermark = Math.max(last!.timing.completedAtMs, rejectedRead?.timing.completedAtMs ?? 0, waitCursor?.finishedAtMs ?? 0);
        if (hint.startedAtMs < watermark || hint.windowId !== last!.windowId)
          reject("Helper 等待提示不是新读取，或窗口已变化，已停止等待。");
        waitCursor = hint;
        return hint;
      } catch (error) {
        try { await release(); }
        catch { throw new HelperCaptureError("helper-cleanup", "Helper 等待失败且转发归属已变化；未移除其他连接。"); }
        throw error;
      }
    })();
    active = work;
    void work.finally(() => { if (active === work) active = undefined; }).catch(() => undefined);
    return work;
  };
  const input: NonNullable<AccessibilityHelperSession["input"]> = (adbPath, packageName, frame, evidence, action, callerSignal, target) => {
    if (closed || lifetime.signal.aborted || options.signal.aborted) return Promise.reject(new HelperInputError("Helper 调试授权已结束。", "not_sent"));
    if (active || releasing) return Promise.reject(new HelperInputError("Helper 当前仍有观察或清理未结束。", "not_sent"));
    if (inputUncertain) return Promise.reject(new HelperInputError("上次 Helper 操作结果未知，本次授权只允许继续观察；如需操作，请结束后重新授权。", "not_sent"));
    const signal = AbortSignal.any([lifetime.signal, options.signal, callerSignal, AbortSignal.timeout(7000)]);
    let dispatched = false, requestId: string | undefined, reply: HelperInputReply | undefined;
    const work = (async () => {
      try {
        signal.throwIfAborted();
        const readToken = deps.readToken ?? (() => readHelperToken(process.env.ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE));
        const token = readToken();
        if (!last || !serviceId || !forward || adbPath !== boundAdb || token !== boundToken || packageName !== boundPackage
          || waitCursor || rejectedRead || consumedCaptureId === last.captureId || !isHelperObservationEvidence(evidence)
          || !isDeepStrictEqual(evidence, last) || !sameFrame(frame, last.displayAfter))
          reject("Helper 输入缺少当前完整观察，或授权、配对、设备、显示器已变化。");
        if (!supportsInput) reject("当前 Helper 仅支持只读观察，未声明受保护输入能力；未发送操作。");
        await checkForward();
        signal.throwIfAborted();
        if (readToken() !== token) reject("Helper 配对在输入前已变化。");
        requestId = randomUUID();
        const request = helperInputRequest.parse({ version: 1, sessionId: options.sessionId, requestId,
          serviceInstanceId: serviceId!, captureId: last.captureId, packageName, windowId: last.windowId, display: frame, action,
          ...(target ? { target } : {}) });
        // Consume before dispatch, including failed receipts. Only a new full read grants another attempt.
        consumedCaptureId = last.captureId;
        dispatched = true;
        reply = await readHelperInput(forward!.port, token, request, signal, deps.fetch);
        if (reply.startedAtMs < last.timing.completedAtMs) reject("Helper 输入回执早于当前观察。");
        inputCursor = reply;
        if (reply.dispatchState === "unknown") inputUncertain = true;
        await checkForward();
        signal.throwIfAborted();
        if (readToken() !== token) reject("Helper 配对在输入期间已变化。");
        return reply;
      } catch (error) {
        reply ??= error instanceof HelperInputError ? error.reply : undefined;
        const state = error instanceof HelperInputError ? error.dispatchState : dispatched ? "unknown" : "not_sent";
        if (reply && last && reply.startedAtMs >= last.timing.completedAtMs) inputCursor = reply;
        // Without a confirmed terminal input, a fresh screenshot cannot authorize another gesture.
        if (dispatched && state !== "not_sent") inputUncertain = true;
        const message = error instanceof HelperInputError ? error.message : "Helper 输入的授权或来源校验失败。";
        try { await release(); }
        catch { throw new HelperInputError("Helper 输入失败且转发归属已变化；未移除其他连接。", state, requestId, reply); }
        throw new HelperInputError(message, state, requestId ?? (error instanceof HelperInputError ? error.requestId : undefined), reply);
      }
    })();
    active = work;
    void work.finally(() => { if (active === work) active = undefined; }).catch(() => undefined);
    return work;
  };
  return { read, wait, input, release, close };
}

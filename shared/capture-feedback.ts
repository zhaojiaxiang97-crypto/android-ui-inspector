import type { CaptureReadiness, UiSnapshot } from "./types";
import { copyCaptureReadiness, isCaptureReadiness } from "./capture-readiness";
import { isCaptureRequestDiagnostics } from "./capture-attempts";

export type CaptureFailureRecord = {
  requestId: string; serial: string; attempt: number; error: string; readiness: CaptureReadiness | null;
};

export function captureFeedback(snapshot: UiSnapshot | null, error: string | null) {
  const diagnostics = snapshot && isCaptureRequestDiagnostics(snapshot.captureRequestDiagnostics)
    ? snapshot.captureRequestDiagnostics : null;
  // A local cancellation/exception must not inherit an older snapshot's diagnosis.
  const matching = snapshot?.error === error;
  const candidate = matching ? snapshot?.captureReadiness ?? diagnostics?.attempts.at(-1)?.readiness : undefined;
  const readiness = isCaptureReadiness(candidate) ? candidate : null;
  let title = "读取失败", hint = "请保持目标页面稳定后，手动重新采集。";
  if (error === "已取消采集，可以重新开始。") {
    title = "采集已取消"; hint = "本次请求已停止，不会自动重新采集。";
  } else if (error?.startsWith("前台 App 在 18 秒内未准备好")) {
    if (!readiness) { title = "App 尚未准备好"; hint = "旧记录没有窗口和读树时间，请等待页面稳定后手动重采。"; }
    else if (readiness.firstFocusedWindowMs === null) {
      title = "App 窗口尚未就绪"; hint = "本轮没有确认到目标焦点窗口，未进入独立画面采集。请等待 App 页面出现。";
    } else if (readiness.phase === "tree") {
      title = /超时|超过.*预算/.test(error) ? "控件树读取超时" : "控件树暂不可用";
      hint = "目标窗口已确认，但控件树未就绪。本轮未进入独立画面采集。";
    } else if (readiness.phase === "focus-after") {
      title = "采集窗口无法复核"; hint = "读树后的窗口校验未通过，请保持同一页面稳定。";
    } else {
      title = "就绪检查未完成"; hint = "曾确认目标窗口，但本轮未完成控件树和窗口校验。请等待页面稳定。";
    }
  } else if (readiness?.phase === "ready") {
    // Readiness covers the system tree, not the later SDK tree. Check the
    // concrete failure before generic wrapper text such as “独立画面尚未就绪”.
    if (/SDK 控件树(?:连续)?超时/.test(error ?? "")) {
      title = "SDK 控件树读取超时";
      hint = "目标窗口与基础控件树已通过检查，但 SDK 控件树尚未返回。本次未完成采集，请在页面稳定后手动重采。";
    } else {
      title = /画面|截图|抓图|位图|像素|capture/i.test(error ?? "") ? "独立画面采集失败" : "后续采集失败";
      hint = "窗口与控件树已通过就绪检查，失败发生在后续采集阶段。";
    }
  }
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} 秒`;
  const timing: string[] = [];
  if (readiness) {
    timing.push(`就绪检查 ${seconds(readiness.elapsedMs)}`);
    if (readiness.firstFocusedWindowMs !== null) timing.push(`首次确认窗口 ${seconds(readiness.firstFocusedWindowMs)}`);
    const last = readiness.treeReads.at(-1);
    if (last) timing.push(`最近读树 ${seconds(last.endedMs - last.startedMs)} · 共 ${readiness.treeReadCount} 次`);
  }
  return { title, hint, timing, readiness };
}

/** Session-only bounded failure scalars, never trees, pixels or usable capture identity. */
export function rememberCaptureFailures(previous: CaptureFailureRecord[], snapshot: UiSnapshot, requestId: string): CaptureFailureRecord[] {
  const diagnostics = isCaptureRequestDiagnostics(snapshot.captureRequestDiagnostics) ? snapshot.captureRequestDiagnostics : null;
  const failures = diagnostics?.attempts.filter(a => a.error) ?? [];
  const entries = failures.length ? failures.map(a => ({ attempt: a.attempt, error: a.error!, readiness: a.readiness }))
    : snapshot.error ? [{ attempt: 1, error: snapshot.error, readiness: snapshot.captureReadiness }] : [];
  if (!entries.length) return previous;
  return [...previous, ...entries.map(a => ({ requestId: requestId.slice(0, 64), serial: snapshot.serial.slice(0, 512),
    attempt: a.attempt, error: a.error.slice(0, 1024), readiness: isCaptureReadiness(a.readiness) ? copyCaptureReadiness(a.readiness) : null }))].slice(-8);
}

import { useEffect, useState } from "react";
import type { DebugSessionState } from "../../../shared/types";
import { debugProgressElapsed, debugProgressPhaseLabel } from "../../../shared/debug-progress";
import "./debug-session-progress.css";

type Props = { state: DebugSessionState | null; onStop?: () => void; androidLogsEnabled?: boolean;
  onAndroidLogsChange?: (enabled: boolean) => void; disabled?: boolean };
const duration = (value: number) => `${Math.floor(value / 1000)} 秒`;
const actions: Record<string, string> = { capture_ui: "采集页面", tap_node: "点击控件", scroll_node: "滚动控件", press_back: "返回",
  perform_ui_step: "定位并操作", scroll_until: "连续滚动查找", resume_ui_step: "恢复结果观察",
  wait_for_ui: "等待页面条件", define_debug_task: "固定任务条件", check_debug_task: "检查任务条件" };

export function DebugSessionProgress({ state, onStop, androidLogsEnabled = false, onAndroidLogsChange, disabled }: Props) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!state?.active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.id, state?.active]);
  const progress = state?.progress;
  const elapsed = progress ? debugProgressElapsed(progress, now) : null;
  const last = state?.steps.at(-1);
  const check = state?.task?.checks.find(item => item.checkpointId === null);
  const laterInput = Boolean(check && state?.steps.some(step => step.id > check.stepId && ["tap_node", "scroll_node", "press_back", "perform_ui_step", "scroll_until"].includes(step.action)
    && (step.dispatchState !== "not_sent" || step.inputEvidence?.spawned)));
  const verdict = !state?.task ? "未声明任务" : !check ? "尚未检查" : laterInput ? "页面已操作，需重新验收"
    : { passed: "通过", failed: "失败", insufficient_evidence: "证据不足" }[check.status];
  return <section className="debug-session-progress" aria-label="自动调试进度">
    {onAndroidLogsChange && <label className="debug-session-log-option"><input type="checkbox" checked={androidLogsEnabled}
      disabled={disabled || Boolean(state?.active)} onChange={event => onAndroidLogsChange(event.target.checked)} />关联失败步骤的 Android 错误日志
      <small>显式开启后，仅读取目标 App 主进程、本次步骤时间范围；最多 200 行。</small></label>}
    {state && <>
      <div className="debug-session-progress-title"><strong role="status" aria-live="polite">{progress ? debugProgressPhaseLabel(progress.phase) : state.active ? state.busy ? "执行中" : "等待调试请求" : "已停止"}</strong>
        {elapsed && <span>会话 {duration(elapsed.sessionMs)}</span>}
        {state.active && onStop && <button type="button" className="close-button" onClick={onStop}>停止</button>}
      </div>
      <p>{progress?.stepId ? `步骤 #${progress.stepId} · ${actions[progress.action ?? ""] ?? progress.action}` : "尚未执行步骤"}{progress?.stepId && elapsed ? ` · ${duration(elapsed.stepMs)}` : ""}</p>
      {(progress?.reason || state.stopReason) && <p className="debug-session-progress-reason">{progress?.reason ?? state.stopReason}</p>}
      <dl><div><dt>会话授权</dt><dd>{state.active ? `有效 · 到期 ${new Date(state.expiresAt).toLocaleTimeString()}` : "已结束"}</dd></div>
        <div><dt>操作结果</dt><dd>{!last ? "尚未执行" : last.status === "running" ? "执行中" : last.status === "failed" ? "失败" : "本步完成"}</dd></div>
        <div><dt>任务验收</dt><dd>{verdict}</dd></div></dl>
    </>}
  </section>;
}

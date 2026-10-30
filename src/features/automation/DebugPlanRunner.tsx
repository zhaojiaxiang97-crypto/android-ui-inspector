import { useEffect, useMemo, useRef, useState } from "react";
import { debugPlanDefinition, type DebugPlanDefinition, type DebugPlanRun } from "../../../shared/debug-plan";
import type { DesktopApi, DebugPlanDesktopCommand } from "../../../shared/desktop-api";
import type { DebugSessionState } from "../../../shared/types";
import "./debug-plan-runner.css";

type Props = { state: DebugSessionState | null; command?: DesktopApi["debugPlanCommand"]; disabled?: boolean };
export function parseDebugPlanDraft(source: string): { definition: DebugPlanDefinition | null; error: string | null } {
  if (!source.trim()) return { definition: null, error: "请先粘贴操作计划。" };
  if (new TextEncoder().encode(source).length > 12000) return { definition: null, error: "操作计划不能超过12000字节。" };
  try {
    const result = debugPlanDefinition.safeParse(JSON.parse(source));
    return result.success ? { definition: result.data, error: null }
      : { definition: null, error: result.error.issues[0]?.message ?? "操作计划未通过校验。" };
  } catch { return { definition: null, error: "请检查JSON格式。" }; }
}
const runStatus: Record<DebugPlanRun["status"], string> = { running: "正在执行", passed: "已通过", failed: "未通过", cancelled: "已取消", interrupted: "已中断" };
const stepStatus = { pending: "待执行", running: "执行中", passed: "通过", skipped: "已跳过", failed: "失败" };

export function DebugPlanRunner({ state, command, disabled = false }: Props) {
  const [source, setSource] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [localRun, setLocalRun] = useState<DebugPlanRun | null>(null);
  const [target, setTarget] = useState<{ sessionId: string; runId: string; definition: DebugPlanDefinition } | null>(null);
  const revision = useRef(0), busyRef = useRef(false), sessionId = useRef(state?.id);
  sessionId.current = state?.id;
  useEffect(() => {
    revision.current++; busyRef.current = false; setBusy(false); setTarget(null); setLocalRun(null); setMessage(null);
    return () => { revision.current++; };
  }, [state?.id]);
  const parsed = useMemo(() => parseDebugPlanDraft(source), [source]);
  const published = state?.plan ?? null;
  const local = localRun?.sessionId === state?.id ? localRun : null;
  const eventRun = target && published?.runId === target.runId ? published : null;
  const replyRun = target && local?.runId === target.runId ? local : null;
  const terminalReply = replyRun && replyRun.status !== "running" && eventRun?.status === "running" ? replyRun : null;
  const run = terminalReply ?? eventRun ?? replyRun ?? published ?? local;
  const unresolved = Boolean(target && run?.runId !== target.runId);
  const running = run?.status === "running";
  const request = async (value: DebugPlanDesktopCommand, fallback: string) => {
    if (!command || busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage(null);
    const current = ++revision.current;
    try {
      const result = await command(value);
      if (current !== revision.current || sessionId.current !== value.input.sessionId) return;
      if ("run" in result && result.run.runId === value.input.runId && result.run.sessionId === value.input.sessionId) {
        setLocalRun(result.run); setMessage(null);
      }
      else if ("found" in result && result.found === false && value.name === "get_debug_plan") {
        setMessage("尚未找到这次计划，原提交可能仍在等待。请继续查询或重试原计划。");
      }
      else throw new Error("计划状态未确认，请查询状态。");
    } catch (error) {
      if (current === revision.current && sessionId.current === value.input.sessionId)
        setMessage(`${fallback}${error instanceof Error ? ` ${error.message.slice(0, 300)}` : ""}`);
    } finally {
      if (current === revision.current) { busyRef.current = false; setBusy(false); }
    }
  };
  const start = () => {
    if (!state?.active || state.busy || disabled || busyRef.current || running || unresolved || !checked || !parsed.definition) return;
    const input = { sessionId: state.id, runId: crypto.randomUUID(), definition: parsed.definition };
    setTarget(input);
    void request({ name: "start_debug_plan", input }, "提交结果未确认，请先查询状态。");
  };
  const retry = () => {
    if (!target || !state?.active || disabled || busyRef.current || !unresolved) return;
    void request({ name: "start_debug_plan", input: target }, "提交结果未确认，请继续查询原计划。");
  };
  const identity = target ? { sessionId: target.sessionId, runId: target.runId } : (run ? { sessionId: run.sessionId, runId: run.runId } : null);
  if (!command) return null;
  return <details className="debug-plan-runner">
    <summary>操作计划{run && <span data-status={run.status}>{runStatus[run.status]}</span>}</summary>
    <div className="debug-plan-runner-body">
      <label>计划JSON<textarea value={source} maxLength={12000} rows={6} spellCheck={false} aria-label="操作计划JSON"
        placeholder="粘贴操作计划 JSON" disabled={busy || running || unresolved}
        onChange={event => { setSource(event.target.value); setChecked(false); }} /></label>
      <div className="debug-plan-runner-actions">
        <button type="button" className="close-button" disabled={!source.trim() || busy || running || unresolved} onClick={() => setChecked(true)}>校验计划</button>
        <button type="button" className="close-button" disabled={!state?.active || state.busy || disabled || busy || running || unresolved || !checked || !parsed.definition} onClick={start}>运行计划</button>
        {identity && <button type="button" className="close-button" disabled={busy} onClick={() => void request({ name: "get_debug_plan", input: identity }, "查询状态失败。")}>查询状态</button>}
        {unresolved && target && <button type="button" className="close-button" disabled={!state?.active || disabled || busy} onClick={retry}>重试原计划</button>}
        {running && identity && <button type="button" className="close-button" disabled={busy} onClick={() => void request({ name: "cancel_debug_plan", input: identity }, "取消结果未确认，请查询状态。")}>取消计划</button>}
      </div>
      {!state?.active && <p>先开启自动调试，再运行计划。</p>}
      {checked && <p role="status">{parsed.error ?? `已校验：${parsed.definition!.title} · ${parsed.definition!.steps.length}步`}</p>}
      {message && <p role="status">{message}</p>}
      {unresolved && <p role="status">提交状态未确认。查询或重试会沿用原计划编号。</p>}
      {run && <section aria-label="操作计划进度" aria-live="polite">
        <strong>{run.title} · {runStatus[run.status]}</strong>
        {run.message && <p>{run.message}</p>}
        <p>{run.currentStepId ? `当前步骤 ${run.currentStepId}` : "计划进度"} · {run.completedSteps}/{run.totalSteps}{run.finishedAt && run.durationMs !== null ? ` · ${(run.durationMs / 1000).toFixed(1)}秒` : ""}</p>
        <ol>{run.steps.map(item => <li key={item.id} data-status={item.status}><span>{item.id} · {stepStatus[item.status]}</span>{item.message && <p>{item.message}</p>}</li>)}</ol>
      </section>}
    </div>
  </details>;
}

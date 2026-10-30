import type { DebugSessionState } from "./types";

export type DebugProgressPhase = "idle" | "capture" | "execute" | "wait" | "recording" | "completed" | "failed" | "cancelled" | "expired";
export type DebugSessionProgressState = {
  sessionId: string;
  taskId: string | null;
  stepId: number | null;
  action: string | null;
  phase: DebugProgressPhase;
  startedAt: string;
  updatedAt: string;
  stepStartedAt: string | null;
  stepFinishedAt: string | null;
  finishedAt: string | null;
  reason: string | null;
};

export const debugProgressPhaseLabel = (phase: DebugProgressPhase) => ({ idle: "等待调试请求", capture: "正在采集页面",
  execute: "正在执行操作", wait: "等待页面条件", recording: "正在保存证据", completed: "本步完成", failed: "本步失败",
  cancelled: "已停止", expired: "授权已到期" }[phase]);

/** Each session has its own revision; timestamps only order different grants. */
export function acceptDebugSessionUpdate(current: DebugSessionState | null, next: DebugSessionState | null,
  retired: ReadonlySet<string>, allowNewSession = false) {
  if (!next) return !current;
  if (retired.has(next.id)) return false;
  if (next.progress && (next.progress.sessionId !== next.id || next.progress.taskId !== (next.task?.id ?? null))) return false;
  if (!current) return true;
  if (current.id === next.id) return !(current.task && next.task?.id !== current.task.id)
    && !(typeof current.revision === "number" && typeof next.revision === "number" && next.revision <= current.revision)
    && !(current.active === false && next.active);
  if (current.active && !allowNewSession) return false;
  if (current.startedAt && next.startedAt && Date.parse(next.startedAt) <= Date.parse(current.startedAt)) return false;
  return allowNewSession || !current.active;
}

export function debugProgressElapsed(progress: DebugSessionProgressState, now: number) {
  const end = progress.finishedAt ? Date.parse(progress.finishedAt) : now;
  return { sessionMs: Math.max(0, end - Date.parse(progress.startedAt)),
    stepMs: progress.stepStartedAt ? Math.max(0, (progress.stepFinishedAt ? Date.parse(progress.stepFinishedAt) : end) - Date.parse(progress.stepStartedAt)) : 0 };
}

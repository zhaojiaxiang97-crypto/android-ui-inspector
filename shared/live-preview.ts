import type { PixelSize } from "./types";

export const LIVE_PREVIEW_INTERVAL_MS = 2_000;
export const LIVE_PREVIEW_TIMEOUT_MS = 5_000;
export const LIVE_PREVIEW_MAX_PNG_BYTES = 8 * 1024 * 1024;
export const LIVE_PREVIEW_MAX_PIXELS = 16 * 1024 * 1024;

export type LivePreviewStopReason = "closed" | "device-disconnected" | "device-change"
  | "window-closed" | "window-reloaded" | "app-quit";

export type LivePreviewState = {
  sessionId: string | null;
  serial: string | null;
  revision: number;
  status: "stopped" | "running" | "paused";
  activity: "idle" | "capturing" | "waiting";
  intervalMs: number;
  startedAt: string | null;
  updatedAt: string;
  frameCapturedAt: string | null;
  error: string | null;
  stopReason: LivePreviewStopReason | null;
};

// Preview frames have no tree, node selectors, geometry authority or task evidence.
export type LivePreviewFrame = {
  sessionId: string;
  serial: string;
  sequence: number;
  capturedAt: string;
  screenshotDataUrl: string;
  size: PixelSize;
};

export type LivePreviewEvent = {
  state: LivePreviewState;
  // Omitted for a state-only update; null explicitly clears the previous frame.
  frame?: LivePreviewFrame | null;
};

export type LivePreviewApi = {
  startLivePreview: (serial: string) => Promise<LivePreviewEvent>;
  pauseLivePreview: (sessionId: string) => Promise<LivePreviewEvent>;
  resumeLivePreview: (sessionId: string) => Promise<LivePreviewEvent>;
  stopLivePreview: (sessionId?: string) => Promise<LivePreviewEvent>;
  getLivePreview: () => Promise<LivePreviewEvent>;
  onLivePreview: (callback: (event: LivePreviewEvent) => void) => () => void;
};

export function isLivePreviewSerial(value: unknown): value is string {
  return typeof value === "string" && /^[\w.:-]{1,256}$/.test(value);
}

export function isLivePreviewSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,128}$/.test(value);
}

export function livePreviewStatusText(state: LivePreviewState | null): string {
  if (!state) return "正在开启…";
  if (state.status === "paused") return state.error ? "截图失败，已暂停" : "已暂停";
  if (state.status === "stopped") return state.stopReason === "device-disconnected" ? "设备已断开" : "已关闭";
  return state.activity === "waiting" ? "等待采集或调试完成" : "每 2 秒刷新";
}

export function livePreviewTimeLabel(value: string | null | undefined): string {
  if (!value) return "尚未采集";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour12: false }) : "时间未知";
}

// A delayed command reply or frame must not replace a newer event or another device.
export function acceptLivePreviewEvent(previous: LivePreviewEvent | null, incoming: LivePreviewEvent,
  serial: string, sessionId: string): LivePreviewEvent | null {
  if (incoming.state.serial !== serial || incoming.state.sessionId !== sessionId
    || previous && incoming.state.revision <= previous.state.revision) return previous;
  const supplied = incoming.frame;
  const frame = supplied === undefined ? previous?.frame ?? null : supplied;
  if (frame && (frame.serial !== serial || frame.sessionId !== sessionId
    || frame.capturedAt !== incoming.state.frameCapturedAt)) return previous;
  return { state: incoming.state, frame: incoming.state.status === "stopped" ? null : frame };
}

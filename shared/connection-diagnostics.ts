import { z } from "zod";
import type { FastCaptureBackend } from "./types";

export const connectionDiagnosticRequest = z.object({
  requestId: z.string().uuid(), serial: z.string().min(1).max(256).regex(/^[\w.:-]+$/),
  packageName: z.string().max(256).regex(/^[\w]+(?:\.[\w]+)+$/).optional(),
  captureMode: z.enum(["fast", "deep"]).default("fast"),
  backend: z.enum(["uiautomator", "accessibility-helper"]).default("uiautomator"),
  client: z.enum(["desktop", "cli", "mcp"]).default("desktop"),
  timeoutMs: z.number().int().min(1000).max(30_000).default(15_000),
}).strict().refine(value => value.captureMode === "fast" || value.backend === "uiautomator", "Helper 只支持轻量采集。");

export type ConnectionDiagnosticRequest = z.input<typeof connectionDiagnosticRequest>;
export type DiagnosticCheckId = "adb" | "device" | "authorization" | "screen" | "foreground" | "debuggable" | "helper" | "sdk" | "automation";
export type DiagnosticObservation = { status: "pass" | "fail" | "unknown"; code: string; detail: string; suggestion: string | null };
export type ConnectionDiagnosticCheck = DiagnosticObservation & { id: DiagnosticCheckId; label: string; required: boolean; checkedAt: string | null };
export type ConnectionDiagnosticReport = {
  version: 1; requestId: string; serial: string; expectedPackageName: string | null;
  captureMode: "fast" | "deep"; backend: FastCaptureBackend; client: "desktop" | "cli" | "mcp";
  startedAt: string; completedAt: string; elapsedMs: number;
  status: "completed" | "timed_out" | "cancelled" | "identity_changed";
  outcome: "ready" | "blocked" | "unknown";
  identity: { serial: string; transportId: string | null; packageName: string | null; component: string | null; windowId: string | null };
  checks: ConnectionDiagnosticCheck[];
};

export type ConnectionDiagnosticTarget = Pick<ConnectionDiagnosticRequest, "serial" | "packageName" | "captureMode" | "backend">;

export function connectionDiagnosticKey(target: ConnectionDiagnosticTarget) {
  return JSON.stringify([target.serial, target.packageName ?? null, target.captureMode ?? "fast", target.backend ?? "uiautomator"]);
}

export function matchesConnectionDiagnostic(report: ConnectionDiagnosticReport, request: ConnectionDiagnosticRequest): boolean {
  return report.requestId === request.requestId && report.serial === request.serial
    && report.expectedPackageName === (request.packageName ?? null)
    && report.captureMode === (request.captureMode ?? "fast") && report.backend === (request.backend ?? "uiautomator");
}

export function diagnosticOutcome(checks: ConnectionDiagnosticCheck[]): ConnectionDiagnosticReport["outcome"] {
  const required = checks.filter(check => check.required);
  return required.some(check => check.status === "fail") ? "blocked"
    : required.every(check => check.status === "pass") ? "ready" : "unknown";
}

export function automationDiagnosticObservation(input: {
  shared: boolean; session: { active: boolean; serial: string; packageName: string } | null;
  serial: string; packageName?: string;
}): DiagnosticObservation {
  if (input.session?.active) {
    if (input.session.serial !== input.serial || input.packageName && input.session.packageName !== input.packageName)
      return { status: "fail", code: "automation-identity", detail: "自动调试授权属于其他设备或 App。", suggestion: "在桌面中结束旧会话，再授权当前设备和 App。" };
    return { status: "pass", code: "automation-connected", detail: "已连接桌面自动调试，并核对授权设备与 App。", suggestion: null };
  }
  return { status: "fail", code: "automation-inactive", detail: input.shared ? "已共享静态快照，实时采集尚未授权。" : "没有可用的桌面自动调试连接。",
    suggestion: "打开桌面软件，选择当前设备与 Debug App，再显式开启自动调试；静态查询只需共享快照。" };
}

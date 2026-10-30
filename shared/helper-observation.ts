import { z } from "zod";
import { assessCaptureGeometry } from "./screen-coordinates";
import type { DisplayFrame, UiSnapshot } from "./types";

const integer = z.number().int().nonnegative().safe();
const frameSchema = z.object({ width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384),
  rotation: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }).strict();
const windowSchema = z.object({ id: z.string().regex(/^\d{1,10}$/), type: z.enum(["application", "input_method", "system", "accessibility_overlay", "split_screen_divider", "unknown"]),
  layer: z.number().int().safe(), active: z.boolean(), focused: z.boolean(),
  bounds: z.object({ x: z.number().int().safe(), y: z.number().int().safe(), width: integer, height: integer }).strict(),
  packageName: z.string().max(512), rootAvailable: z.boolean() }).strict();
export const helperObservationSchema = z.object({
  protocolVersion: z.literal(1), serviceInstanceId: z.uuid(), captureId: z.uuid(), windowId: z.string().regex(/^\d{1,10}$/), packageName: z.string().min(1).max(512),
  timing: z.object({ startedAtMs: integer, hierarchyStartedAtMs: integer, hierarchyCompletedAtMs: integer,
    screenshotStartedAtMs: integer, screenshotCompletedAtMs: integer, completedAtMs: integer }).strict(),
  screenshotTiming: z.literal("after-hierarchy"), lossless: z.literal(true), complete: z.literal(true), visibility: z.literal("explicit-clipped"),
  displayBefore: frameSchema, displayAfter: frameSchema,
  windowsBefore: z.array(windowSchema).min(1).max(16), windowsAfter: z.array(windowSchema).min(1).max(16),
}).strict();
export type HelperObservationEvidence = z.infer<typeof helperObservationSchema>;
export type HelperWindowEvidence = HelperObservationEvidence["windowsBefore"][number];
const sameFrame = (a: DisplayFrame, b: DisplayFrame) => a.width === b.width && a.height === b.height && a.rotation === b.rotation;
const sameWindows = (a: HelperWindowEvidence[], b: HelperWindowEvidence[]) => {
  const canonical = (windows: HelperWindowEvidence[]) => windows.map(w => [w.id, w.type, w.layer, w.active, w.focused, w.bounds.x, w.bounds.y,
    w.bounds.width, w.bounds.height, w.packageName, w.rootAvailable]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
};

/** Evidence remains valid when report exports omit screenshot bytes. It never grants input on its own. */
export function isHelperObservationEvidence(value: unknown): value is HelperObservationEvidence {
  const result = helperObservationSchema.safeParse(value);
  if (!result.success) return false;
  const e = result.data, t = e.timing;
  const times = [t.startedAtMs, t.hierarchyStartedAtMs, t.hierarchyCompletedAtMs, t.screenshotStartedAtMs, t.screenshotCompletedAtMs, t.completedAtMs];
  if (times.some((time, i) => i > 0 && time < times[i - 1]) || t.completedAtMs - t.startedAtMs > 30_000
    || !sameFrame(e.displayBefore, e.displayAfter) || !sameWindows(e.windowsBefore, e.windowsAfter)) return false;
  const windows = e.windowsBefore, focused = windows.filter(w => w.focused);
  return new Set(windows.map(w => w.id)).size === windows.length && windows.every(w => w.rootAvailable && w.bounds.width > 0 && w.bounds.height > 0)
    && focused.length === 1 && focused[0].id === e.windowId && focused[0].active && focused[0].type === "application"
    && focused[0].packageName === e.packageName && focused[0].bounds.width > 0 && focused[0].bounds.height > 0;
}

function safeWindows(e: HelperObservationEvidence) {
  const target = e.windowsBefore.find(w => w.id === e.windowId)!;
  const b = target.bounds;
  return e.windowsBefore.every(w => {
    if (w.id === target.id) return true;
    const r = w.bounds;
    // Lower windows cannot obscure this focused window. Unknown window types/layers do not prove that.
    if (w.type === "unknown" || w.focused || w.active) return false;
    if (w.layer < target.layer) return true;
    return r.width > 0 && r.height > 0 && (r.x + r.width <= b.x || b.x + b.width <= r.x || r.y + r.height <= b.y || b.y + b.height <= r.y);
  });
}

const requiredFields = ["index", "class", "package", "text", "resource-id", "content-desc", "bounds", "bounds-screen", "visible-bounds", "window-id",
  "visible-to-user", "enabled", "clickable", "focusable", "focused", "scrollable", "selected"];
const flags = ["visible-to-user", "enabled", "clickable", "focusable", "focused", "scrollable", "selected"] as const;
const parseBounds = (value: string) => {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value);
  if (!match) return null;
  const numbers = match.slice(1).map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : null;
};

export function hasCompleteHelperTree(snapshot: UiSnapshot): boolean {
  const e = snapshot.helperObservation;
  if (!isHelperObservationEvidence(e) || !snapshot.root) return false;
  const window = e.windowsBefore.find(w => w.id === e.windowId)!;
  const frame = e.displayAfter;
  const windowClip = [Math.max(0, window.bounds.x), Math.max(0, window.bounds.y), Math.min(frame.width, window.bounds.x + window.bounds.width),
    Math.min(frame.height, window.bounds.y + window.bounds.height)];
  const pending = [{ node: snapshot.root, parentVisible: true, clip: windowClip }];
  for (let i = 0; i < pending.length; i++) {
    if (pending.length > 5000) return false;
    const { node, parentVisible, clip } = pending[i], a = node.attributes;
    if (!a || requiredFields.some(key => typeof a[key] !== "string") || flags.some(key => a[key] !== "true" && a[key] !== "false")
      || node.package !== e.packageName || a.package !== e.packageName || a["window-id"] !== e.windowId || !/^\d+$/.test(a.index)
      || !a.class || node.className !== a.class || node.index !== Number(a.index)) return false;
    const bounds = parseBounds(a["visible-bounds"]), original = parseBounds(a["bounds-screen"]), parsed = node.bounds;
    if (!bounds || !original || !parsed || a.bounds !== a["visible-bounds"] || bounds[0] !== parsed.left || bounds[1] !== parsed.top
      || bounds[2] !== parsed.right || bounds[3] !== parsed.bottom || bounds[2] < bounds[0] || bounds[3] < bounds[1]) return false;
    const visible = a["visible-to-user"] === "true";
    // Android can report inverted screen rectangles for clipped offscreen nodes.
    // Preserve that diagnostic fact only when explicitly hidden with an empty hit area.
    if ((original[2] < original[0] || original[3] < original[1]) && (visible || bounds.some(value => value !== 0))) return false;
    if (node.visibleToUser !== visible || node.visibilityEvidence !== (visible ? "visible" : "hidden")
      || node.enabled !== (a.enabled === "true") || node.clickable !== (a.clickable === "true") || node.scrollable !== (a.scrollable === "true")
      || node.focusable !== (a.focusable === "true") || node.focused !== (a.focused === "true") || node.selected !== (a.selected === "true")
      || node.text !== (a.text || null) || node.resourceId !== (a["resource-id"] || null) || node.contentDesc !== (a["content-desc"] || null)) return false;
    if (visible && (!parentVisible || bounds[0] < clip[0] || bounds[1] < clip[1] || bounds[2] > clip[2] || bounds[3] > clip[3]
      || bounds[0] < 0 || bounds[1] < 0 || bounds[2] > frame.width || bounds[3] > frame.height || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]
      || bounds[0] < original[0] || bounds[1] < original[1] || bounds[2] > original[2] || bounds[3] > original[3]
      || bounds[0] < window.bounds.x || bounds[1] < window.bounds.y || bounds[2] > window.bounds.x + window.bounds.width
      || bounds[3] > window.bounds.y + window.bounds.height)) return false;
    pending.push(...node.children.map(child => ({ node: child, parentVisible: visible, clip: node.scrollable ? bounds : clip })));
  }
  return pending.length === snapshot.nodeCount;
}

export function hasActionableHelperEvidence(snapshot: UiSnapshot): boolean {
  const e = snapshot.helperObservation;
  return snapshot.inspectionSource === "accessibility-helper" && isHelperObservationEvidence(e) && hasCompleteHelperTree(snapshot)
    && safeWindows(e) && assessCaptureGeometry(snapshot.captureGeometry).status === "checked"
    && !!snapshot.captureGeometry?.afterScreenshot && !!snapshot.captureGeometry.beforeScreenshot
    && sameFrame(snapshot.captureGeometry.afterScreenshot, e.displayAfter) && sameFrame(snapshot.captureGeometry.beforeScreenshot, e.displayBefore);
}

export function assertActionableHelperSnapshot(snapshot: UiSnapshot): void {
  if (snapshot.inspectionSource !== "accessibility-helper") return;
  if (!hasActionableHelperEvidence(snapshot) || !snapshot.screenshotDataUrl?.startsWith("data:image/png;base64,"))
    throw new Error("Helper 缺少完整的窗口、可见区域或无损截图证据；不会自动换源，请重新观察，或显式切换 UIAutomator。");
}

export function assertSameHelperServiceEvidence(before: HelperObservationEvidence, after: HelperObservationEvidence): void {
  if (!isHelperObservationEvidence(before) || !isHelperObservationEvidence(after)
    || before.serviceInstanceId !== after.serviceInstanceId || before.packageName !== after.packageName || before.captureId === after.captureId
    || after.timing.startedAtMs < before.timing.completedAtMs)
    throw new Error("Helper 服务发生变化，或观察不是新采集；已停止操作，请重新观察。");
}

export function assertSameHelperObservationEvidence(before: HelperObservationEvidence, after: HelperObservationEvidence): void {
  assertSameHelperServiceEvidence(before, after);
  if (before.windowId !== after.windowId || !sameFrame(before.displayAfter, after.displayBefore))
    throw new Error("Helper 窗口或显示器发生变化；已停止操作，请重新观察。");
}

export function assertSameHelperObservationSource(before: UiSnapshot, after: UiSnapshot): void {
  if (before.inspectionSource !== "accessibility-helper" && after.inspectionSource !== "accessibility-helper") return;
  if (before.inspectionSource !== after.inspectionSource || !before.helperObservation || !after.helperObservation)
    throw new Error("观察来源已变化，不能跨采集后端复用控件或坐标；请重新观察。");
  assertSameHelperObservationEvidence(before.helperObservation, after.helperObservation);
}

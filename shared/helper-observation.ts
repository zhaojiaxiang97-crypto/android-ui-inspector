import { z } from "zod";
import { helperObservationTimingSchema } from "./helper-observation-timing";
import { hasTransientHelperDiagnostics, hasWindowTransitionHelperDiagnostics, hasSystemOnlyHelperFocusGapDiagnostics,
  helperObservationDiagnosticsSchema } from "./helper-observation-diagnostics";
import { assessCaptureGeometry, validBounds, type ScreenRect } from "./screen-coordinates";
import type { DisplayFrame, UiNode, UiSnapshot } from "./types";
import type { HelperRecoveryCandidateReason, HelperRecoveryDiagnostics, HelperRecoverySourceReason, HelperRecoverySection } from "./helper-recovery-diagnostics";

const integer = z.number().int().nonnegative().safe();
const frameSchema = z.object({ width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384),
  rotation: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }).strict();
const windowSchema = z.object({ id: z.string().regex(/^\d{1,10}$/), type: z.enum(["application", "input_method", "system", "accessibility_overlay", "split_screen_divider", "unknown"]),
  layer: z.number().int().safe(), active: z.boolean(), focused: z.boolean(),
  bounds: z.object({ x: z.number().int().safe(), y: z.number().int().safe(), width: integer, height: integer }).strict(),
  packageName: z.string().max(512), rootAvailable: z.boolean() }).strict();
export const helperObservationSchema = z.object({
  protocolVersion: z.literal(1), serviceInstanceId: z.uuid(), captureId: z.uuid(), windowId: z.string().regex(/^\d{1,10}$/), packageName: z.string().min(1).max(512),
  timing: helperObservationTimingSchema,
  screenshotTiming: z.literal("after-hierarchy"), lossless: z.literal(true), complete: z.literal(true), visibility: z.literal("explicit-clipped"),
  displayBefore: frameSchema, displayAfter: frameSchema,
  windowsBefore: z.array(windowSchema).min(1).max(16), windowsAfter: z.array(windowSchema).min(1).max(16),
  diagnostics: helperObservationDiagnosticsSchema.optional(),
}).strict();
export type HelperObservationEvidence = z.infer<typeof helperObservationSchema>;
export type HelperWindowEvidence = HelperObservationEvidence["windowsBefore"][number];
const helperRecoveryEvidenceSchema = helperObservationSchema.extend({ complete: z.literal(false), diagnostics: helperObservationDiagnosticsSchema,
  packageName: z.string().max(512), windowId: z.union([z.literal(""), helperObservationSchema.shape.windowId]) });
/** Rejected metadata only: this type never contains a tree, image, or actionable snapshot. */
export type HelperRecoveryEvidence = z.infer<typeof helperRecoveryEvidenceSchema>;
const sameFrame = (a: DisplayFrame, b: DisplayFrame) => a.width === b.width && a.height === b.height && a.rotation === b.rotation;
const sameWindows = (a: HelperWindowEvidence[], b: HelperWindowEvidence[]) => {
  const canonical = (windows: HelperWindowEvidence[]) => windows.map(w => [w.id, w.type, w.layer, w.active, w.focused, w.bounds.x, w.bounds.y,
    w.bounds.width, w.bounds.height, w.packageName, w.rootAvailable]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
};

/** Rejected metadata only: an authorized focus may move horizontally or finish expanding to the display during navigation. */
export function isHelperWindowMotionRecoveryEvidence(e: HelperRecoveryEvidence, packageName: string, frame: DisplayFrame): boolean {
  return helperWindowMotionReason(e, packageName, frame) === "accepted";
}

function helperWindowMotionReason(e: HelperRecoveryEvidence, packageName: string, frame: DisplayFrame): HelperRecoveryCandidateReason {
  if (!packageName || e.packageName !== packageName || e.diagnostics.reasons.length !== 1
    || e.diagnostics.reasons[0].code !== "window_inventory_changed"
    || !sameFrame(e.displayBefore, frame) || !sameFrame(e.displayAfter, frame)) return "motion_context_invalid";
  const before = e.windowsBefore.find(window => window.id === e.windowId), after = e.windowsAfter.find(window => window.id === e.windowId);
  if (!before || !after) return "motion_focus_missing";
  const horizontal = before.bounds.x !== after.bounds.x && before.bounds.y === after.bounds.y
    && before.bounds.width === after.bounds.width && before.bounds.height === after.bounds.height;
  // Measured entry animation: settles at x=0 and gains exactly one pixel of width. Failed metadata only.
  const settlesPixelWidth = before.bounds.x > 0 && after.bounds.x === 0 && before.bounds.y === after.bounds.y
    && after.bounds.width === before.bounds.width + 1 && before.bounds.height === after.bounds.height;
  // Only the measured ending shape is added: a smaller, intersecting window reaches the exact full display.
  // Intermediate arbitrary resize, shrink and movement of other windows still fail closed below.
  const expandsToDisplay = after.bounds.x === 0 && after.bounds.y === 0
    && after.bounds.width === frame.width && after.bounds.height === frame.height
    && (before.bounds.width !== after.bounds.width || before.bounds.height !== after.bounds.height);
  if (!horizontal && !settlesPixelWidth && !expandsToDisplay) return "motion_not_horizontal";
  for (const windows of [e.windowsBefore, e.windowsAfter]) {
    if (new Set(windows.map(window => window.id)).size !== windows.length || !windows.every(window => {
      const b = window.bounds, focus = window.id === e.windowId;
      return window.rootAvailable && !!window.packageName && b.width > 0 && b.height > 0
        && Number.isSafeInteger(b.x + b.width) && Number.isSafeInteger(b.y + b.height)
        && b.y >= 0 && b.y + b.height <= frame.height
        && (focus ? window.type === "application" && window.packageName === packageName && window.active && window.focused
          && b.width <= frame.width && (b.x < frame.width && b.x + b.width > 0
            || settlesPixelWidth && windows === e.windowsBefore && b.x === frame.width)
          : !window.active && !window.focused && (window.type === "system" || window.type === "application" && window.packageName === packageName)
            && b.x >= 0 && b.x + b.width <= frame.width);
    })) return "motion_inventory_invalid";
  }
  // Every field of every other window, and every non-geometry field of the focus, must stay identical.
  return sameWindows(e.windowsBefore, e.windowsAfter.map(window => window.id === e.windowId ? { ...window, bounds: before.bounds } : window))
    ? "accepted" : "motion_other_fields_changed";
}

/** Validate both inventories independently; navigation may replace the focused window between them. */
export function getHelperRecoveryEvidence(value: unknown, packageName: string, frame: DisplayFrame): HelperRecoveryEvidence | undefined {
  return assessHelperRecoveryEvidence(value, packageName, frame).evidence;
}

function recoveryWindowChanges(e: HelperRecoveryEvidence, packageName: string): HelperRecoveryDiagnostics["windows"] {
  type Change = NonNullable<HelperRecoveryDiagnostics["windows"]>["changes"][number];
  const role = (window: HelperWindowEvidence): NonNullable<Change["beforeRole"]> => window.type === "application"
    ? packageName && window.packageName === packageName ? "authorized_application" : "other_application"
    : window.type === "system" ? "system" : window.type === "input_method" ? "input_method" : "other";
  const changes: Change[] = [];
  for (const before of e.windowsBefore) {
    const after = e.windowsAfter.find(window => window.id === before.id);
    if (!after) { changes.push({ kind: "removed", beforeRole: role(before), fields: [], beforeBounds: before.bounds }); continue; }
    const fields: Change["fields"] = [];
    for (const field of ["type", "layer", "active", "focused"] as const) if (before[field] !== after[field]) fields.push(field);
    if (before.packageName !== after.packageName) fields.push("package");
    if (before.rootAvailable !== after.rootAvailable) fields.push("root");
    for (const field of ["x", "y", "width", "height"] as const) if (before.bounds[field] !== after.bounds[field]) fields.push(field);
    if (fields.length) changes.push({ kind: "changed", beforeRole: role(before), afterRole: role(after), fields,
      beforeBounds: before.bounds, afterBounds: after.bounds });
  }
  for (const after of e.windowsAfter) if (!e.windowsBefore.some(window => window.id === after.id))
    changes.push({ kind: "added", afterRole: role(after), fields: [], afterBounds: after.bounds });
  return { beforeCount: e.windowsBefore.length, afterCount: e.windowsAfter.length,
    beforeFocusCount: e.windowsBefore.filter(window => window.focused).length, afterFocusCount: e.windowsAfter.filter(window => window.focused).length,
    beforeActiveCount: e.windowsBefore.filter(window => window.active).length, afterActiveCount: e.windowsAfter.filter(window => window.active).length, changes };
}

/** This diagnosis accompanies a rejected read; it never authorizes or publishes the failed snapshot. */
export function assessHelperRecoveryEvidence(value: unknown, packageName: string, frame: DisplayFrame): {
  evidence?: HelperRecoveryEvidence; diagnostics: HelperRecoveryDiagnostics;
} {
  const parsed = helperRecoveryEvidenceSchema.safeParse(value);
  if (!parsed.success) {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const groups: [HelperRecoverySection, (keyof typeof helperRecoveryEvidenceSchema.shape)[]][] = [
      ["identity", ["protocolVersion", "serviceInstanceId", "captureId", "windowId", "packageName"]],
      ["timing", ["timing", "screenshotTiming"]], ["display", ["displayBefore", "displayAfter"]],
      ["windows", ["windowsBefore", "windowsAfter"]], ["diagnostics", ["diagnostics"]], ["metadata", ["complete", "lossless", "visibility"]],
    ];
    const invalidSections = groups.filter(([, keys]) => keys.some(key => !helperRecoveryEvidenceSchema.shape[key].safeParse(raw[key]).success)).map(([section]) => section);
    if (Object.keys(raw).some(key => !Object.prototype.hasOwnProperty.call(helperRecoveryEvidenceSchema.shape, key))) invalidSections.push("unknown_fields");
    return { diagnostics: { version: 1, candidate: "metadata_invalid", ...(invalidSections.length ? { invalidSections } : {}) } };
  }
  const e = parsed.data;
  const finish = (candidate: HelperRecoveryCandidateReason) => ({ ...(candidate === "accepted" ? { evidence: e } : {}),
    diagnostics: { version: 1 as const, candidate, windows: recoveryWindowChanges(e, packageName) } });
  if (!sameFrame(e.displayBefore, frame) || !sameFrame(e.displayAfter, frame)) return finish("display_mismatch");
  const changedBounds = e.windowsBefore.some(window => {
    const after = e.windowsAfter.find(after => after.id === window.id);
    return after && (window.bounds.x !== after.bounds.x || window.bounds.y !== after.bounds.y
      || window.bounds.width !== after.bounds.width || window.bounds.height !== after.bounds.height);
  });
  // Bounds motion has its own after-input gate; it cannot inherit generic inventory-change recovery.
  if (changedBounds) return finish(helperWindowMotionReason(e, packageName, frame));
  const emptyIdentity = e.packageName === "" && e.windowId === "";
  const systemOnly = (windows: HelperWindowEvidence[]) => windows.every(window => window.type === "system" && !window.active && !window.focused);
  const beforeSystemOnly = systemOnly(e.windowsBefore), afterSystemOnly = systemOnly(e.windowsAfter);
  const focusTransition = hasWindowTransitionHelperDiagnostics(e.diagnostics);
  const arriving = e.windowsAfter.find(window => window.focused);
  // A measured Back gap can end while its authorized window is still partly left of the display.
  // Other system windows may only change layer when the new focus enters the stack.
  const partialArrival = focusTransition && emptyIdentity && beforeSystemOnly && !!arriving
    && sameWindows(e.windowsBefore, e.windowsAfter.filter(window => window !== arriving).map(window => ({
      ...window, layer: e.windowsBefore.find(before => before.id === window.id)?.layer ?? window.layer,
    })));
  const validInventory = (windows: HelperWindowEvidence[], allowPartial = false) => new Set(windows.map(window => window.id)).size === windows.length
    && windows.every(window => window.rootAvailable && window.type !== "unknown" && !!window.packageName
      && window.bounds.width > 0 && window.bounds.height > 0
      && Number.isSafeInteger(window.bounds.x + window.bounds.width) && Number.isSafeInteger(window.bounds.y + window.bounds.height)
      && window.bounds.y >= 0 && (window.bounds.x >= 0 && window.bounds.x + window.bounds.width <= frame.width
        || allowPartial && window === arriving && window.type === "application" && window.active && window.focused
          && (!packageName || window.packageName === packageName) && window.bounds.width <= frame.width
          && window.bounds.x < 0 && window.bounds.x + window.bounds.width > 0)
      && window.bounds.y + window.bounds.height <= frame.height);
  if (!validInventory(e.windowsBefore)) return finish("inventory_before_invalid");
  if (!validInventory(e.windowsAfter, partialArrival)) return finish("inventory_after_invalid");
  const authorized = (windows: HelperWindowEvidence[], strict: boolean) => {
    const focused = windows.filter(window => window.focused);
    if (focused.length !== 1 || !focused[0].active || focused[0].type !== "application"
      || packageName && focused[0].packageName !== packageName) return false;
    return windows.every(window => (!window.active || window.id === focused[0].id)
      && (!strict || (window.type === "system" || window.type === "application" && window.packageName === focused[0].packageName)));
  };
  if (hasSystemOnlyHelperFocusGapDiagnostics(e.diagnostics))
    return finish(emptyIdentity && beforeSystemOnly && afterSystemOnly && sameWindows(e.windowsBefore, e.windowsAfter) ? "accepted" : "system_gap_invalid");
  // Empty metadata remains empty. The error constructor checks shape only; a recovery caller supplies its existing package anchor.
  if (focusTransition && emptyIdentity)
    return finish(beforeSystemOnly && authorized(e.windowsAfter, true) && !sameWindows(e.windowsBefore, e.windowsAfter) ? "accepted" : "empty_identity_transition_invalid");
  if (!hasTransientHelperDiagnostics(e.diagnostics)) return finish("diagnostics_not_transient");
  if (e.packageName !== packageName || !e.packageName || !e.windowId) return finish("identity_mismatch");
  if (!authorized(e.windowsBefore, focusTransition)) return finish("focus_before_invalid");
  if (focusTransition) {
    const after = e.windowsAfter;
    const unfocusedAuthorized = !after.some(window => window.focused) && after.filter(window => window.active).length <= 1
      && after.some(window => window.type === "application" && window.packageName === packageName)
      && after.every(window => window.type === "system" && !window.active || window.type === "application" && window.packageName === packageName);
    if (!afterSystemOnly && !unfocusedAuthorized) return finish("transition_focus_after_invalid");
  } else if (!authorized(e.windowsAfter, false)) return finish("focus_after_invalid");
  if (e.windowsBefore.find(window => window.focused)!.id !== e.windowId) return finish("focused_id_mismatch");
  // A claimed inventory change must match reality. Unexplained changes also stay rejected.
  if (sameWindows(e.windowsBefore, e.windowsAfter) === e.diagnostics.reasons.some(reason => reason.code === "window_inventory_changed"))
    return finish("inventory_claim_mismatch");
  return finish("accepted");
}

/** A rejected read can advance freshness, but never stand in for a successful observation. */
export function isFreshHelperRecoveryEvidence(previous: HelperObservationEvidence | HelperRecoveryEvidence,
  next: HelperObservationEvidence | HelperRecoveryEvidence, expectedPackage = previous.packageName): boolean {
  return helperRecoverySourceReason(previous, next, expectedPackage) === "accepted";
}

/** A read-only wait may recover missing children only while its entire trusted window inventory stays fixed. */
export function isStableHelperChildRecoveryEvidence(previous: HelperObservationEvidence | HelperRecoveryEvidence,
  next: HelperObservationEvidence | HelperRecoveryEvidence, expectedPackage: string): boolean {
  const failed = next.complete ? previous : next;
  return !failed.complete && failed.diagnostics.reasons.length === 1 && failed.diagnostics.reasons[0].code === "child_unavailable"
    && isFreshHelperRecoveryEvidence(previous, next, expectedPackage) && previous.windowId === next.windowId
    && sameWindows(previous.windowsAfter, next.windowsBefore) && sameWindows(next.windowsBefore, next.windowsAfter);
}

export function helperRecoverySourceReason(previous: HelperObservationEvidence | HelperRecoveryEvidence,
  next: HelperObservationEvidence | HelperRecoveryEvidence, expectedPackage = previous.packageName): HelperRecoverySourceReason {
  if (!expectedPackage) return "package_anchor_missing";
  const previousValid = previous.complete ? isHelperObservationEvidence(previous)
    : !!getHelperRecoveryEvidence(previous, expectedPackage, previous.displayAfter);
  const nextValid = next.complete ? isHelperObservationEvidence(next)
    : !!getHelperRecoveryEvidence(next, expectedPackage, next.displayAfter);
  const inScope = (e: HelperObservationEvidence | HelperRecoveryEvidence) => e.packageName === expectedPackage
    || !e.complete && e.packageName === "" && e.windowId === "";
  if (!previousValid) return "previous_invalid";
  if (!nextValid) return "next_invalid";
  if (!inScope(previous) || !inScope(next)) return "package_changed";
  if (!sameFrame(previous.displayAfter, next.displayBefore)) return "display_changed";
  if (previous.serviceInstanceId !== next.serviceInstanceId) return "service_changed";
  if (previous.captureId === next.captureId) return "capture_reused";
  return next.timing.startedAtMs >= previous.timing.completedAtMs ? "accepted" : "capture_time_regressed";
}

/** Evidence remains valid when report exports omit screenshot bytes. It never grants input on its own. */
export function isHelperObservationEvidence(value: unknown): value is HelperObservationEvidence {
  const result = helperObservationSchema.safeParse(value);
  if (!result.success) return false;
  const e = result.data, t = e.timing;
  const times = [t.startedAtMs, t.hierarchyStartedAtMs, t.hierarchyCompletedAtMs, t.screenshotStartedAtMs, t.screenshotCompletedAtMs, t.completedAtMs];
  if (e.diagnostics?.reasons.length || times.some((time, i) => i > 0 && time < times[i - 1]) || t.completedAtMs - t.startedAtMs > 30_000
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

/** Complete capture evidence does not imply that any particular region is unobscured. */
export function hasCompleteHelperObservationEvidence(snapshot: UiSnapshot): boolean {
  const e = snapshot.helperObservation;
  return snapshot.inspectionSource === "accessibility-helper" && isHelperObservationEvidence(e) && hasCompleteHelperTree(snapshot)
    && assessCaptureGeometry(snapshot.captureGeometry).status === "checked"
    && !!snapshot.captureGeometry?.afterScreenshot && !!snapshot.captureGeometry.beforeScreenshot
    && sameFrame(snapshot.captureGeometry.afterScreenshot, e.displayAfter) && sameFrame(snapshot.captureGeometry.beforeScreenshot, e.displayBefore);
}

/** Unknown windows or competing active/focused windows invalidate every action and assertion. */
export function hasSafeHelperObservationContext(snapshot: UiSnapshot): boolean {
  return hasCompleteHelperObservationEvidence(snapshot) && snapshot.helperObservation!.windowsBefore.every(window =>
    window.type !== "unknown" && (window.id === snapshot.helperObservation!.windowId || (!window.active && !window.focused)));
}

export function assertSafeHelperObservationSnapshot(snapshot: UiSnapshot): void {
  if (snapshot.inspectionSource !== "accessibility-helper") return;
  if (!hasSafeHelperObservationContext(snapshot) || !snapshot.screenshotDataUrl?.startsWith("data:image/png;base64,"))
    throw new Error("Helper 缺少完整的窗口、可见区域或无损截图证据，或存在未知/竞争焦点窗口；不会自动换源，请重新观察。");
}

export type HelperRegionSafety = "clear" | "occluded" | "unknown";

/** Validate once per observation when inspecting many nodes. No system-window whitelist. */
export function createHelperRegionSafety(snapshot: UiSnapshot): (region: ScreenRect | null | undefined) => HelperRegionSafety {
  if (snapshot.inspectionSource !== "accessibility-helper") return () => "clear";
  if (!hasSafeHelperObservationContext(snapshot)) return () => "unknown";
  const evidence = snapshot.helperObservation!, frame = evidence.displayAfter;
  const target = evidence.windowsBefore.find(window => window.id === evidence.windowId)!;
  return region => {
    if (!region || !validBounds(region) || ![region.left, region.top, region.right, region.bottom].every(Number.isSafeInteger)
      || region.left < 0 || region.top < 0 || region.right > frame.width || region.bottom > frame.height
      || region.left < target.bounds.x || region.top < target.bounds.y
      || region.right > target.bounds.x + target.bounds.width || region.bottom > target.bounds.y + target.bounds.height) return "unknown";
    return evidence.windowsBefore.some(window => {
      const r = window.bounds;
      return window.id !== target.id && window.layer >= target.layer && r.x < region.right && r.x + r.width > region.left
        && r.y < region.bottom && r.y + r.height > region.top;
    }) ? "occluded" : "clear";
  };
}

export function helperRegionSafety(snapshot: UiSnapshot, region: ScreenRect | null | undefined): HelperRegionSafety {
  return createHelperRegionSafety(snapshot)(region);
}

/** Hidden nodes may be covered, rather than absent. Their original on-screen rectangle remains relevant to assertions. */
export function createHelperNodeRegionSafety(snapshot: UiSnapshot): (node: UiNode) => HelperRegionSafety {
  if (snapshot.inspectionSource !== "accessibility-helper") return () => "clear";
  if (!hasSafeHelperObservationContext(snapshot)) return () => "unknown";
  const safety = createHelperRegionSafety(snapshot), evidence = snapshot.helperObservation!, frame = evidence.displayAfter;
  const target = evidence.windowsBefore.find(window => window.id === evidence.windowId)!.bounds;
  return node => {
    if (node.visibleToUser && node.visibilityEvidence !== "hidden") return safety(node.bounds);
    const raw = node.attributes?.["bounds-screen"], original = raw && parseBounds(raw);
    if (!original) return "unknown";
    const region = { left: Math.max(0, target.x, original[0]), top: Math.max(0, target.y, original[1]),
      right: Math.min(frame.width, target.x + target.width, original[2]), bottom: Math.min(frame.height, target.y + target.height, original[3]) };
    return validBounds(region) ? safety(region) : "clear";
  };
}

export function helperNodeRegionSafety(snapshot: UiSnapshot, node: UiNode): HelperRegionSafety {
  return createHelperNodeRegionSafety(snapshot)(node);
}

export type HelperPartialVisibilityResult = { status: "exposed" | "occluded" | "unknown"; regions: ScreenRect[] };
const PARTIAL_REGION_LIMIT = 256;
const partialRectValid = (rect: ScreenRect) => validBounds(rect)
  && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isSafeInteger);
function intersectPartialRects(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  const rect = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return validBounds(rect) ? rect : null;
}
function subtractPartialRect(region: ScreenRect, cover: ScreenRect): ScreenRect[] {
  const hit = intersectPartialRects(region, cover);
  if (!hit) return [region];
  return [
    { left: region.left, top: region.top, right: region.right, bottom: hit.top },
    { left: region.left, top: hit.bottom, right: region.right, bottom: region.bottom },
    { left: region.left, top: hit.top, right: hit.left, bottom: hit.bottom },
    { left: hit.right, top: hit.top, right: region.right, bottom: hit.bottom },
  ].filter(validBounds);
}

/** Read-only geometry, never strict clear/input/absence or proof of rendered text and playback. */
export function createHelperNodePartialVisibility(snapshot: UiSnapshot): (node: UiNode) => HelperPartialVisibilityResult {
  const unknown = (): HelperPartialVisibilityResult => ({ status: "unknown", regions: [] });
  if (snapshot.inspectionSource !== "accessibility-helper" || !hasSafeHelperObservationContext(snapshot)) return unknown;
  const evidence = snapshot.helperObservation!, frame = evidence.displayAfter;
  const target = evidence.windowsBefore.find(window => window.id === evidence.windowId)!;
  const toRect = (window: HelperWindowEvidence) => ({ left: window.bounds.x, top: window.bounds.y,
    right: window.bounds.x + window.bounds.width, bottom: window.bounds.y + window.bounds.height });
  if (evidence.windowsBefore.some(window => !partialRectValid(toRect(window)))) return unknown;
  const windowClip = intersectPartialRects({ left: 0, top: 0, right: frame.width, bottom: frame.height }, toRect(target));
  if (!windowClip) return unknown;
  const covers = evidence.windowsBefore.filter(window => window.id !== target.id && window.layer >= target.layer).map(toRect);
  const nodeClips = new Map<UiNode, ScreenRect | null>(), ids = new Set<string>();
  const pending: Array<{ node: UiNode; clip: ScreenRect | null }> = [{ node: snapshot.root!, clip: windowClip }];
  while (pending.length) {
    const { node, clip } = pending.pop()!;
    if (nodeClips.size >= 5000 || nodeClips.has(node) || ids.has(node.id)) return unknown;
    ids.add(node.id);
    let clipped: ScreenRect | null = null;
    if (node.visibleToUser && node.visibilityEvidence !== "hidden") {
      const original = parseBounds(node.attributes!["bounds-screen"]), bounds = node.bounds;
      if (!original || !bounds || !partialRectValid(bounds)) return unknown;
      const raw = { left: original[0], top: original[1], right: original[2], bottom: original[3] };
      if (!partialRectValid(raw)) return unknown;
      clipped = clip && intersectPartialRects(clip, bounds);
      clipped = clipped && intersectPartialRects(clipped, raw);
    }
    nodeClips.set(node, clipped);
    // Conservatively clip every ancestor; this never enlarges the captured visible rectangle.
    pending.push(...node.children.map(child => ({ node: child, clip: clipped })));
  }
  return node => {
    if (!nodeClips.has(node)) return unknown();
    const clip = nodeClips.get(node);
    if (!clip) return { status: "occluded", regions: [] };
    let regions = [clip];
    for (const cover of covers) {
      const next: ScreenRect[] = [];
      for (const region of regions) {
        next.push(...subtractPartialRect(region, cover));
        if (next.length > PARTIAL_REGION_LIMIT) return unknown();
      }
      regions = next;
    }
    return { status: regions.length ? "exposed" : "occluded", regions };
  };
}

export function helperNodePartialVisibility(snapshot: UiSnapshot, node: UiNode): HelperPartialVisibilityResult {
  return createHelperNodePartialVisibility(snapshot)(node);
}

/** Both observations must expose the same positive-area rectangle; 1px is deliberately sufficient. */
export function commonHelperPartialVisibilityRegion(first: HelperPartialVisibilityResult, second: HelperPartialVisibilityResult): ScreenRect | null {
  if ([first, second].some(result => result.status !== "exposed" || !result.regions.length
    || result.regions.length > PARTIAL_REGION_LIMIT || !result.regions.every(partialRectValid))) return null;
  for (const a of first.regions) for (const b of second.regions) {
    const common = intersectPartialRects(a, b);
    if (common) return common;
  }
  return null;
}

export function assertHelperRegionUnobscured(snapshot: UiSnapshot, region: ScreenRect | null | undefined): void {
  const safety = helperRegionSafety(snapshot, region);
  if (safety !== "clear") throw new Error(safety === "occluded"
    ? "操作或断言区域被其他窗口遮挡，未执行；遮挡不能作为控件不存在的证据。"
    : "操作或断言区域缺少有效的窗口范围证据，未执行。");
}

/** Protect the actual touch point plus a 24px margin; only screen edges are clamped. */
export function helperTapSafetyBounds(snapshot: UiSnapshot, x: number, y: number): ScreenRect | null {
  const frame = snapshot.captureGeometry?.screenshotSize;
  if (!frame || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null;
  return { left: Math.max(0, x - 24), top: Math.max(0, y - 24), right: Math.min(frame.width, x + 25), bottom: Math.min(frame.height, y + 25) };
}

/** Back follows the proven focused app, not a screen coordinate. IME and overlays may consume Back independently. */
export function hasSafeHelperBackEvidence(snapshot: UiSnapshot): boolean {
  if (!hasSafeHelperObservationContext(snapshot)) return false;
  const evidence = snapshot.helperObservation!, target = evidence.windowsBefore.find(window => window.id === evidence.windowId)!;
  return evidence.windowsBefore.every(window => window.id === target.id || (window.type !== "input_method"
    && window.type !== "accessibility_overlay" && !(window.type === "application" && window.layer >= target.layer)));
}

export function assertHelperBackNavigation(snapshot: UiSnapshot): void {
  if (snapshot.inspectionSource === "accessibility-helper" && !hasSafeHelperBackEvidence(snapshot))
    throw new Error("返回键缺少唯一授权焦点证据，或可能被输入法/其他窗口接收，未执行。");
}

/** Legacy whole-window gate retained for older consumers; region-aware actions use the APIs above. */
export function hasActionableHelperEvidence(snapshot: UiSnapshot): boolean {
  return hasCompleteHelperObservationEvidence(snapshot) && safeWindows(snapshot.helperObservation!);
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

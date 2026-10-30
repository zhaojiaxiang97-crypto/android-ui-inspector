import { debugToolSchemas, matchesDebugSelector, type PerformUiStepInput, type ScrollUntilInput } from "../../shared/debug-protocol";
import { assertSameHelperObservationSource, assertSameHelperServiceEvidence, createHelperNodeRegionSafety,
  hasActionableHelperEvidence, hasSafeHelperBackEvidence, hasSafeHelperObservationContext,
  helperRegionSafety, helperTapSafetyBounds } from "../../shared/helper-observation";
import type { ScreenRect } from "../../shared/screen-coordinates";
import { flattenNodes } from "../../shared/tree-utils";
import type { DebugStep, UiNode, UiSnapshot } from "../../shared/types";
import { inspectScrollTree } from "../automation/debug-scroll-execution";
import { resolveParentTap, resolveScroll, resolveTap, resolveAccessibilityScroll } from "../automation/debug-target-resolution";
import { assertionTreesSafe } from "./debug-report-assertion";

type Lookup = (id: string | undefined) => UiSnapshot | undefined;
type Selector = NonNullable<PerformUiStepInput["target"]>["selector"];
type Resolved = NonNullable<DebugStep["resolvedInput"]>;
const visible = (node: UiNode) => node.visibleToUser && node.visibilityEvidence !== "hidden"
  && !!node.bounds && node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top;
const inside = (outer: ScreenRect, inner: ScreenRect) => inner.left >= outer.left && inner.top >= outer.top
  && inner.right <= outer.right && inner.bottom <= outer.bottom && inner.right > inner.left && inner.bottom > inner.top;
const contains = (rect: ScreenRect, x: number, y: number) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
const sameRect = (a: ScreenRect, b: ScreenRect) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

function allNodes(snapshot: UiSnapshot) { return [...flattenNodes(snapshot.root!).values()]; }
function scopedNodes(snapshot: UiSnapshot, within?: Selector) {
  const nodes = allNodes(snapshot);
  if (!within) return nodes;
  const scopes = nodes.filter(node => visible(node) && matchesDebugSelector(node, within));
  return scopes.length === 1 ? [...flattenNodes(scopes[0]).values()] : [];
}
function uniqueTarget(snapshot: UiSnapshot, target: NonNullable<PerformUiStepInput["target"]>) {
  const found = scopedNodes(snapshot, target.within).filter(node => visible(node) && matchesDebugSelector(node, target.selector)
    && (target.clickable === undefined || node.clickable === target.clickable)
    && (target.scrollable === undefined || node.scrollable === target.scrollable));
  return found.length === 1 && found[0].enabled ? found[0] : null;
}

/** Every matched node is checked before hidden candidates are excluded from an assertion. */
function matching(snapshot: UiSnapshot, nodes: UiNode[], selector: Selector | undefined): UiNode[] | null {
  if (!selector) return [];
  const candidates = nodes.filter(node => matchesDebugSelector(node, selector));
  const safety = createHelperNodeRegionSafety(snapshot);
  if (candidates.some(node => safety(node) !== "clear")) return null;
  return candidates.filter(visible);
}

function sameInputFrame(snapshot: UiSnapshot, resolved: Resolved) {
  const frame = snapshot.helperObservation?.displayAfter;
  return frame && frame.width === resolved.frame.width && frame.height === resolved.frame.height && frame.rotation === resolved.frame.rotation;
}

function inputSafe(snapshot: UiSnapshot, resolved: DebugStep["resolvedInput"], request: PerformUiStepInput, semanticScroll = false) {
  if (!hasSafeHelperObservationContext(snapshot) || !resolved || !sameInputFrame(snapshot, resolved)) return false;
  const action = resolved.action;
  if (request.action.kind === "back") return action.kind === "back" && hasSafeHelperBackEvidence(snapshot);
  if (!request.target) return false;
  const anchor = uniqueTarget(snapshot, request.target);
  const target = allNodes(snapshot).find(node => node.id === resolved.targetNodeId);
  if (!anchor || !target || !visible(target) || !target.enabled || !target.bounds) return false;
  if (request.action.kind === "tap") {
    const expected = request.target.target === "clickable-parent"
      ? resolveParentTap(anchor, snapshot, snapshot, snapshot.helperObservation!.packageName, "report")
      : resolveTap(anchor, snapshot, snapshot.helperObservation!.packageName, snapshot, "report");
    if (action.kind !== "tap" || !contains(target.bounds, action.x, action.y)
      || target.id !== expected.node.id || action.x !== expected.x || action.y !== expected.y
      || helperRegionSafety(snapshot, helperTapSafetyBounds(snapshot, action.x, action.y)) !== "clear") return false;
    if (request.target.target === "clickable-parent") {
      return resolved.anchorNodeId === anchor.id
        && createHelperNodeRegionSafety(snapshot)(anchor) === "clear";
    }
    return target.id === anchor.id && (resolved.anchorNodeId === undefined || resolved.anchorNodeId === anchor.id);
  }
  if (target.id !== anchor.id || !target.scrollable || !resolved.scrollRegion) return false;
  if (semanticScroll) {
    if (action.kind !== "scroll" || action.direction !== request.action.direction) return false;
    resolveAccessibilityScroll(target, action.direction);
  } else if (action.kind !== "swipe") return false;
  const { viewport, confirmationBounds, excludedNavigationBounds } = resolved.scrollRegion;
  const expected = resolveScroll(anchor, snapshot, snapshot.helperObservation!.packageName, request.action, "report");
  const { geometry } = expected;
  return (semanticScroll || action.kind === "swipe" && action.fromX === expected.action.fromX && action.fromY === expected.action.fromY
    && action.toX === expected.action.toX && action.toY === expected.action.toY && action.durationMs === expected.action.durationMs)
    && sameRect(viewport, geometry.viewport) && sameRect(confirmationBounds, expected.confirmationBounds)
    && excludedNavigationBounds.length === geometry.excludedNavigation.length
    && excludedNavigationBounds.every((bounds, i) => sameRect(bounds, geometry.excludedNavigation[i].bounds))
    && inside(target.bounds, viewport) && inside(viewport, confirmationBounds)
    && contains(confirmationBounds, expected.action.fromX, expected.action.fromY) && contains(confirmationBounds, expected.action.toX, expected.action.toY)
    && helperRegionSafety(snapshot, confirmationBounds) === "clear";
}

function expectationSafe(snapshot: UiSnapshot, request: PerformUiStepInput) {
  if (!request.expect || !hasSafeHelperObservationContext(snapshot)) return false;
  const found = matching(snapshot, allNodes(snapshot), request.expect.selector);
  if (!found) return false;
  return request.expect.state === "absent" ? found.length === 0 : found.length > 0
    && (request.expect.state === "visible" || found.every(node => node.enabled === (request.expect!.state === "enabled")));
}

/** Region-aware imports never reinterpret absent input/snapshot evidence as a successful action. */
export function helperUiStepReportSafe(original: DebugStep, result: DebugStep, lookup: Lookup): boolean {
  const parsed = debugToolSchemas.perform_ui_step.safeParse(original.input);
  const before = lookup(original.beforeId), after = lookup(result.afterId);
  if (!parsed.success || parsed.data.backend !== "accessibility-helper" || !before || !after) return false;
  try { assertSameHelperServiceEvidence(before.helperObservation!, after.helperObservation!); }
  catch { return false; }
  if (parsed.data.expect?.visibility === "partial") {
    try { return inputSafe(before, original.resolvedInput, parsed.data)
      && assertionTreesSafe(result, original, id => lookup(id), before.helperObservation!.packageName); }
    catch { return false; }
  }
  if (hasActionableHelperEvidence(before) && hasActionableHelperEvidence(after)) return true;
  try { return inputSafe(before, original.resolvedInput, parsed.data) && expectationSafe(after, parsed.data); }
  catch { return false; }
}

function scrollConfirmation(snapshot: UiSnapshot, request: ScrollUntilInput) {
  if (!hasSafeHelperObservationContext(snapshot)) return null;
  const container = uniqueTarget(snapshot, { ...request.target, scrollable: true, target: "self" });
  if (!container) return null;
  const proof = inspectScrollTree(snapshot, request, snapshot.helperObservation!.packageName, container, snapshot.helperObservation!.windowId);
  return proof.condition === request.until.kind ? proof.conditionKey : null;
}

export function helperScrollReportSafe(original: DebugStep, result: DebugStep, lookup: Lookup): boolean {
  const parsed = debugToolSchemas.scroll_until.safeParse(original.input), progress = result.scrollTask;
  const before = lookup(original.beforeId);
  const first = lookup(progress?.confirmation?.firstSnapshotId), second = lookup(progress?.confirmation?.secondSnapshotId);
  if (!parsed.success || parsed.data.backend !== "accessibility-helper" || !progress?.confirmation || !before || !first || !second) return false;
  const request = parsed.data;
  try {
    assertSameHelperObservationSource(first, second);
    assertSameHelperObservationSource(before, second);
    let previous: UiSnapshot | undefined;
    for (const iteration of progress.iterations) {
      const start = lookup(iteration.beforeId), finish = lookup(iteration.afterId);
      if (!start || !finish) return false;
      assertSameHelperObservationSource(start, finish);
      // step.beforeId is updated by each input; it is not necessarily the earliest observation.
      const a = start.helperObservation!, b = before.helperObservation!;
      if (a.serviceInstanceId !== b.serviceInstanceId || a.packageName !== b.packageName || a.windowId !== b.windowId
        || a.displayAfter.width !== b.displayAfter.width || a.displayAfter.height !== b.displayAfter.height
        || a.displayAfter.rotation !== b.displayAfter.rotation) return false;
      if (previous && previous !== start) assertSameHelperObservationSource(previous, start);
      previous = finish;
      if (request.inputMethod === "accessibility" || !hasActionableHelperEvidence(start) || !hasActionableHelperEvidence(finish)) {
        const actionRequest: PerformUiStepInput = { sessionId: request.sessionId, requestId: request.requestId,
          backend: request.backend, target: { ...request.target, scrollable: true, target: "self" }, timeoutMs: 1000,
          action: { kind: "scroll", direction: request.direction, distance: request.distance, durationMs: request.durationMs } };
        if (!inputSafe(start, iteration.resolvedInput, actionRequest, request.inputMethod === "accessibility") || !hasSafeHelperObservationContext(finish)
          || helperRegionSafety(finish, iteration.resolvedInput?.scrollRegion?.confirmationBounds) !== "clear") return false;
      }
    }
    if (previous && previous !== first) assertSameHelperObservationSource(previous, first);
    if (request.until.reveal === "scroll") {
      let targetKey: string | undefined, previousRead: UiSnapshot | undefined;
      if (!progress.scope) return false;
      for (const id of progress.observationIds) {
        const snapshot = lookup(id), scope = progress.scope, attrs = snapshot?.root?.attributes;
        if (!snapshot || !hasSafeHelperObservationContext(snapshot)
          || attrs?.["debug-observation-component"] !== scope.component || attrs["debug-observation-window-id"] !== scope.windowId
          || (attrs["debug-observation-activity-record-id"] || undefined) !== scope.activityRecordId) return false;
        if (previousRead) assertSameHelperObservationSource(previousRead, snapshot);
        previousRead = snapshot;
        const container = uniqueTarget(snapshot, { ...request.target, scrollable: true, target: "self" });
        if (!container) return false;
        const key = inspectScrollTree(snapshot, request, snapshot.helperObservation!.packageName, container,
          snapshot.helperObservation!.windowId).revealTargetKey;
        if (key && targetKey && key !== targetKey) return false;
        if (key) targetKey = key;
      }
    }
  } catch { return false; }
  if (!hasSafeHelperObservationContext(before)) return false;
  try {
    const firstKey = scrollConfirmation(first, request), secondKey = scrollConfirmation(second, request);
    return firstKey !== null && firstKey === secondKey;
  } catch { return false; }
}

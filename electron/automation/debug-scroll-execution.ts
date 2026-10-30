import { matchesDebugSelector, type ScrollUntilInput } from "../../shared/debug-protocol";
import type { DebugScrollProgress } from "../../shared/debug-scroll";
import { createHelperNodeRegionSafety, assertSameHelperObservationSource, hasSafeHelperObservationContext } from "../../shared/helper-observation";
import { flattenNodes } from "../../shared/tree-utils";
import type { UiNode, UiSnapshot } from "../../shared/types";
import { validBounds, type ScreenRect } from "../../shared/screen-coordinates";
import type { Current } from "./debug-step-context";
import { scrollGeometry, intersectsRect } from "./debug-scroll-geometry";
import { windowId } from "./debug-target-resolution";
import { locateUiStepTarget, observedTreeWindowId } from "./debug-ui-step";

export class DebugScrollContainerMissing extends Error {}
export type ScrollObservation = {
  current: Current; container: UiNode; viewport: ScreenRect; visible: UiNode[];
  condition: "target" | "end_marker" | "empty" | null; conditionKey: string | null;
  loading: boolean; progressKey: string | null;
  revealTargetKey?: string;
  progressAnchors: { key: string; bounds: ScreenRect }[];
};
const intersection = (a: ScreenRect, b: ScreenRect): ScreenRect => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
const semanticKey = (node: UiNode) => JSON.stringify([node.package, node.className, node.resourceId, node.text, node.contentDesc]);
const contained = (outer: ScreenRect | null | undefined, inner: ScreenRect) => !!outer && validBounds(outer)
  && inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
function originalBounds(snapshot: UiSnapshot, node: UiNode): ScreenRect | null {
  if (snapshot.inspectionSource !== "accessibility-helper") return node.bounds;
  const parts = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(node.attributes?.["bounds-screen"] ?? "");
  if (!parts) return null;
  const [left, top, right, bottom] = parts.slice(1).map(Number), rect = { left, top, right, bottom };
  return Object.values(rect).every(Number.isSafeInteger) && validBounds(rect) ? rect : null;
}

/** Check a rectangle against the union, so overlapping covers never count the same area twice. */
function covered(rect: ScreenRect, covers: ScreenRect[]) {
  if (!validBounds(rect)) return true;
  const clipped = covers.filter(cover => intersectsRect(rect, cover)).map(cover => intersection(rect, cover));
  const edges = [...new Set([rect.left, rect.right, ...clipped.flatMap(cover => [cover.left, cover.right])])].sort((a, b) => a - b);
  return edges.slice(1).every((right, index) => {
    let bottom = rect.top;
    for (const cover of clipped.filter(cover => cover.left <= edges[index] && cover.right >= right).sort((a, b) => a.top - b.top)) {
      if (cover.top > bottom) return false;
      bottom = Math.max(bottom, cover.bottom);
    }
    return bottom >= rect.bottom;
  });
}

function canRevealBelow(snapshot: UiSnapshot, bounds: ScreenRect, clip: ScreenRect | null | undefined,
  contentClip: ScreenRect | undefined, contentViewport: ScreenRect, navigation: ScreenRect[]) {
  if (!contentClip || !contained(contentClip, bounds)) return false;
  const evidence = snapshot.helperObservation!, frame = evidence.displayAfter;
  if (bounds.left < 0 || bounds.top < 0 || bounds.right > frame.width || bounds.bottom > frame.height) return false;
  const focus = evidence.windowsBefore.find(window => window.id === evidence.windowId)!;
  const windows = evidence.windowsBefore.filter(window => window.id !== focus.id && window.layer >= focus.layer).map(window => ({
    window, rect: { left: window.bounds.x, top: window.bounds.y, right: window.bounds.x + window.bounds.width, bottom: window.bounds.y + window.bounds.height },
  })).filter(item => intersectsRect(item.rect, bounds));
  if (windows.some(({ window, rect }) => window.type !== "system" || !Object.values(rect).every(Number.isSafeInteger)
    || !validBounds(rect) || rect.bottom < contentViewport.bottom || rect.top < contentViewport.top)) return false;
  const covers = [...navigation, ...windows.map(item => item.rect)].filter(rect => validBounds(rect)
    && rect.bottom >= contentViewport.bottom && rect.top >= contentViewport.top);
  if (!covers.some(rect => intersectsRect(rect, bounds))) return false;
  // Only a missing bottom portion is explained. Side, top, or arbitrary ancestor clipping remains unsafe.
  if (clip && (bounds.left < clip.left || bounds.right > clip.right || bounds.top < clip.top)) return false;
  const bottom = clip && validBounds(clip) ? Math.max(bounds.top, Math.min(bounds.bottom, clip.bottom)) : bounds.top;
  return covered({ ...bounds, top: bottom }, covers);
}

/** Observe only the clipped descendants of the unique authorized scrolling container. */
export function inspectScrollObservation(current: Current, input: ScrollUntilInput, packageName: string): ScrollObservation {
  let container: UiNode;
  try { container = locateUiStepTarget(current, { ...input.target, scrollable: true, target: "self" }, packageName); }
  catch (error) { throw new DebugScrollContainerMissing(error instanceof Error ? error.message : "滚动容器不可用。"); }
  return { current, ...inspectScrollTree(current.entry.snapshot, input, packageName, container, observedTreeWindowId(current)) };
}

/** Shared live/report analysis; callers first validate the observation and resolve the authorized container. */
export function inspectScrollTree(snapshot: UiSnapshot, input: ScrollUntilInput, packageName: string,
  container: UiNode, expectedWindow: string): Omit<ScrollObservation, "current"> {
  if (!container.bounds) throw new DebugScrollContainerMissing("滚动容器缺少可见范围。");
  const all = [...flattenNodes(snapshot.root!).values()];
  if (all.some(node => container.id.startsWith(`${node.id}/`) && (!node.visibleToUser || node.visibilityEvidence === "hidden"
    || node.package !== packageName || windowId(node, all) !== expectedWindow)))
    throw new DebugScrollContainerMissing("滚动容器的父级不可见或不在授权窗口。");
  const size = snapshot.captureGeometry?.screenshotSize;
  if (!size) throw new Error("观察缺少屏幕尺寸，无法确认滚动范围。");
  const geometry = scrollGeometry(container, all, size, node => windowId(node, all) === expectedWindow);
  const { viewport } = geometry;
  if (viewport.right <= viewport.left || viewport.bottom <= viewport.top) throw new DebugScrollContainerMissing("滚动容器不在屏幕内。");
  const visible: UiNode[] = [];
  const clips = new Map<UiNode, ScreenRect | null>(), contentClips = new Map<UiNode, ScreenRect>();
  const visit = (node: UiNode, clip: ScreenRect | null, contentClip: ScreenRect) => {
    if (node.package !== packageName || !node.visibleToUser || node.visibilityEvidence === "hidden"
      || windowId(node, all) !== expectedWindow) return;
    clips.set(node, clip); contentClips.set(node, contentClip);
    if (node.bounds && clip && intersectsRect(node.bounds, clip)) visible.push(node);
    const clipsChildren = node.bounds && (node.scrollable || node.attributes?.["clip-children"] === "true" || node.attributes?.["window-id"]);
    const childClip = clipsChildren && clip ? intersection(clip, node.bounds!) : clip;
    const childContentClip = clipsChildren ? intersection(contentClip, node.bounds!) : contentClip;
    if (!validBounds(childContentClip)) return;
    for (const child of node.children) visit(child, childClip && validBounds(childClip) ? childClip : null, childContentClip);
  };
  for (const child of container.children) visit(child, viewport, geometry.contentViewport);
  const regionSafety = createHelperNodeRegionSafety(snapshot);
  const reveal = input.until.reveal === "scroll";
  if (reveal && (!hasSafeHelperObservationContext(snapshot) || input.backend !== "accessibility-helper" || input.direction !== "down"))
    throw new Error("底栏目标继续查找缺少完整 Helper 或向下滚动证据，未继续。");
  if (reveal && snapshot.helperObservation!.windowsBefore.some(window => {
    const rect = { left: window.bounds.x, top: window.bounds.y, right: window.bounds.x + window.bounds.width, bottom: window.bounds.y + window.bounds.height };
    return !Object.values(rect).every(Number.isSafeInteger) || !validBounds(rect) || rect.left < 0 || rect.top < 0 || rect.right > size.width || rect.bottom > size.height;
  })) throw new Error("窗口库存缺少有效的屏幕范围，未继续滚动。");
  let revealTargetKey: string | undefined;
  const matching = (selector: ScrollUntilInput["until"]["selector"] | undefined, until = false) => {
    const matches = selector ? visible.filter(node => matchesDebugSelector(node, selector)) : [];
    const candidates = selector ? all.filter(node => node.id.startsWith(`${container.id}/`) && matchesDebugSelector(node, selector)) : [];
    if (reveal && until && candidates.length > 1) throw new Error("继续查找的目标匹配不唯一，未继续滚动。");
    if (reveal && until && candidates[0]) {
      const node = candidates[0], bounds = originalBounds(snapshot, node), safety = regionSafety(node);
      if (!bounds || !node.visibleToUser || node.visibilityEvidence === "hidden" || !contentClips.has(node) || safety === "unknown")
        throw new Error("继续查找的目标隐藏或缺少完整范围证据，未继续滚动。");
      revealTargetKey = semanticKey(node);
      if (safety !== "clear" || !contained(clips.get(node), bounds)) {
        if (!canRevealBelow(snapshot, bounds, clips.get(node), contentClips.get(node), geometry.contentViewport, geometry.excludedNavigation.map(item => item.bounds)))
          throw new Error("目标遮挡或裁剪不能由已知底栏解释，未继续滚动。");
        return [];
      }
    } else if (candidates.some(node => regionSafety(node) !== "clear"))
      throw new Error("滚动完成或加载条件被其他窗口遮挡，无法确认结果，未继续滚动。");
    if ((!reveal || !until) && candidates.some(node => {
      const bounds = originalBounds(snapshot, node), clip = contentClips.get(node);
      return node.visibleToUser && node.visibilityEvidence !== "hidden" && bounds && clip && intersectsRect(bounds, clip)
        && geometry.excludedNavigation.some(item => intersectsRect(bounds, item.bounds));
    })) throw new Error("滚动完成或加载条件被应用导航栏遮挡，未继续滚动。");
    if (matches.some(node => { const bounds = originalBounds(snapshot, node); return !bounds || !contained(clips.get(node), bounds); }))
      throw new Error("滚动完成或加载条件未完整露出在安全容器范围，未确认结果。");
    return matches;
  };
  const loading = matching(input.loading).length > 0;
  const matches = matching(input.until.selector, true), empty = matching(input.empty);
  if (revealTargetKey && (loading || empty.length)) throw new Error("继续查找目标与加载或空列表条件冲突，未继续滚动。");
  if (matches.length > 1 || empty.length > 1) throw new Error("滚动完成条件匹配不唯一，未继续滚动。");
  if (matches.length && empty.length) throw new Error("目标与空列表提示同时出现，无法确认结果。");
  const condition = loading ? null : matches.length ? input.until.kind : empty.length ? "empty" : null;
  const conditionNode = matches[0] ?? empty[0];
  // Recycled node IDs and repeated resource IDs are not item identities. A
  // duplicated label or an image-only list has insufficient progress evidence.
  const items = visible.filter(node => (node.text?.trim() || node.contentDesc?.trim()) && node.bounds);
  const identities = items.map(semanticKey);
  const counts = new Map<string, number>();
  for (const key of identities) counts.set(key, (counts.get(key) ?? 0) + 1);
  const progressAnchors = items.length <= 2048 ? items.flatMap((node, index) => counts.get(identities[index]) === 1
    && regionSafety(node) === "clear" ? [{ key: identities[index], bounds: node.bounds! }] : []) : [];
  const reliable = items.length > 0 && items.length <= 2048 && new Set(identities).size === identities.length
    && items.every(node => regionSafety(node) === "clear");
  const progressKey = reliable ? JSON.stringify(items.map((node, index) => [identities[index],
    node.bounds!.left - viewport.left, node.bounds!.top - viewport.top,
    node.bounds!.right - viewport.left, node.bounds!.bottom - viewport.top]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))) : null;
  return { container, viewport, visible, loading, condition,
    conditionKey: condition && conditionNode ? JSON.stringify([condition, semanticKey(conditionNode)]) : null, progressKey, progressAnchors,
    ...(revealTargetKey ? { revealTargetKey } : {}) };
}

export function compareScrollProgress(before: ScrollObservation, after: ScrollObservation, direction: ScrollUntilInput["direction"]): "changed" | "unchanged" | "unknown" {
  if (before.loading || after.loading) return "unknown";
  if (before.progressKey && after.progressKey) return before.progressKey === after.progressKey ? "unchanged" : "changed";
  // A clear shared anchor can prove motion, never unchanged content or the end of a partially obscured list.
  if (before.current.entry.snapshot.inspectionSource !== "accessibility-helper" || after.current.entry.snapshot.inspectionSource !== "accessibility-helper"
    || ["left", "top", "right", "bottom"].some(key => before.viewport[key as keyof ScreenRect] !== after.viewport[key as keyof ScreenRect])) return "unknown";
  const a = before.current.target, b = after.current.target;
  if (a.windowId !== b.windowId || a.component !== b.component || a.activityRecordId !== b.activityRecordId) return "unknown";
  try { assertSameHelperObservationSource(before.current.entry.snapshot, after.current.entry.snapshot); }
  catch { return "unknown"; }
  const next = new Map(after.progressAnchors.map(anchor => [anchor.key, anchor.bounds]));
  const horizontal = direction === "left" || direction === "right", sign = direction === "up" || direction === "left" ? 1 : -1;
  let moved = false;
  for (const anchor of before.progressAnchors) {
    const b = next.get(anchor.key), a = anchor.bounds;
    if (!b) continue;
    if (a.right - a.left !== b.right - b.left || a.bottom - a.top !== b.bottom - b.top
      || (horizontal ? a.top !== b.top : a.left !== b.left)) return "unknown";
    const delta = horizontal ? b.left - a.left : b.top - a.top;
    if (Math.abs(delta) <= 2) continue;
    if (delta * sign < 0) return "unknown";
    moved = true;
  }
  if (moved) return "changed";
  // Whole-page replacement may have no common anchor. Test disappearance against ALL visible items,
  // including covered ones; changing only the clear subset never proves that content was replaced.
  const oldVisible = new Set(before.visible.map(semanticKey)), newVisible = new Set(after.visible.map(semanticKey));
  return before.progressAnchors.some(anchor => !newVisible.has(anchor.key))
    && after.progressAnchors.some(anchor => !oldVisible.has(anchor.key)) ? "changed" : "unknown";
}

export function rememberScrollObservation(progress: DebugScrollProgress, snapshotId: string) {
  if (progress.observationIds.at(-1) === snapshotId) return;
  if (progress.observationIds.length >= 256) throw new Error("本次滚动观察次数已达上限，未继续操作。");
  progress.observationIds.push(snapshotId);
}

import { matchesDebugSelector, type ScrollUntilInput } from "../../shared/debug-protocol";
import type { DebugScrollProgress } from "../../shared/debug-scroll";
import { flattenNodes } from "../../shared/tree-utils";
import type { UiNode } from "../../shared/types";
import type { ScreenRect } from "../../shared/screen-coordinates";
import type { Current } from "./debug-step-context";
import { scrollGeometry, intersectsRect } from "./debug-scroll-geometry";
import { windowId } from "./debug-target-resolution";
import { locateUiStepTarget, observedTreeWindowId } from "./debug-ui-step";

export class DebugScrollContainerMissing extends Error {}
export type ScrollObservation = {
  current: Current; container: UiNode; viewport: ScreenRect; visible: UiNode[];
  condition: "target" | "end_marker" | "empty" | null; conditionKey: string | null;
  loading: boolean; progressKey: string | null;
};
const intersection = (a: ScreenRect, b: ScreenRect): ScreenRect => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
const semanticKey = (node: UiNode) => JSON.stringify([node.package, node.className, node.resourceId, node.text, node.contentDesc]);

/** Observe only the clipped descendants of the unique authorized scrolling container. */
export function inspectScrollObservation(current: Current, input: ScrollUntilInput, packageName: string): ScrollObservation {
  let container: UiNode;
  try { container = locateUiStepTarget(current, { ...input.target, scrollable: true, target: "self" }, packageName); }
  catch (error) { throw new DebugScrollContainerMissing(error instanceof Error ? error.message : "滚动容器不可用。"); }
  if (!container.bounds) throw new DebugScrollContainerMissing("滚动容器缺少可见范围。");
  const all = [...flattenNodes(current.entry.snapshot.root!).values()];
  const expectedWindow = observedTreeWindowId(current);
  if (all.some(node => container.id.startsWith(`${node.id}/`) && (!node.visibleToUser || node.visibilityEvidence === "hidden"
    || node.package !== packageName || windowId(node, all) !== expectedWindow)))
    throw new DebugScrollContainerMissing("滚动容器的父级不可见或不在授权窗口。");
  const size = current.entry.snapshot.captureGeometry?.screenshotSize;
  if (!size) throw new Error("观察缺少屏幕尺寸，无法确认滚动范围。");
  const viewport = scrollGeometry(container, all, size, node => windowId(node, all) === expectedWindow).viewport;
  if (viewport.right <= viewport.left || viewport.bottom <= viewport.top) throw new DebugScrollContainerMissing("滚动容器不在屏幕内。");
  const visible: UiNode[] = [];
  const visit = (node: UiNode, clip: ScreenRect) => {
    if (node.package !== packageName || !node.visibleToUser || node.visibilityEvidence === "hidden"
      || windowId(node, all) !== expectedWindow) return;
    if (node.bounds && intersectsRect(node.bounds, clip)) visible.push(node);
    const childClip = node.bounds && (node.scrollable || node.attributes?.["clip-children"] === "true" || node.attributes?.["window-id"])
      ? intersection(clip, node.bounds) : clip;
    if (childClip.right <= childClip.left || childClip.bottom <= childClip.top) return;
    for (const child of node.children) visit(child, childClip);
  };
  for (const child of container.children) visit(child, viewport);
  const matching = (selector: ScrollUntilInput["until"]["selector"] | undefined) => selector
    ? visible.filter(node => matchesDebugSelector(node, selector)) : [];
  const loading = matching(input.loading).length > 0;
  const matches = matching(input.until.selector), empty = matching(input.empty);
  if (matches.length > 1 || empty.length > 1) throw new Error("滚动完成条件匹配不唯一，未继续滚动。");
  if (matches.length && empty.length) throw new Error("目标与空列表提示同时出现，无法确认结果。");
  const condition = loading ? null : matches.length ? input.until.kind : empty.length ? "empty" : null;
  const conditionNode = matches[0] ?? empty[0];
  // Recycled node IDs and repeated resource IDs are not item identities. A
  // duplicated label or an image-only list has insufficient progress evidence.
  const items = visible.filter(node => (node.text?.trim() || node.contentDesc?.trim()) && node.bounds);
  const identities = items.map(semanticKey);
  const reliable = items.length > 0 && items.length <= 2048 && new Set(identities).size === identities.length;
  const progressKey = reliable ? JSON.stringify(items.map((node, index) => [identities[index],
    node.bounds!.left - viewport.left, node.bounds!.top - viewport.top,
    node.bounds!.right - viewport.left, node.bounds!.bottom - viewport.top]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))) : null;
  return { current, container, viewport, visible, loading, condition,
    conditionKey: condition && conditionNode ? JSON.stringify([condition, semanticKey(conditionNode)]) : null, progressKey };
}

export function compareScrollProgress(before: ScrollObservation, after: ScrollObservation): "changed" | "unchanged" | "unknown" {
  if (before.loading || after.loading || !before.progressKey || !after.progressKey) return "unknown";
  return before.progressKey === after.progressKey ? "unchanged" : "changed";
}

export function rememberScrollObservation(progress: DebugScrollProgress, snapshotId: string) {
  if (progress.observationIds.at(-1) === snapshotId) return;
  if (progress.observationIds.length >= 256) throw new Error("本次滚动观察次数已达上限，未继续操作。");
  progress.observationIds.push(snapshotId);
}

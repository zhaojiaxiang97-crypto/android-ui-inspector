import { clipBounds, type ScreenRect } from "../../shared/screen-coordinates";
import type { PixelSize, UiNode } from "../../shared/types";

export type ScrollGeometry = {
  viewport: ScreenRect;
  excludedNavigation: { bounds: ScreenRect; tabs: string[] }[];
};

export const intersectsRect = (a: ScreenRect, b: ScreenRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const visible = (node: UiNode) => node.visibleToUser && node.visibilityEvidence !== "hidden";
const parentId = (node: UiNode) => node.id.slice(0, node.id.lastIndexOf("/"));

function intersect(a: ScreenRect, b: ScreenRect): ScreenRect {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}

/** Derived input geometry only: never rewrite the inspector's original layout bounds. */
export function scrollGeometry(target: UiNode, nodes: UiNode[], size: PixelSize,
  sameWindow: (node: UiNode) => boolean): ScrollGeometry {
  let viewport = clipBounds(target.bounds!, size)!;
  const ancestors = nodes.filter(node => target.id.startsWith(`${node.id}/`));
  const nearestAncestors = [...ancestors].reverse();
  // Helper repeats window-id on every node; only the outermost marked ancestor is a window root.
  const windowRoot = ancestors.find(node => node.bounds && sameWindow(node)
    && (node.attributes?.["window-id"] || node.attributes?.["debug-observation-window-id"]));
  // Root/window bounds and scrollable ancestors constrain the input surface. Ordinary
  // layout containers may allow overflow, so only clip them with explicit evidence.
  for (const ancestor of ancestors) if (ancestor.bounds && (ancestor === nodes[0] || ancestor === windowRoot || ancestor.scrollable
    || ancestor.attributes?.["clip-children"] === "true")) {
    viewport = intersect(viewport, ancestor.bounds);
  }
  const windowBounds = windowRoot?.bounds
    ?? ancestors[0]?.bounds ?? { left: 0, top: 0, right: size.width, bottom: size.height };
  const windowRect = clipBounds(windowBounds, size);
  if (!windowRect) throw new Error("窗口不在屏幕内，未滑动。");
  const groups = new Map<string, UiNode[]>();
  for (const node of nodes) {
    if (!visible(node) || !node.enabled || !node.clickable || node.scrollable || !node.bounds
      || node.package !== target.package || !sameWindow(node) || node.id.startsWith(`${target.id}/`)
      || !/(?:^|\.)ActionBar\$Tab$/.test(node.className ?? "")) continue;
    const key = parentId(node);
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  const excludedNavigation: ScrollGeometry["excludedNavigation"] = [];
  for (const [parent, tabs] of groups) {
    // A selected, horizontal tab row at the app-window edge is evidence of navigation.
    // Resource-name guesses, individual buttons, bottom sheets and 1px slivers are not.
    if (tabs.length < 3 || tabs.filter(node => node.selected).length !== 1
      || nodes.some(node => (node.id === parent || parent.startsWith(`${node.id}/`)) && node.scrollable)) continue;
    const rects = tabs.map(node => node.bounds!).sort((a, b) => a.left - b.left);
    // The decor window can include system navigation below the app content. Use the
    // deepest shared content container for the edge, not a guessed screen inset.
    const sharedBounds = nearestAncestors.find(node => node.bounds && (node.id === parent || parent.startsWith(`${node.id}/`)))?.bounds;
    const contentRect = sharedBounds ? intersect(windowRect, sharedBounds) : windowRect;
    const row = { left: rects[0].left, top: Math.min(...rects.map(b => b.top)),
      right: Math.max(...rects.map(b => b.right)), bottom: Math.max(...rects.map(b => b.bottom)) };
    const height = row.bottom - row.top, contentHeight = contentRect.bottom - contentRect.top;
    if (height < 24 || height > contentHeight * 0.2 || Math.abs(row.bottom - contentRect.bottom) > 4
      || row.right - row.left < (contentRect.right - contentRect.left) * 0.85
      || row.left > viewport.left || row.right < viewport.right
      || rects.some((b, i) => b.right <= b.left || Math.abs(b.top - row.top) > 4 || Math.abs(b.bottom - row.bottom) > 4
        || (i > 0 && b.left < rects[i - 1].right))
      || !intersectsRect(viewport, row)) continue;
    excludedNavigation.push({ bounds: row, tabs: tabs.map(node => JSON.stringify([
      node.package, node.className, node.resourceId, node.text, node.contentDesc, node.selected,
      node.bounds!.left, node.bounds!.top, node.bounds!.right, node.bounds!.bottom,
    ])).sort() });
  }
  excludedNavigation.sort((a, b) => a.bounds.top - b.bounds.top || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (excludedNavigation.length > 100) throw new Error("导航区域过多，无法确认滚动范围，未滑动。");
  if (excludedNavigation.length) viewport = { ...viewport, bottom: Math.min(viewport.bottom, ...excludedNavigation.map(item => item.bounds.top)) };
  return { viewport, excludedNavigation };
}

/** The actual swipe plus touch slop; content outside this corridor is not confirmation evidence. */
export function scrollConfirmationBounds(action: { fromX: number; fromY: number; toX: number; toY: number }, viewport: ScreenRect): ScreenRect {
  return intersect(viewport, { left: Math.min(action.fromX, action.toX) - 24, top: Math.min(action.fromY, action.toY) - 24,
    right: Math.max(action.fromX, action.toX) + 25, bottom: Math.max(action.fromY, action.toY) + 25 });
}

import type { DebugCommand } from "../../shared/debug-protocol";
import { clipBounds } from "../../shared/screen-coordinates";
import { flattenNodes } from "../../shared/tree-utils";
import type { UiNode, UiSnapshot } from "../../shared/types";
import type { DebugInputAction } from "./device-actions";

function sameIdentity(a: UiNode, b: UiNode) {
  return ["package", "className", "resourceId", "text", "contentDesc"].every(key => a[key as keyof UiNode] === b[key as keyof UiNode]);
}

export function sameControl(a: UiNode, b: UiNode) {
  return sameIdentity(a, b)
    && a.bounds && b.bounds && ["left", "top", "right", "bottom"].every(key => a.bounds![key as keyof typeof a.bounds] === b.bounds![key as keyof typeof b.bounds]);
}

function smallTranslation(a: UiNode, b: UiNode) {
  const before = a.bounds, after = b.bounds;
  if (!before || !after || !sameIdentity(a, b)) return false;
  const width = before.right - before.left, height = before.bottom - before.top;
  if (width <= 0 || height <= 0 || width !== after.right - after.left || height !== after.bottom - after.top) return false;
  const dx = Math.abs(after.left - before.left), dy = Math.abs(after.top - before.top);
  // Fixed screen-pixel tolerance, capped further for small targets. Never accept a resize.
  return dx <= Math.min(8, width * 0.1) && dy <= Math.min(8, height * 0.1);
}

function resolveControl(previous: UiNode, snapshot: UiSnapshot, packageName: string, capability: "clickable" | "scrollable" | null, before?: UiSnapshot) {
  if (!previous.resourceId && !previous.text && !previous.contentDesc) throw new Error("控件缺少稳定名称或 ID，无法安全自动操作。");
  const nodes = [...flattenNodes(snapshot.root!).values()];
  const candidates = nodes.filter(node => sameIdentity(previous, node) && node.package === packageName && node.visibleToUser);
  const uniqueBefore = before?.root && [...flattenNodes(before.root).values()]
    .filter(node => sameIdentity(previous, node) && node.package === packageName && node.visibleToUser).length === 1;
  // Repeated list identities still need exact bounds; never choose the nearest row.
  const matches = candidates.filter(node => sameControl(previous, node)
    || (capability !== "scrollable" && uniqueBefore && candidates.length === 1 && smallTranslation(previous, node)));
  if (matches.length !== 1) throw new Error("控件已移动、改变或匹配不唯一，请重新观察和定位。");
  const target = matches[0];
  if ((capability && !target[capability]) || !target.enabled || !target.bounds) throw new Error(capability === "clickable"
    ? "控件不可点击或未启用，请定位实际可点击的父控件。" : "控件不可滚动或未启用，请定位实际可滚动的容器。");
  const size = snapshot.captureGeometry?.screenshotSize;
  const bounds = size && clipBounds(target.bounds, size);
  if (!bounds) throw new Error("控件不在屏幕内。");
  return { target, nodes, bounds };
}

const related = (a: UiNode, b: UiNode) => a.id === b.id || a.id.startsWith(`${b.id}/`) || b.id.startsWith(`${a.id}/`);

export function resolveTap(previous: UiNode, snapshot: UiSnapshot, packageName: string, before?: UiSnapshot) {
  const { target, nodes, bounds } = resolveControl(previous, snapshot, packageName, "clickable", before);
  return checkedTap(target, nodes, bounds);
}

function checkedTap(target: UiNode, nodes: UiNode[], bounds: NonNullable<ReturnType<typeof clipBounds>>) {
  const x = Math.floor((bounds.left + bounds.right) / 2), y = Math.floor((bounds.top + bounds.bottom) / 2);
  const covers = (node: UiNode) => node.bounds && x >= node.bounds.left && x < node.bounds.right && y >= node.bounds.top && y < node.bounds.bottom;
  const passiveContainer = (node: UiNode) => {
    const outer = node.bounds, inner = target.bounds;
    if (node.clickable || !node.scrollable || node.package !== target.package || !outer || !inner) return false;
    return outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom
      && (outer.left < inner.left || outer.top < inner.top || outer.right > inner.right || outer.bottom > inner.bottom);
  };
  // shortcut: bounds do not prove Z order; add hit-test evidence if passive containers intercept taps.
  if (nodes.some(node => node.visibleToUser && (node.clickable || node.scrollable) && covers(node)
    && !related(node, target) && !passiveContainer(node))) throw new Error("点击位置与其他可操作控件重叠，无法确认遮挡关系，未点击。");
  return { node: target, x, y };
}

// Explicit opt-in: a uniquely named label anchors an otherwise anonymous row.
// Do not turn the default tap into an automatic ancestor fallback.
export function resolveParentTap(previous: UiNode, before: UiSnapshot, after: UiSnapshot, packageName: string) {
  const { target: anchor, nodes, bounds: anchorBounds } = resolveControl(previous, after, packageName, null, before);
  if (previous.clickable || anchor.clickable) throw new Error("目标本身可点击，请使用 self；未自动改选父控件。");
  const identity = (node: UiNode) => ["package", "className", "resourceId", "text", "contentDesc"]
    .every(key => previous[key as keyof UiNode] === node[key as keyof UiNode]);
  for (const tree of [before, after]) {
    if ([...flattenNodes(tree.root!).values()].filter(node => node.visibleToUser && identity(node)).length !== 1)
      throw new Error("文字锚点匹配不唯一，未点击父控件。");
  }
  const path = (root: UiNode, id: string) => {
    const parents = new Map<UiNode, UiNode | null>([[root, null]]), stack = [root];
    let found: UiNode | undefined;
    while (stack.length) {
      const node = stack.pop()!;
      if (node.id === id) { if (found) throw new Error("节点 ID 不唯一，未点击。"); found = node; }
      for (const child of node.children) { parents.set(child, node); stack.push(child); }
    }
    if (!found) throw new Error("文字锚点已消失，未点击。");
    const result: UiNode[] = [];
    for (let parent = parents.get(found); parent; parent = parents.get(parent)) {
      result.push(parent);
      if (parent.clickable) return result;
    }
    throw new Error("文字锚点没有可点击父控件。");
  };
  const oldPath = path(before.root!, previous.id), newPath = path(after.root!, anchor.id);
  if (oldPath.length !== newPath.length || oldPath.some((node, index) => !smallTranslation(node, newPath[index])
    || ["enabled", "visibleToUser", "clickable", "scrollable"].some(key => node[key as keyof UiNode] !== newPath[index][key as keyof UiNode])))
    throw new Error("文字与父控件的关系或位置已变化，未点击。");
  const target = newPath.at(-1)!;
  if (newPath.some(node => node.package !== packageName || !node.enabled || !node.visibleToUser)
    || target.scrollable || !target.bounds) throw new Error("父控件不可用或属于滚动区域，未点击。");
  const bounds = clipBounds(target.bounds, after.captureGeometry!.screenshotSize!);
  if (!bounds || anchorBounds.left < bounds.left || anchorBounds.top < bounds.top
    || anchorBounds.right > bounds.right || anchorBounds.bottom > bounds.bottom)
    throw new Error("文字不在父控件可见区域内，未点击。");
  const hit = checkedTap(target, nodes, bounds);
  if (nodes.some(node => node.visibleToUser && node.clickable && node.id.startsWith(`${target.id}/`)
    && node.bounds && hit.x >= node.bounds.left && hit.x < node.bounds.right && hit.y >= node.bounds.top && hit.y < node.bounds.bottom))
    throw new Error("父控件点击位置存在可操作子控件，未点击。");
  return { ...hit, anchor };
}

export function resolveScroll(previous: UiNode, snapshot: UiSnapshot, packageName: string,
  options: Pick<Extract<DebugCommand, { name: "scroll_node" }>["input"], "direction" | "distance" | "durationMs">) {
  const { target, nodes, bounds } = resolveControl(previous, snapshot, packageName, "scrollable");
  const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
  if (Math.min(width, height) < 48) throw new Error("可见滚动区域太小，未滑动。");
  const horizontal = options.direction === "left" || options.direction === "right";
  const length = horizontal ? width : height;
  const half = Math.min(length * options.distance / 2, length / 2 - Math.max(16, length * 0.1));
  if (half * 2 < 64) throw new Error("滑动距离不足 64px，可能被当作点击；请增大距离或选择更大的滚动区域。");
  const sign = options.direction === "down" || options.direction === "right" ? 1 : -1;
  const x = (bounds.left + bounds.right) / 2, y = (bounds.top + bounds.bottom) / 2;
  const action: Extract<DebugInputAction, { kind: "swipe" }> = {
    kind: "swipe", fromX: Math.floor(x + (horizontal ? sign * half : 0)), fromY: Math.floor(y + (horizontal ? 0 : sign * half)),
    toX: Math.floor(x - (horizontal ? sign * half : 0)), toY: Math.floor(y - (horizontal ? 0 : sign * half)), durationMs: options.durationMs,
  };
  // ponytail: conservative straight path; reject nested/overlapping scrollers instead of guessing gesture routing.
  const intersects = (node: UiNode) => node.bounds && Math.max(action.fromX, action.toX) >= node.bounds.left
    && Math.min(action.fromX, action.toX) < node.bounds.right && Math.max(action.fromY, action.toY) >= node.bounds.top
    && Math.min(action.fromY, action.toY) < node.bounds.bottom;
  if (nodes.some(node => node.visibleToUser && intersects(node) && ((!related(node, target) && (node.clickable || node.scrollable))
    || (node.scrollable && node.id.startsWith(`${target.id}/`))))) throw new Error("滑动路径被其他控件或嵌套滚动区域占用，请重新定位滚动控件。");
  return { node: target, action };
}

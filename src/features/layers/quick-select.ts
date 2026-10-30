import type { UiNode } from "../../../shared/types";
import { nodeDisplayLabel, nodeShortClass } from "../../../shared/tree-utils";
import { indexLayerTree } from "./presentation";
import { pointInQuad, projectPlane, cameraRotation } from "./projection";
import type { Point, ProjectedPlane, Rect } from "./types";

export function quickSelectModifier(event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, platform: string) {
  return !event.altKey && !event.shiftKey && (/Mac|iPhone|iPad|iPod/.test(platform)
    ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

export const QUICK_SELECT_PAGE_SIZE = 30;
export type QuickSelectCandidate = { node: UiNode; label: string; className: string; path: string; bounds: Rect; depth: number };
export type QuickSelectResult = {
  context: object; root: UiNode; branch: UiNode | null; point: Point | null;
  status: "ready" | "no-plane" | "not-collapsed" | "missing-image" | "unsupported" | "stale";
  message: string; candidates: QuickSelectCandidate[]; total: number; page: number; pages: number; unsupported: number;
};

export function quickSelectMessage(context: object, root: UiNode, status: QuickSelectResult["status"], message: string): QuickSelectResult {
  return { context, root, status, message, branch: null, point: null, candidates: [], total: 0, page: 0, pages: 0, unsupported: 0 };
}

function rectOf(node: UiNode): Rect | null {
  const b = node.bounds;
  return b && [b.left, b.top, b.right, b.bottom].every(Number.isFinite) && b.right > b.left && b.bottom > b.top
    ? { left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top } : null;
}
function contains(rect: Rect, point: Point) {
  return point.x >= rect.left && point.y >= rect.top && point.x < rect.left + rect.width && point.y < rect.top + rect.height;
}
function intersect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  const width = Math.min(a.left + a.width, b.left + b.width) - left, height = Math.min(a.top + a.height, b.top + b.height) - top;
  return width > 0 && height > 0 ? { left, top, width, height } : null;
}
function transformUnknown(node: UiNode) {
  const attrs = node.attributes;
  if (attrs?.["image-capture-placement"] === "unsupported-context-legacy-fallback") return true;
  for (const key of ["rotation", "rotation-x", "rotation-y", "sdk-rotation", "sdk-rotationX", "sdk-rotationY", "qml-rotation"]) {
    if (attrs?.[key] !== undefined && (!Number.isFinite(Number(attrs[key])) || Number(attrs[key]) % 360 !== 0)) return true;
  }
  for (const key of ["scale-x", "scale-y", "sdk-scaleX", "sdk-scaleY"]) {
    if (attrs?.[key] !== undefined && (!Number.isFinite(Number(attrs[key])) || Number(attrs[key]) !== 1)) return true;
  }
  // Own-bitmap placement does not certify a native/local folded group map.
  // In particular, its clipped/scaled screen rectangle may differ from the
  // legacy bounds used by local subtree composition.
  const b = rectOf(node), p = node.layerCapturePlacement;
  if (p && b && [p.screen.left - b.left, p.screen.top - b.top, p.screen.width - b.width, p.screen.height - b.height].some(delta => Math.abs(delta) > .01)) return true;
  return false;
}
type Clip = { rect: Rect; radius: number };
function insideClip(clip: Clip, point: Point) {
  if (!contains(clip.rect, point)) return false;
  const r = Math.min(clip.radius, clip.rect.width / 2, clip.rect.height / 2);
  if (!r) return true;
  const x = Math.max(clip.rect.left + r, Math.min(clip.rect.left + clip.rect.width - r, point.x));
  const y = Math.max(clip.rect.top + r, Math.min(clip.rect.top + clip.rect.height - r, point.y));
  return (point.x - x) ** 2 + (point.y - y) ** 2 <= r ** 2;
}
function ownClips(node: UiNode): Clip[] | null {
  const b = rectOf(node), a = node.attributes;
  if (!b) return [];
  const clips: Clip[] = [];
  if (a?.["qml-clip"] === "true") clips.push({ rect: b, radius: 0 });
  if (a?.["clip-to-outline"] === "true") {
    const [l, t, r, d, radius] = ["Left", "Top", "Right", "Bottom", "Radius"].map(key => Number(a[`sdk-outline${key}`]));
    if (![l, t, r, d, radius].every(Number.isFinite) || r <= l || d <= t || radius < 0) return null;
    clips.push({ rect: { left: b.left + l, top: b.top + t, width: r - l, height: d - t }, radius });
  }
  return clips;
}
function childrenClips(node: UiNode): Clip[] | null {
  const b = rectOf(node), a = node.attributes;
  if (!b) return [];
  const clips: Clip[] = [];
  if (a?.["clip-children"] === "true") clips.push({ rect: b, radius: 0 });
  if (a?.["clip-to-padding"] === "true") {
    const [l, t, r, d] = ["left", "top", "right", "bottom"].map(side => Number(a[`padding-${side}`] ?? 0));
    if (![l, t, r, d].every(value => Number.isFinite(value) && value >= 0)) return null;
    clips.push({ rect: { left: b.left + l, top: b.top + t, width: Math.max(0, b.width - l - r), height: Math.max(0, b.height - t - d) }, radius: 0 });
  }
  return clips;
}

// Perspective-correct interpolation uses the same two triangles as the GPU.
// A linear interpolation of a rotated screen rectangle gives the wrong source point.
export function pointOnPaintedPlane(projected: ProjectedPlane, point: Point): Point | null {
  const painted = projected.painted, mapping = painted?.plane.quickSelect;
  if (!painted || !mapping || !painted.visible || !pointInQuad(point, projected.corners)) return null;
  const weights = painted.cornerDepths.map(depth => painted.camera.distance - depth);
  if (weights.some(w => !Number.isFinite(w) || w <= 1) || projected.corners.length !== 4) return null;
  const units = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  for (const indices of [[0, 1, 3], [3, 1, 2]]) {
    const [a, b, c] = indices.map(i => projected.corners[i]);
    const determinant = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(determinant) < 1e-6) continue;
    const u = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / determinant;
    const v = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / determinant;
    const bary = [u, v, 1 - u - v];
    if (bary.some(value => value < -1e-7)) continue;
    const corrected = bary.map((value, index) => value / weights[indices[index]]), divisor = corrected.reduce((sum, value) => sum + value, 0);
    const x = corrected.reduce((sum, value, index) => sum + value * units[indices[index]].x, 0) / divisor;
    const y = corrected.reduce((sum, value, index) => sum + value * units[indices[index]].y, 0) / divisor;
    return { x: mapping.screen.left + x * mapping.screen.width, y: mapping.screen.top + y * mapping.screen.height };
  }
  return null;
}

export function candidateOnPaintedPlane(projected: ProjectedPlane, candidate: QuickSelectCandidate): Point[] | null {
  const painted = projected.painted, source = painted?.plane.quickSelect?.screen;
  if (!painted || !source || !painted.visible) return null;
  const b = intersect(source, candidate.bounds);
  if (!b) return null;
  const p = painted.plane;
  const rect = { left: p.rect.left + (b.left - source.left) / source.width * p.rect.width,
    top: p.rect.top + (b.top - source.top) / source.height * p.rect.height,
    width: b.width / source.width * p.rect.width, height: b.height / source.height * p.rect.height };
  return projectPlane({ ...p, rect }, painted.pivot, painted.camera, cameraRotation(painted.camera)).corners;
}

export function findQuickSelectCandidates(input: {
  context: object; root: UiNode; branch: UiNode; point: Point; hidden: ReadonlySet<string>;
  focusedNode?: UiNode | null; focusKind?: "branch" | "layer"; page?: number; index?: ReturnType<typeof indexLayerTree>;
}): QuickSelectResult {
  const { context, root, branch, point, hidden, focusedNode, focusKind } = input;
  const index = input.index ?? indexLayerTree(root);
  if (index.nodes.get(branch.id) !== branch || focusedNode && index.nodes.get(focusedNode.id) !== focusedNode) {
    return quickSelectMessage(context, root, "stale", "页面已更新，请重新点选折叠画面。");
  }
  const path: UiNode[] = [];
  for (let id: string | null | undefined = branch.id; id; id = index.parents.get(id)) path.unshift(index.nodes.get(id)!);
  if (focusedNode && (focusKind === "layer" || !path.includes(focusedNode))) {
    return quickSelectMessage(context, root, "unsupported", "当前聚焦范围不包含这条分支，请退出聚焦后重试。");
  }
  let inherited: Clip[] = [];
  for (const node of path) {
    if (!node.visibleToUser || hidden.has(node.id) || Number(node.attributes?.["effective-alpha"] ?? node.attributes?.alpha ?? 1) === 0 || node.layerCapturePlacement?.hidden) {
      return quickSelectMessage(context, root, "unsupported", "这条分支或祖先已隐藏，无法选择内部控件。");
    }
    const clips = ownClips(node), children = childrenClips(node);
    if (transformUnknown(node) || !clips || !children) return quickSelectMessage(context, root, "unsupported", "这条分支的变换或裁剪无法可靠映射，请展开后从层级树选择。");
    inherited = [...inherited, ...clips];
    if (node !== branch) inherited.push(...children);
  }
  if (inherited.some(clip => !insideClip(clip, point))) return quickSelectMessage(context, root, "unsupported", "这个位置被祖先裁剪，不包含可选择的内部控件。");
  const branchChildren = childrenClips(branch)!;
  const pending = branch.children.slice().reverse().map(node => ({ node, clips: [...inherited, ...branchChildren], path: [nodeDisplayLabel(branch)], depth: 1 }));
  const matches: QuickSelectCandidate[] = [];
  let unsupported = 0;
  while (pending.length) {
    const current = pending.pop()!, node = current.node;
    if (!node.visibleToUser || hidden.has(node.id) || Number(node.attributes?.["effective-alpha"] ?? node.attributes?.alpha ?? 1) === 0 || node.layerCapturePlacement?.hidden) continue;
    const own = ownClips(node), children = childrenClips(node);
    if (transformUnknown(node) || !own || !children) { unsupported++; continue; }
    const clips = [...current.clips, ...own];
    if (clips.some(clip => !insideClip(clip, point))) continue;
    let bounds = rectOf(node);
    for (const clip of clips) if (bounds) bounds = intersect(bounds, clip.rect);
    if (bounds && contains(bounds, point)) matches.push({ node, bounds, label: nodeDisplayLabel(node), className: nodeShortClass(node),
      path: [...current.path, nodeDisplayLabel(node)].join(" › "), depth: current.depth });
    const childPath = [...current.path, nodeDisplayLabel(node)];
    for (let i = node.children.length - 1; i >= 0; i--) pending.push({ node: node.children[i], clips: [...clips, ...children], path: childPath, depth: current.depth + 1 });
  }
  // Deep controls appear before their enclosing containers; equal-depth siblings
  // retain tree order. This is a bounds list, never a claim about painted pixels.
  matches.sort((a, b) => b.depth - a.depth);
  const pages = Math.ceil(matches.length / QUICK_SELECT_PAGE_SIZE), page = Math.max(0, Math.min(Math.max(0, pages - 1), Math.trunc(input.page ?? 0) || 0));
  return { context, root, branch, point, status: "ready", message: matches.length ? "按边界匹配，确认后展开并定位" : "这个位置没有匹配的内部控件。可换个位置点选。",
    total: matches.length, page, pages, unsupported, candidates: matches.slice(page * QUICK_SELECT_PAGE_SIZE, (page + 1) * QUICK_SELECT_PAGE_SIZE) };
}

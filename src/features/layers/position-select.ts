import type { UiNode } from "../../../shared/types";
import { nodeDisplayLabel, nodeShortClass } from "../../../shared/tree-utils";
import { indexLayerTree } from "./presentation";
import { paintedPixelAt, pointInQuad } from "./projection";
import { filterQuickSelectResult, type QuickSelectCandidate, type QuickSelectResult } from "./quick-select";
import type { Point, ProjectedPlane } from "./types";

export type PositionLayerKind = "painted" | "unconfirmed" | "transparent" | "structure" | "invisible";
export const positionLayerLabels: Record<PositionLayerKind, string> = {
  painted: "此处有画面", unconfirmed: "画面未确认", transparent: "此处透明", structure: "无自身画面", invisible: "不可见布局",
};
const order: Record<PositionLayerKind, number> = { painted: 0, unconfirmed: 1, transparent: 2, structure: 3, invisible: 4 };

// Inspect the rendered scope, including quiet/suppressed container outlines.
// This never expands hidden descendants or guesses pixels from the full screenshot.
export function findPositionCandidates(context: object, root: UiNode, point: Point, planes: readonly ProjectedPlane[], index = indexLayerTree(root)): QuickSelectResult {
  const groups = new Map<UiNode, ProjectedPlane[]>();
  for (const projected of planes) {
    const plane = projected.painted?.plane;
    if (!plane || !plane.hitTestable || plane.opacity <= 0 || index.nodes.get(projected.node.id) !== projected.node) continue;
    const group = groups.get(projected.node) ?? [];
    group.push(projected); groups.set(projected.node, group);
  }
  const candidates: QuickSelectCandidate[] = [];
  for (const [node, group] of groups) {
    if (!group.some(plane => pointInQuad(point, plane.corners))) continue;
    const surface = group.find(plane => plane.painted?.plane.hitPolicy === "content" && plane.painted.visible);
    const covered = surface && pointInQuad(point, surface.corners);
    const pixel = covered ? paintedPixelAt(surface, point) : false;
    const kind: PositionLayerKind = group.some(p => p.painted?.plane.deviceInvisible) ? "invisible"
      : surface ? pixel === true ? "painted" : pixel === false ? "transparent" : "unconfirmed"
      : group.some(p => p.painted?.plane.quietStructure) ? "structure" : "unconfirmed";
    const path: string[] = [];
    for (let id: string | null | undefined = node.id; id; id = index.parents.get(id)) path.unshift(nodeDisplayLabel(index.nodes.get(id)!));
    const b = node.bounds;
    if (!b) continue;
    candidates.push({ node, kind, label: nodeDisplayLabel(node), className: nodeShortClass(node), path: path.join(" › "), depth: path.length,
      bounds: { left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top } });
  }
  candidates.sort((a, b) => order[a.kind!] - order[b.kind!]);
  return filterQuickSelectResult({ context, root, scope: "position", branch: null, point, status: "ready",
    message: candidates.length ? "优先列出此处有画面的图层；透明容器也可选择。仅包含当前展开范围。" : "此位置没有已展开的图层。可换个位置，或从层级树展开后重试。",
    total: candidates.length, page: 0, pages: 0, unsupported: 0, candidates: [], allCandidates: candidates });
}

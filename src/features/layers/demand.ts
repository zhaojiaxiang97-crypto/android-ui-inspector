import { cameraRotation, projectPlane } from "./projection";
import type { LayerCamera, Rect, ScenePivot, ScenePlane } from "./types";

// A conservative projected bounding box also includes tilted planes which cross
// the viewport even when none of their corners is inside it. Pan is a CSS offset.
export function layerDemandOrder(planes: readonly ScenePlane[], camera: LayerCamera, pivot: ScenePivot, viewport: Rect, selectedId?: string) {
  const left = viewport.left - camera.panX, top = viewport.top - camera.panY;
  const rotation = cameraRotation(camera);
  const visible: string[] = [], selected: string[] = [];
  const seen = new Set<string>();
  for (const plane of planes) {
    if (plane.kind === "selection" || plane.kind === "hover") continue;
    const id = plane.id.replace(/:parent$/, "");
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === selectedId) { selected.push(id); continue; }
    const { corners } = projectPlane(plane, pivot, camera, rotation);
    if (!corners.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
        || !corners.some(point => point.depth < camera.distance - 1)) continue;
    const xs = corners.map(point => point.x), ys = corners.map(point => point.y);
    if (Math.max(...xs) >= left && Math.min(...xs) <= left + viewport.width
        && Math.max(...ys) >= top && Math.min(...ys) <= top + viewport.height) visible.push(id);
  }
  return [...selected, ...visible];
}

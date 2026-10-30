import { alphaMaskContains } from "./texture-alpha";
import { type LayerCamera, type ScenePivot, type ScenePlane, type Point, type ProjectedPlane } from "./types";

// Invisible layouts have no painted interior. Pick their projected edges only,
// so a hidden full-screen container cannot intercept visible controls below it.
export function pointNearQuadEdge(point: Point, corners: readonly Point[], tolerance = 6) {
  return corners.some((a, index) => {
    const b = corners[(index + 1) % corners.length], dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
    return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2 <= tolerance * tolerance;
  });
}


function radians(value: number) {
  return value * Math.PI / 180;
}

export function cameraRotation(camera: LayerCamera) {
  const yaw = radians(-camera.azimuth);
  const pitch = radians(-camera.elevation);
  const roll = radians(-camera.roll);
  return { cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch), cr: Math.cos(roll), sr: Math.sin(roll) };
}

export function rotatePoint(x: number, y: number, z: number, pivot: ScenePivot, rotation: ReturnType<typeof cameraRotation>) {
  const { cy, sy, cp, sp, cr, sr } = rotation;
  const centeredX = x - pivot.x;
  const centeredY = pivot.y - y;
  const centeredZ = z - pivot.z;
  // Match SceneKit Euler angles: pitch, then yaw, then roll (Rz * Ry * Rx).
  const yPitch = cp * centeredY - sp * centeredZ;
  const zPitch = sp * centeredY + cp * centeredZ;
  const xYaw = cy * centeredX + sy * zPitch;
  const zYaw = -sy * centeredX + cy * zPitch;
  const xRoll = cr * xYaw - sr * yPitch;
  const yRoll = sr * xYaw + cr * yPitch;
  return { x: xRoll, y: yRoll, depth: zYaw };
}

export function projectPoint(x: number, y: number, z: number, pivot: ScenePivot, camera: LayerCamera, rotation: ReturnType<typeof cameraRotation>) {
  const point = rotatePoint(x, y, z, pivot, rotation);
  const scale = camera.distance / Math.max(1, camera.distance - point.depth);
  return { x: pivot.x + point.x * scale, y: pivot.y - point.y * scale, depth: point.depth };
}

export function projectPlane(plane: ScenePlane, pivot: ScenePivot, camera: LayerCamera, rotation: ReturnType<typeof cameraRotation>) {
  const { left, top, width: planeWidth, height: planeHeight } = plane.rect;
  const corners = [
    projectPoint(left, top, plane.z, pivot, camera, rotation),
    projectPoint(left + planeWidth, top, plane.z, pivot, camera, rotation),
    projectPoint(left + planeWidth, top + planeHeight, plane.z, pivot, camera, rotation),
    projectPoint(left, top + planeHeight, plane.z, pivot, camera, rotation),
  ];
  return { corners, depth: corners.reduce((sum, point) => sum + point.depth, 0) / corners.length };
}

export function pointInQuad(point: Point, corners: readonly Point[]) {
  let hasPositive = false;
  let hasNegative = false;
  for (let index = 0; index < corners.length; index += 1) {
    const start = corners[index];
    const end = corners[(index + 1) % corners.length];
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    hasPositive ||= cross > 0.1;
    hasNegative ||= cross < -0.1;
    if (hasPositive && hasNegative) return false;
  }
  return true;
}

export function pointHitsProjectedPlane(point: Point, plane: ProjectedPlane) {
  if (plane.painted?.visible === false || plane.painted?.plane.hitPolicy === "none") return false;
  return pointInQuad(point, plane.corners)
    && (!(plane.painted?.edgeOnly || plane.painted?.plane.deviceInvisible || plane.painted?.plane.hitPolicy === "edge") || pointNearQuadEdge(point, plane.corners))
    && (plane.painted?.edgeOnly || plane.painted?.plane.hitPolicy === "edge" || paintedPixelAt(plane, point) !== false);
}

// Input follows front-to-back paint order. Visible content has priority over
// structural edges; empty container interiors never obstruct a real control.
export function pickProjectedPlane(point: Point, planes: readonly ProjectedPlane[]) {
  let edge: ProjectedPlane | undefined;
  for (const plane of planes) {
    if (!pointHitsProjectedPlane(point, plane)) continue;
    if (!(plane.painted?.edgeOnly || plane.painted?.plane.deviceInvisible || plane.painted?.plane.hitPolicy === "edge")) return plane;
    edge ??= plane;
  }
  return edge;
}

// Perspective-correct interpolation uses the same two triangles as the GPU.
// A linear interpolation of a rotated screen rectangle gives the wrong source point.
export function pointOnProjectedPlane(projected: ProjectedPlane, point: Point): Point | null {
  const painted = projected.painted;
  if (!painted || !pointInQuad(point, projected.corners)) return null;
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
    return { x, y };
  }
  return null;
}


export function paintedPixelAt(projected: ProjectedPlane, point: Point): boolean | undefined {
  const painted = projected.painted;
  if (!painted?.alphaMask) return undefined;
  const unit = pointOnProjectedPlane(projected, point);
  if (!unit) return undefined;
  const { source, textureSize } = painted.plane;
  return alphaMaskContains(painted.alphaMask, (source.left + unit.x * source.width) / textureSize.width, (source.top + unit.y * source.height) / textureSize.height);
}

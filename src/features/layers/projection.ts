import { type LayerCamera, type ScenePivot, type ScenePlane, type Point } from "./types";

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
  const xYaw = cy * centeredX + sy * centeredZ;
  const zYaw = -sy * centeredX + cy * centeredZ;
  const yPitch = cp * centeredY - sp * zYaw;
  const zPitch = sp * centeredY + cp * zYaw;
  const xRoll = cr * xYaw - sr * yPitch;
  const yRoll = sr * xYaw + cr * yPitch;
  return { x: xRoll, y: yRoll, depth: zPitch };
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

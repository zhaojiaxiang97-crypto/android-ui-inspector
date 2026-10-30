import type { PixelSize } from '../../../shared/types';
import type { LayerCamera, ScenePivot } from './types';
import type { layerFraming } from './framing';
import { cameraRotation, rotatePoint } from './projection';

type Frames = ReturnType<typeof layerFraming>['frames'];
// Camera controls use a 400-unit screen, independent of capture pixel density.
// Geometry is scaled for the canvas, so the eye distance must use that same
// scale. Algebraically this is a fixed scene/eye with focal-length zoom.
export function sceneCameraDistance(camera: LayerCamera, size: PixelSize, frames: Frames, center: ScenePivot) {
  let radius = 0;
  for (const { bounds: b, z } of frames) {
    const x = Math.max(Math.abs(b.left - center.x), Math.abs(b.right - center.x));
    const y = Math.max(Math.abs(b.top - center.y), Math.abs(b.bottom - center.y));
    radius = Math.max(radius, Math.hypot(x, y, z - center.z));
  }
  // Extremely deep complete scenes must remain in front of the eye at every
  // rotation. This bound depends on scene geometry, never viewport or zoom.
  return Math.max(camera.distance * size.height / 400, radius * 1.1, 1);
}

export function cameraAtSceneScale(camera: LayerCamera, distance: number, scale: number): LayerCamera {
  return { ...camera, distance: distance * scale };
}

export function fitSceneScale(frames: Frames, center: ScenePivot, camera: LayerCamera, distance: number, width: number, height: number) {
  const rotation = cameraRotation(camera);
  const halfWidth = Math.max(1, width) * .43, halfHeight = Math.max(1, height) * .43;
  let scale = 1;
  for (const { bounds: b, z } of frames) for (const x of [b.left, b.right]) for (const y of [b.top, b.bottom]) {
    const point = rotatePoint(x, y, z, center, rotation);
    const perspective = distance / Math.max(1, distance - point.depth);
    if (point.x) scale = Math.min(scale, halfWidth / Math.abs(point.x * perspective));
    if (point.y) scale = Math.min(scale, halfHeight / Math.abs(point.y * perspective));
  }
  return scale;
}

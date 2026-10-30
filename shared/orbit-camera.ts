export type OrbitCamera = {
  /** CSS perspective length in px; this is the camera's distance from the world. */
  distance: number;
  azimuth: number;
  elevation: number;
  roll: number;
  layerGap: number;
  panX: number;
  panY: number;
};

export type OrbitRotationMode = "free" | "horizontal";

export const ORBIT_PARAMETER_LIMITS = {
  layerGap: { min: 24, max: 240, step: 8 },
  distance: { min: 720, max: 1800, step: 40 },
} as const;
export type OrbitParameter = keyof typeof ORBIT_PARAMETER_LIMITS;

export function parseOrbitParameter(parameter: OrbitParameter, draft: string, current: number): { value: number; error: null } | { value: null; error: string } {
  const text = draft.trim(), value = Number(text), { min, max, step } = ORBIT_PARAMETER_LIMITS[parameter];
  if (!text) return { value: null, error: "请输入数值。" };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !Number.isFinite(value)) return { value: null, error: "请输入有限数值。" };
  if (value < min || value > max) return { value: null, error: `范围为 ${min}–${max} px。` };
  // The existing default distance is 1100: keeping it is not a new step change.
  if (value !== current && (value - min) % step !== 0) return { value: null, error: `以 ${min} px 为起点，每次增加 ${step} px。` };
  return { value, error: null };
}

export function constrainOrbitCamera(camera: OrbitCamera, mode: OrbitRotationMode): OrbitCamera {
  return mode === "horizontal" && (camera.elevation !== 0 || camera.roll !== 0) ? { ...camera, elevation: 0, roll: 0 } : camera;
}

// Keep full-screen planes readable instead of letting an oblique view turn
// them into edge-on blades. Yaw remains unrestricted for the full orbit.
export const MIN_ELEVATION = -65;
export const MAX_ELEVATION = 65;

export function wrapDegrees(value: number) {
  if (!Number.isFinite(value)) return 0;
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

export function clampElevation(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, value));
}

export function orbitFromDrag(camera: OrbitCamera, dx: number, dy: number, sensitivity = 0.45): OrbitCamera {
  const safeSensitivity = Number.isFinite(sensitivity) ? sensitivity : 0.45;
  return {
    ...camera,
    azimuth: wrapDegrees(camera.azimuth + dx * safeSensitivity),
    elevation: clampElevation(camera.elevation + dy * safeSensitivity),
  };
}

export function orbitFromKeys(camera: OrbitCamera, key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight", step = 6): OrbitCamera {
  const safeStep = Number.isFinite(step) ? Math.abs(step) : 6;
  return orbitFromDrag(camera,
    key === "ArrowLeft" ? -safeStep : key === "ArrowRight" ? safeStep : 0,
    key === "ArrowUp" ? -safeStep : key === "ArrowDown" ? safeStep : 0,
    1,
  );
}

export function cameraTransform(camera: Pick<OrbitCamera, "azimuth" | "elevation" | "roll">) {
  // The scene is the world and the camera orbits around it. Applying the
  // inverse camera rotation keeps the screenshot center fixed in the viewport.
  return `rotateZ(${-camera.roll}deg) rotateX(${-camera.elevation}deg) rotateY(${-camera.azimuth}deg)`;
}

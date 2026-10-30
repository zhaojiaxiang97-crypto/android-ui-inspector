import type { LayerCamera, LayerPresentation, ScenePlane, ScenePivot } from "./types";

export const LAYER_MOTION_DURATION = 220;
export const LAYER_MOTION_FALLBACK_LIMIT = 1200;
export const MAX_MOTION_PLANES = 512;

export type LayerMotionFrame = { planes: readonly ScenePlane[]; presentation: LayerPresentation };
export type LayerMotion = { from: LayerMotionFrame; started: number };

export function layerPlaneNodeId(id: string) {
  return id.replace(/:(parent|selection|hover|motion)$/, "");
}

export function motionProgress(started: number, now: number) {
  return Math.max(0, Math.min(1, (now - started) / LAYER_MOTION_DURATION));
}

export function motionAmount(progress: number) {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, progress)), 3);
}

export function mixCamera(from: LayerCamera, to: LayerCamera, progress: number): LayerCamera {
  const amount = motionAmount(progress);
  return Object.fromEntries(Object.keys(to).map(key => {
    const property = key as keyof LayerCamera;
    return [property, from[property] + (to[property] - from[property]) * amount];
  })) as LayerCamera;
}

function nearestDepth(id: string, depths: ReadonlyMap<string, number>, parents: ReadonlyMap<string, string | null>) {
  let parent: string | null | undefined = id;
  while (parent) {
    const depth = depths.get(parent);
    if (depth !== undefined) return depth;
    parent = parents.get(parent);
  }
  return undefined;
}

function planeInFrame(plane: ScenePlane, source: LayerPresentation, target: LayerPresentation, depth: number): ScenePlane {
  const scale = Math.max(Number.EPSILON, source.scale);
  return { ...plane, z: depth * target.scale, rect: {
    left: target.pivot.x + ((plane.rect.left - source.pivot.x) / scale + source.center.x - target.center.x) * target.scale,
    top: target.pivot.y + ((plane.rect.top - source.pivot.y) / scale + source.center.y - target.center.y) * target.scale,
    width: plane.rect.width / scale * target.scale,
    height: plane.rect.height / scale * target.scale,
  } };
}

// Retiring layers only use existing pixels; they never take part in picking.
// Keep the union bounded even when a second command reverses the first motion.
export function sampleLayerMotion(motion: LayerMotion, target: LayerMotionFrame, parents: ReadonlyMap<string, string | null>, progress: number,
  retiringReady: (plane: ScenePlane) => boolean = () => true): LayerMotionFrame {
  const amount = motionAmount(progress), from = motion.from.presentation;
  const mix = (left: number, right: number) => left + (right - left) * amount;
  const center: ScenePivot = { x: mix(from.center.x, target.presentation.center.x), y: mix(from.center.y, target.presentation.center.y), z: mix(from.center.z, target.presentation.center.z) };
  const scale = mix(from.scale, target.presentation.scale);
  const presentation: LayerPresentation = { depths: new Map(), center, scale, pivot: {
    x: mix(from.pivot.x, target.presentation.pivot.x), y: mix(from.pivot.y, target.presentation.pivot.y), z: center.z * scale,
  } };
  const previous = new Map<string, ScenePlane[]>();
  for (const plane of motion.from.planes) {
    if (plane.kind === "selection" || plane.kind === "hover") continue;
    const id = layerPlaneNodeId(plane.id);
    previous.set(id, [...(previous.get(id) ?? []), plane]);
  }
  const targets = new Map(target.planes.filter(plane => plane.kind !== "selection" && plane.kind !== "hover").map(plane => [layerPlaneNodeId(plane.id), plane]));
  const planes = target.planes.map(plane => {
    const id = layerPlaneNodeId(plane.id), choices = previous.get(id);
    const previousPlane = choices?.find(item => item.textureSrc === plane.textureSrc && item.kind === plane.kind) ?? choices?.[0];
    const toDepth = target.presentation.depths.get(id) ?? plane.z / target.presentation.scale;
    const fromDepth = previousPlane ? previousPlane.z / from.scale : nearestDepth(id, from.depths, parents) ?? toDepth;
    const depth = mix(fromDepth, toDepth);
    presentation.depths.set(id, depth);
    const transformed = planeInFrame(plane, target.presentation, presentation, depth);
    if (previousPlane?.textureSrc === plane.textureSrc && previousPlane?.kind === plane.kind) transformed.opacity = mix(previousPlane.opacity, plane.opacity);
    else if (plane.kind !== "selection" && plane.kind !== "hover" && plane.kind !== "outline") transformed.opacity *= amount;
    return transformed;
  });
  let room = Math.max(0, MAX_MOTION_PLANES - targets.size);
  for (const [id, choices] of previous) {
    const targetPlane = targets.get(id);
    // Prefer the already painted own/group source when reversing a transition.
    const plane = choices.find(item => !targetPlane || item.textureSrc !== targetPlane.textureSrc || item.kind !== targetPlane.kind);
    if (!plane || !room) continue;
    const ready = retiringReady(plane);
    if (progress >= 1 && ready) continue;
    const targetDepth = nearestDepth(id, target.presentation.depths, parents);
    if (targetDepth === undefined) continue;
    const depth = mix(plane.z / from.scale, targetDepth);
    const retired = planeInFrame(plane, from, presentation, depth);
    retired.id = `${id}:motion`;
    retired.node = null; retired.hitTestable = false;
    retired.opacity *= ready ? 1 - amount : 1;
    if (retired.opacity <= 0) continue;
    planes.push(retired); room--;
    if (!presentation.depths.has(id)) presentation.depths.set(id, depth);
  }
  return { planes, presentation };
}

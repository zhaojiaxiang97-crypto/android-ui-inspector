import { measureBounds, rectMetrics, type BoundsMeasurement } from "./node-metrics";
import type { UiBounds } from "./types";

export type MeasurementCardEndpoint = { id: string; label: string; bounds: UiBounds };
export type MeasurementCardData = {
  anchor: MeasurementCardEndpoint;
  target: MeasurementCardEndpoint;
  measurement: BoundsMeasurement;
  alignments: readonly string[];
};
type EndpointInput = Omit<MeasurementCardEndpoint, "bounds"> & { bounds: UiBounds | null };
export type MeasurementCardViewport = { left: number; top: number; width: number; height: number };

const relationLabels: Record<BoundsMeasurement["relation"], string> = {
  gap: "外框分离", contains: "A 包含 B", inside: "B 包含 A",
  overlap: "外框重叠", touching: "边缘相接", equal: "边界重合",
};
export const measurementCardRelationLabel = (data: MeasurementCardData) => relationLabels[data.measurement.relation];
export const measurementCardNumber = (value: number) => String(Number(value.toFixed(2)));

// Both measurement values and alignment use original device bounds. SVG scaling
// only affects drawing, never the values shown to the user.
export function measurementCardData(anchor: EndpointInput, target: EndpointInput): MeasurementCardData | null {
  if (anchor.id === target.id) return null;
  const a = rectMetrics(anchor.bounds), b = rectMetrics(target.bounds);
  if (!a || !b || ![a.width, a.height, a.centerX, a.centerY, b.width, b.height, b.centerX, b.centerY].every(Number.isFinite)) return null;
  const measurement = measureBounds(anchor.bounds, target.bounds);
  if (!measurement || !measurement.guides.every(guide => [guide.from.x, guide.from.y, guide.to.x, guide.to.y,
    ...guide.distances.map(distance => distance.value)].every(Number.isFinite))) return null;
  const alignments: string[] = [];
  if (measurement.relation === "equal") alignments.push("四边与中心均对齐");
  else {
    if (a.left === b.left) alignments.push("左边对齐");
    if (a.right === b.right) alignments.push("右边对齐");
    if (a.top === b.top) alignments.push("上边对齐");
    if (a.bottom === b.bottom) alignments.push("下边对齐");
    if (a.centerX === b.centerX) alignments.push("左右中心对齐");
    if (a.centerY === b.centerY) alignments.push("上下中心对齐");
  }
  return { anchor: { ...anchor, bounds: { ...anchor.bounds! } }, target: { ...target, bounds: { ...target.bounds! } }, measurement, alignments };
}

export function measurementCardDiagram(data: MeasurementCardData, width = 248, height = 112) {
  const a = rectMetrics(data.anchor.bounds), b = rectMetrics(data.target.bounds);
  const padding = 12;
  if (!a || !b || ![width, height].every(Number.isFinite) || width <= padding * 2 || height <= padding * 2) return null;
  const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top);
  const unionWidth = Math.max(a.right, b.right) - left, unionHeight = Math.max(a.bottom, b.bottom) - top;
  const scale = Math.min((width - padding * 2) / unionWidth, (height - padding * 2) / unionHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const originX = (width - unionWidth * scale) / 2, originY = (height - unionHeight * scale) / 2;
  const point = ({ x, y }: { x: number; y: number }) => ({ x: originX + (x - left) * scale, y: originY + (y - top) * scale });
  const rect = (bounds: UiBounds) => ({ ...point({ x: bounds.left, y: bounds.top }), width: (bounds.right - bounds.left) * scale, height: (bounds.bottom - bounds.top) * scale });
  return { width, height, anchor: rect(data.anchor.bounds), target: rect(data.target.bounds),
    guides: data.measurement.guides.map(guide => ({ from: point(guide.from), to: point(guide.to) })) };
}

// The panel is anchored above bottomEdge inside the same unobstructed viewport
// as the canvas. Scroll its content instead of covering the property sidebar.
export function measurementCardPlacement(viewport: MeasurementCardViewport) {
  if (![viewport.left, viewport.top, viewport.width, viewport.height].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) return null;
  const insetX = Math.min(12, viewport.width / 4), insetY = Math.min(12, viewport.height / 4);
  const width = Math.min(280, viewport.width - 2 * insetX), maxHeight = viewport.height - 2 * insetY;
  if (width < 120 || maxHeight < 64) return null;
  return { left: viewport.left + insetX, bottomEdge: viewport.top + viewport.height - insetY, width, maxHeight };
}

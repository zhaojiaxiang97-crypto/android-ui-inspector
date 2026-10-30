import { measureBounds, rectMetrics, type BoundsMeasurement } from "./node-metrics";
import type { UiBounds } from "./types";

export type MeasurementCardEndpoint = { id: string; label: string; bounds: UiBounds };
export type MeasurementCardData = {
  anchor: MeasurementCardEndpoint;
  target: MeasurementCardEndpoint;
  measurement: BoundsMeasurement;
  alignments: readonly string[];
  dimensions: MeasurementDimension[];
};
export type MeasurementSnapshotIdentity = { id?: string; capturedAt?: string; label?: string };
export type MeasurementDimension = {
  axis: "horizontal" | "vertical"; label: string; value: number;
  fromEdge: string; toEdge: string;
  from: { x: number; y: number }; to: { x: number; y: number };
};
type EndpointInput = Omit<MeasurementCardEndpoint, "bounds"> & { bounds: UiBounds | null };
export type MeasurementCardViewport = { left: number; top: number; width: number; height: number };

const relationLabels: Record<BoundsMeasurement["relation"], string> = {
  gap: "外框分离", contains: "A 包含 B", inside: "B 包含 A",
  overlap: "外框重叠", touching: "边缘相接", equal: "边界重合",
};
export const measurementCardRelationLabel = (data: MeasurementCardData) => relationLabels[data.measurement.relation];
export const measurementCardNumber = (value: number) => String(Number(value.toFixed(2)));
export const measurementCardSummary = (data: MeasurementCardData) => data.dimensions.length
  ? data.dimensions.map(value => `${value.label} ${measurementCardNumber(value.value)} px`).join("，") : "四边对齐 · 0 px";

// Compare each axis independently: separated edges, shared edges, containment
// and partial overlap describe different distances, even when the gap is zero.
function axisDimensions(axis: MeasurementDimension["axis"], a: { start: number; end: number; center: number }, b: typeof a): MeasurementDimension[] {
  const compare = (left: number, right: number) => Math.abs(left - right) < .00001 ? 0 : Math.sign(left - right);
  const lowLabel = axis === "horizontal" ? "左" : "上", highLabel = axis === "horizontal" ? "右" : "下";
  const point = (position: number, center: number) => axis === "horizontal" ? { x: position, y: center } : { x: center, y: position };
  const dimension = (label: string, start: number, end: number, center: number, fromEdge = `A ${label}边`, toEdge = `B ${label}边`): MeasurementDimension => ({
    axis, label, value: Math.abs(end - start), fromEdge, toEdge, from: point(start, center), to: point(end, center),
  });
  if (compare(a.end, b.start) < 0 || compare(b.end, a.start) < 0) {
    const [start, end] = a.end < b.start ? [a.end, b.start] : [b.end, a.start];
    return [dimension(axis === "horizontal" ? "水平" : "垂直", start, end, a.center,
      a.end < b.start ? `A ${highLabel}边` : `B ${highLabel}边`, a.end < b.start ? `B ${lowLabel}边` : `A ${lowLabel}边`)];
  }
  const starts = compare(a.start, b.start), ends = compare(a.end, b.end);
  if (starts === 0) return ends === 0 ? [] : [dimension(highLabel, a.end, b.end, ends < 0 ? a.center : b.center)];
  if (starts < 0 && ends <= 0) return ends === 0 ? [] : [dimension(highLabel, a.end, b.end, a.center)];
  const center = starts < 0 ? b.center : a.center;
  const result = [dimension(lowLabel, a.start, b.start, center)];
  if (starts < 0 || ends < 0) result.push(dimension(highLabel, a.end, b.end, center));
  return result;
}

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
  const dimensions = [
    ...axisDimensions("horizontal", { start: a.left, end: a.right, center: a.centerY }, { start: b.left, end: b.right, center: b.centerY }),
    ...axisDimensions("vertical", { start: a.top, end: a.bottom, center: a.centerX }, { start: b.top, end: b.bottom, center: b.centerX }),
  ];
  if (!dimensions.every(value => Number.isFinite(value.value))) return null;
  return { anchor: { ...anchor, bounds: { ...anchor.bounds! } }, target: { ...target, bounds: { ...target.bounds! } }, measurement, alignments, dimensions };
}

export function measurementCardDiagram(data: MeasurementCardData, width = 280, requestedHeight?: number) {
  const a = rectMetrics(data.anchor.bounds), b = rectMetrics(data.target.bounds);
  const padding = 26;
  if (!a || !b || !Number.isFinite(width) || width <= padding * 2) return null;
  const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top);
  const unionWidth = Math.max(a.right, b.right) - left, unionHeight = Math.max(a.bottom, b.bottom) - top;
  const height = requestedHeight ?? Math.max(150, Math.min(380, unionHeight / unionWidth * (width - padding * 2) + padding * 2));
  if (!Number.isFinite(height) || height <= padding * 2) return null;
  const scale = Math.min((width - padding * 2) / unionWidth, (height - padding * 2) / unionHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const originX = (width - unionWidth * scale) / 2, originY = (height - unionHeight * scale) / 2;
  const point = ({ x, y }: { x: number; y: number }) => ({ x: originX + (x - left) * scale, y: originY + (y - top) * scale });
  const rect = (bounds: UiBounds) => ({ ...point({ x: bounds.left, y: bounds.top }), width: (bounds.right - bounds.left) * scale, height: (bounds.bottom - bounds.top) * scale });
  const labels: Array<{ x: number; y: number; width: number; height: number }> = [];
  const dimensions = data.dimensions.map(value => {
    const from = point(value.from), to = point(value.to), labelWidth = Math.max(24, measurementCardNumber(value.value).length * 7 + 12);
    const clampX = (x: number) => Math.max(1, Math.min(width - labelWidth - 1, x));
    const clampY = (y: number) => Math.max(1, Math.min(height - 19, y));
    const centerX = (from.x + to.x) / 2, centerY = (from.y + to.y) / 2;
    const candidates = value.axis === "horizontal"
      ? [-24, 6, -44, 26, -64, 46].map(offset => ({ x: clampX(centerX - labelWidth / 2), y: clampY(centerY + offset) }))
      : [-labelWidth - 7, 7].flatMap(offset => [0, -20, 20, -40, 40].map(dy => ({ x: clampX(centerX + offset), y: clampY(centerY - 9 + dy) })));
    const location = candidates.find(candidate => labels.every(previous => candidate.x + labelWidth + 2 <= previous.x || candidate.x >= previous.x + previous.width + 2
      || candidate.y + 20 <= previous.y || candidate.y >= previous.y + previous.height + 2)) ?? candidates[0];
    const label = { ...location, width: labelWidth, height: 18 }; labels.push(label);
    return { ...value, from, to, labelBox: label };
  });
  return { width, height, anchor: rect(data.anchor.bounds), target: rect(data.target.bounds), dimensions,
    guides: data.measurement.guides.map(guide => ({ from: point(guide.from), to: point(guide.to) })) };
}

// A dedicated result panel occupies the right side; tall results scroll within
// the window. The canvas reserves this area independently of panel placement.
export function measurementCardPlacement(viewport: MeasurementCardViewport) {
  if (![viewport.left, viewport.top, viewport.width, viewport.height].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) return null;
  const insetX = Math.min(12, viewport.width / 4), insetY = Math.min(12, viewport.height / 4);
  const width = Math.min(300, viewport.width - 2 * insetX), maxHeight = viewport.height - 2 * insetY;
  if (width < 120 || maxHeight < 64) return null;
  return { left: viewport.left + viewport.width - insetX - width, top: viewport.top + viewport.height / 2, width, maxHeight };
}

// A workspace render counter is not a snapshot ID. Callers pass captured
// metadata when available and otherwise explicitly identify the unsaved view.
export function measurementCardCopyText(data: MeasurementCardData, snapshot?: MeasurementSnapshotIdentity) {
  const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, " ").trim();
  const identity = snapshot?.id?.trim() ? `快照 ID：${oneLine(snapshot.id)}` : `快照：${oneLine(snapshot?.label || "当前未保存快照（无快照 ID）")}`;
  const describe = (name: string, endpoint: MeasurementCardEndpoint) => {
    const b = endpoint.bounds;
    return `${name}：${oneLine(endpoint.label)}（节点 ${oneLine(endpoint.id)}）\n  外框：[${measurementCardNumber(b.left)}, ${measurementCardNumber(b.top)}] → [${measurementCardNumber(b.right)}, ${measurementCardNumber(b.bottom)}] px`;
  };
  return ["UI 测距结果", identity, snapshot?.capturedAt ? `采集时间：${oneLine(snapshot.capturedAt)}` : null,
    describe("A", data.anchor), describe("B", data.target), `关系：${measurementCardRelationLabel(data)}`,
    ...data.dimensions.map(value => `${value.axis === "horizontal" ? "水平" : "垂直"} · ${value.fromEdge} → ${value.toEdge}：${measurementCardNumber(value.value)} px`),
    data.dimensions.length ? null : "四边对齐：0 px", data.alignments.length ? `对齐：${data.alignments.join("、")}` : null,
    "单位：屏幕 px（原始布局外框，不受画布缩放和 3D 层距影响）",
  ].filter((line): line is string => line !== null).join("\n");
}

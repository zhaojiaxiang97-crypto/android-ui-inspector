import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { UiNode } from "../../../shared/types";
import type { LayerRecord } from "../../../shared/layer-layout";
import { measureBounds } from "../../../shared/node-metrics";
import { nodeDisplayLabel } from "../../../shared/tree-utils";
import { measurementLabel } from "./presentation";
import type { LayerMeasurementState, RendererStatus } from "./types";

export const EMPTY_LAYER_MEASUREMENT: LayerMeasurementState = { canPin: false, pinned: false, summary: null };
type Endpoint = { id: string; key: string };
type Pair = { context: string | number | UiNode; src: string; anchor: Endpoint; target: Endpoint };
const endpoint = (record: LayerRecord): Endpoint => ({ id: record.id, key: JSON.stringify([
  record.node.attributes?.["view-ref"], record.node.className, record.node.resourceId,
  record.sourceBounds.left, record.sourceBounds.top, record.sourceBounds.right, record.sourceBounds.bottom,
]) });
const samePair = (left: Pair | null, right: Pair) => left !== null && left.context === right.context && left.src === right.src
  && left.anchor.id === right.anchor.id && left.anchor.key === right.anchor.key
  && left.target.id === right.target.id && left.target.key === right.target.key;

export function useLayerMeasurement({ context, src, records, selected, hovered, rendererStatus, onChange }: {
  context: Pair["context"]; src: string; records: readonly LayerRecord[];
  selected: LayerRecord | null | undefined; hovered: LayerRecord | null | undefined;
  rendererStatus: RendererStatus; onChange?: (value: LayerMeasurementState) => void;
}) {
  const [pinned, setPinned] = useState<Pair | null>(null);
  const [recent, setRecent] = useState<Pair | null>(null);
  const resolve = (pair: Pair | null) => {
    if (!pair || pair.context !== context || pair.src !== src || rendererStatus !== "webgl") return null;
    const anchor = records.find(record => record.id === pair.anchor.id), target = records.find(record => record.id === pair.target.id);
    return anchor && target && endpoint(anchor).key === pair.anchor.key && endpoint(target).key === pair.target.key ? { anchor, target } : null;
  };
  const fixed = resolve(pinned), previous = resolve(recent);
  const liveMeasurement = useMemo(() => selected && hovered && selected.id !== hovered.id && rendererStatus === "webgl"
    ? measureBounds(selected.sourceBounds, hovered.sourceBounds) : null, [selected, hovered, rendererStatus]);
  const live = useMemo<Pair | null>(() => liveMeasurement && selected && hovered
    ? { context, src, anchor: endpoint(selected), target: endpoint(hovered) } : null, [context, src, selected, hovered, liveMeasurement]);
  // Keep the last valid pair while the pointer travels to the toolbar button.
  const recentMatchesSelection = Boolean(previous && selected && previous.anchor.id === selected.id);
  const candidate = live ?? (recentMatchesSelection ? recent : null);
  const anchor = fixed?.anchor ?? selected, target = fixed?.target ?? hovered;
  const measurement = useMemo(() => anchor && target && anchor.id !== target.id && rendererStatus === "webgl"
    ? measureBounds(anchor.sourceBounds, target.sourceBounds) : null, [anchor, target, rendererStatus]);
  useLayoutEffect(() => {
    if (pinned && !fixed) setPinned(null);
    if (!fixed && live) setRecent(value => samePair(value, live) ? value : live);
    else if (recent && !recentMatchesSelection) setRecent(null);
  }, [pinned, Boolean(fixed), live, recent, recentMatchesSelection]);
  const summaryPair = fixed ?? (live ? { anchor: selected!, target: hovered! } : recentMatchesSelection ? previous : null);
  const summaryMeasure = summaryPair ? measureBounds(summaryPair.anchor.sourceBounds, summaryPair.target.sourceBounds) : null;
  const summary = summaryPair && summaryMeasure
    ? `${nodeDisplayLabel(summaryPair.anchor.node)} 到 ${nodeDisplayLabel(summaryPair.target.node)}：${summaryMeasure.guides.map((_, index) => measurementLabel(summaryMeasure, index)).join("，")}` : null;
  const canPin = Boolean(candidate), isPinned = Boolean(fixed);
  const state = useMemo<LayerMeasurementState>(() => ({ canPin, pinned: isPinned, summary }), [canPin, isPinned, summary]);
  useEffect(() => { onChange?.(state); }, [onChange, state]);
  useEffect(() => () => { onChange?.(EMPTY_LAYER_MEASUREMENT); }, [onChange]);
  return {
    anchor, target, measurement, isPinned,
    toggleMeasurementPin: () => {
      if (fixed) { setPinned(null); return true; }
      if (!candidate) return false;
      setPinned(candidate); return true;
    },
    clearPinnedMeasurement: () => {
      if (!fixed) return false;
      setPinned(null); return true;
    },
  };
}

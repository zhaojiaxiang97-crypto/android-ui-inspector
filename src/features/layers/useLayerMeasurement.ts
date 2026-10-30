import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { UiBounds, UiNode } from "../../../shared/types";
import { measureBounds, rectMetrics } from "../../../shared/node-metrics";
import { nodeDisplayLabel } from "../../../shared/tree-utils";
import { measurementCardData, measurementCardSummary } from "../../../shared/measurement-card";
import type { LayerMeasurementState, MeasurementPicking } from "./types";

export const EMPTY_LAYER_MEASUREMENT: LayerMeasurementState = { ready: false, canPin: false, pinned: false, summary: null, card: null, picking: null,
  mode: "off", anchor: null, target: null, hovering: false };
type Endpoint = { id: string; key: string };
type Pair = { context: string | number | UiNode; src: string; anchor: Endpoint; target: Endpoint };
type Draft = Omit<Pair, "anchor" | "target"> & {
  anchor: Endpoint | null; target: Endpoint | null; endpoint: "anchor" | "target";
  selectedId: string | null; error: string | null;
};
export type MeasurementRecord = { id: string; node: UiNode; sourceBounds: UiBounds };
const endpoint = (record: MeasurementRecord): Endpoint => ({ id: record.id, key: JSON.stringify([
  record.node.attributes?.["view-ref"], record.node.className, record.node.resourceId,
  record.sourceBounds.left, record.sourceBounds.top, record.sourceBounds.right, record.sourceBounds.bottom,
]) });
const samePair = (left: Pair | null, right: Pair) => left !== null && left.context === right.context && left.src === right.src
  && left.anchor.id === right.anchor.id && left.anchor.key === right.anchor.key
  && left.target.id === right.target.id && left.target.key === right.target.key;

export function useLayerMeasurement({ context, src, records, selected, hovered, ready, onChange }: {
  context: Pair["context"]; src: string; records: readonly MeasurementRecord[];
  selected: MeasurementRecord | null | undefined; hovered: MeasurementRecord | null | undefined;
  ready: boolean; onChange?: (value: LayerMeasurementState) => void;
}) {
  const [pinned, setPinned] = useState<Pair | null>(null);
  const [recent, setRecent] = useState<Pair | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<{ context: Pair["context"]; src: string; temporary: boolean } | null>(null);
  const recordById = useMemo(() => new Map(records.map(record => [record.id, record])), [records]);
  const activeMode = mode?.context === context && mode.src === src && ready ? mode : null;
  const resolveEndpoint = (value: Endpoint | null) => {
    if (!value) return null;
    const record = recordById.get(value.id);
    return record && endpoint(record).key === value.key ? record : null;
  };
  const resolve = (pair: Pair | null) => {
    if (!pair || pair.context !== context || pair.src !== src || !ready) return null;
    const anchor = resolveEndpoint(pair.anchor), target = resolveEndpoint(pair.target);
    return anchor && target ? { anchor, target } : null;
  };
  const fixed = resolve(pinned), previous = resolve(recent);
  const draftAnchor = resolveEndpoint(draft?.anchor ?? null), draftTarget = resolveEndpoint(draft?.target ?? null);
  const draftValid = Boolean(draft && draft.context === context && draft.src === src && ready
    && (!draft.anchor || draftAnchor) && (!draft.target || draftTarget));
  function useSelectedMeasurementNode() {
    if (!draft || !draftValid || !selected) return false;
    const other = draft.endpoint === "anchor" ? draft.target : draft.anchor;
    if (other?.id === selected.id) {
      setDraft({ ...draft, selectedId: selected.id, error: "A 和 B 需要是不同控件，请再选一个。" });
      return false;
    }
    const next = { ...draft, [draft.endpoint]: endpoint(selected), selectedId: selected.id, error: null };
    if (next.anchor && next.target) {
      if (!measureBounds(resolveEndpoint(next.anchor)!.sourceBounds, resolveEndpoint(next.target)!.sourceBounds)) return false;
      setPinned({ context, src, anchor: next.anchor, target: next.target });
      setDraft(null);
    } else setDraft({ ...next, endpoint: next.anchor ? "target" : "anchor" });
    return true;
  }
  useLayoutEffect(() => {
    if (mode && !activeMode) setMode(null);
    if (draft && !draftValid) { setDraft(null); return; }
    // Tree, keyboard and canvas selection all update the same selected record.
    // Opening the picker alone must never consume the current selection as B.
    if (draft && selected && selected.id !== draft.selectedId) useSelectedMeasurementNode();
  }, [draft, draftValid, selected?.id, mode, activeMode]);
  const liveMeasurement = useMemo(() => selected && hovered && selected.id !== hovered.id && ready
    ? measureBounds(selected.sourceBounds, hovered.sourceBounds) : null, [selected, hovered, ready]);
  const live = useMemo<Pair | null>(() => liveMeasurement && selected && hovered
    ? { context, src, anchor: endpoint(selected), target: endpoint(hovered) } : null, [context, src, selected, hovered, liveMeasurement]);
  // Keep the last valid pair while the pointer travels to the toolbar button.
  const recentMatchesSelection = Boolean(previous && selected && previous.anchor.id === selected.id);
  const candidate = live ?? (recentMatchesSelection ? recent : null);
  const anchor = fixed?.anchor ?? selected, target = fixed?.target ?? hovered;
  const measurement = useMemo(() => anchor && target && anchor.id !== target.id && ready
    ? measureBounds(anchor.sourceBounds, target.sourceBounds) : null, [anchor, target, ready]);
  useLayoutEffect(() => {
    if (pinned && !fixed) setPinned(null);
    if (!fixed && live) setRecent(value => samePair(value, live) ? value : live);
    else if (recent && !recentMatchesSelection) setRecent(null);
  }, [pinned, Boolean(fixed), live, recent, recentMatchesSelection, mode, activeMode]);
  const summaryPair = fixed ?? (live ? { anchor: selected!, target: hovered! } : recentMatchesSelection ? previous : null);
  const cardEndpoint = (record: MeasurementRecord) => ({ id: record.id, label: nodeDisplayLabel(record.node), bounds: record.sourceBounds });
  const summaryCard = summaryPair ? measurementCardData(cardEndpoint(summaryPair.anchor), cardEndpoint(summaryPair.target)) : null;
  const summary = summaryCard ? `${summaryCard.anchor.label} 到 ${summaryCard.target.label}：${measurementCardSummary(summaryCard)}` : null;
  const canPin = Boolean(candidate), isPinned = Boolean(fixed);
  const shown = fixed ?? (activeMode && !draft ? live ? { anchor: selected!, target: hovered! } : recentMatchesSelection ? previous : null : null);
  const shownAnchor = shown?.anchor, shownTarget = shown?.target;
  const card = useMemo(() => shownAnchor && shownTarget ? measurementCardData(cardEndpoint(shownAnchor), cardEndpoint(shownTarget)) : null, [shownAnchor, shownTarget]);
  const picking = useMemo<MeasurementPicking | null>(() => draft && draftValid ? {
    endpoint: draft.endpoint,
    anchor: draftAnchor ? { id: draftAnchor.id, label: nodeDisplayLabel(draftAnchor.node), bounds: draftAnchor.sourceBounds } : null,
    target: draftTarget ? { id: draftTarget.id, label: nodeDisplayLabel(draftTarget.node), bounds: draftTarget.sourceBounds } : null,
    canUseSelected: Boolean(selected && selected.id !== (draft.endpoint === "anchor" ? draft.target?.id : draft.anchor?.id)),
    selectedLabel: selected ? nodeDisplayLabel(selected.node) : null, error: draft.error,
  } : null, [draft, draftValid, draftAnchor, draftTarget, selected]);
  const modeName: LayerMeasurementState["mode"] = picking ? "picking" : isPinned ? "fixed" : activeMode ? activeMode.temporary ? "temporary" : "live" : "off";
  const stateAnchor = picking?.anchor ?? card?.anchor ?? (selected ? cardEndpoint(selected) : null);
  const stateTarget = picking ? picking.target : card?.target ?? null;
  const state = useMemo<LayerMeasurementState>(() => ({ ready, canPin, pinned: isPinned, summary, card, picking, mode: modeName,
    anchor: stateAnchor, target: stateTarget, hovering: Boolean(live) }), [ready, canPin, isPinned, summary, card, picking, modeName, stateAnchor?.id, stateAnchor?.label, stateAnchor?.bounds, stateTarget?.id, stateTarget?.label, stateTarget?.bounds, Boolean(live)]);
  useEffect(() => { onChange?.(state); }, [onChange, state]);
  useEffect(() => () => { onChange?.(EMPTY_LAYER_MEASUREMENT); }, [onChange]);
  return {
    state, anchor, target, measurement, isPinned, summary,
    startMeasurementMode: () => {
      if (!ready) return false;
      setPinned(null); setDraft(null); setRecent(null); setMode({ context, src, temporary: false }); return true;
    },
    setTemporaryMeasurement: (active: boolean) => {
      if (!active) { setMode(value => value?.temporary ? null : value); return true; }
      if (!ready || !selected || fixed || draft) return false;
      setMode(value => value && !value.temporary ? value : { context, src, temporary: true }); return true;
    },
    beginMeasurement: (which?: "anchor" | "target") => {
      if (!ready) return false;
      const baseAnchor = draftValid ? draftAnchor : fixed?.anchor ?? shown?.anchor ?? selected;
      const baseTarget = draftValid ? draftTarget : fixed?.target ?? shown?.target;
      const anchor = which === "anchor" ? null : which ? baseAnchor : selected;
      const target = which === "anchor" ? baseTarget : null;
      setPinned(null);
      setMode(null);
      setDraft({ context, src, anchor: anchor ? endpoint(anchor) : null, target: target ? endpoint(target) : null,
        endpoint: which ?? (anchor ? "target" : "anchor"), selectedId: selected?.id ?? null, error: null });
      return true;
    },
    useSelectedMeasurementNode,
    toggleMeasurementPin: () => {
      if (draft) { setDraft(null); setMode(null); return true; }
      if (fixed) { setPinned(null); setMode(null); return true; }
      if (!candidate) { if (!activeMode) return false; setMode(null); return true; }
      setPinned(candidate); return true;
    },
    clearPinnedMeasurement: () => {
      if (!pinned && !draft && !mode) return false;
      setPinned(null); setDraft(null); setMode(null); return true;
    },
  };
}

export type LayerMeasurementController = ReturnType<typeof useLayerMeasurement>;

// Measurement uses captured bounds, independently of the current rendering or
// available textures. Collapsing a branch changes its picture, not its geometry.
export function measurementRecords(root: UiNode, hidden: ReadonlySet<string>, focus?: { node: UiNode; kind: "branch" | "layer" } | null): MeasurementRecord[] {
  const records: MeasurementRecord[] = [];
  const stack = [{ node: root, invisible: false, insideFocus: !focus }];
  while (stack.length) {
    const entry = stack.pop()!, node = entry.node;
    const alpha = node.attributes?.["effective-alpha"] ?? node.attributes?.alpha;
    const invisible = entry.invisible || !node.visibleToUser || node.layerCapturePlacement?.hidden === true
      || alpha !== undefined && alpha.trim() !== "" && Number(alpha) === 0;
    const insideFocus = entry.insideFocus || node.id === focus?.node.id;
    const rect = rectMetrics(node.bounds);
    if (!invisible && !hidden.has(node.id) && insideFocus && (!focus || focus.kind === "branch" || node.id === focus.node.id)
      && rect && [rect.width, rect.height, rect.centerX, rect.centerY].every(Number.isFinite)) {
      records.push({ id: node.id, node, sourceBounds: node.bounds! });
    }
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], invisible, insideFocus });
  }
  return records;
}

import { useLayoutEffect, useRef, useState } from "react";
import type { UiNode } from "../../../shared/types";
import type { QuickSelectCandidate, QuickSelectResult } from "./quick-select";
import type { CanvasSurface } from "./useCanvasView";
type QuickUi = { context: object; result: QuickSelectResult | null; mode?: "inside" | "position"; anchor?: { x: number; y: number } };

/** A candidate belongs to one scene context, including the callback that opened it. */
export function useCanvasQuickSelect({ context: quickContext, root, navigationDisabled, surface, onNavigateNode, onCancelQuickGesture }: {
  context: object; root: UiNode; navigationDisabled: boolean; surface: Pick<CanvasSurface, "frameRef" | "layerSceneRef">;
  onNavigateNode?: (node: UiNode, sourceRoot: UiNode) => boolean;
  onCancelQuickGesture: () => void;
}) {
  const { layerSceneRef, frameRef } = surface;
  const quickToolRef = useRef<HTMLButtonElement>(null);
  const [quickUi, setQuickUi] = useState<QuickUi | null>(null);
  const quickUiRef = useRef<QuickUi | null>(null);
  const quickLiveRef = useRef({ context: quickContext, alive: true });
  quickLiveRef.current.context = quickContext;
  const activeQuick = quickUi?.context === quickContext ? quickUi : null;
  function changeQuickUi(next: QuickUi | null) { quickUiRef.current = next; setQuickUi(next); }
  function closeQuickSelect(restoreFocus = false) {
    changeQuickUi(null);
    layerSceneRef.current?.previewQuickSelect(null, null);
    if (restoreFocus) quickToolRef.current?.focus({ preventScroll: true });
  }
  function quickCallbackCurrent() { return quickLiveRef.current.alive && quickLiveRef.current.context === quickContext && !navigationDisabled; }
  function previewQuickCandidate(candidate: QuickSelectCandidate | null) {
    if (!quickCallbackCurrent()) return;
    layerSceneRef.current?.previewQuickSelect(activeQuick?.result ?? null, candidate);
  }
  function confirmQuickCandidate(candidate: QuickSelectCandidate) {
    const result = activeQuick?.result;
    if (!quickCallbackCurrent() || !result || result.root !== root || !result.candidates.includes(candidate)) return;
    if (onNavigateNode?.(candidate.node, result.root)) closeQuickSelect();
    else { closeQuickSelect(); frameRef.current?.focus({ preventScroll: true }); }
  }
  function quickPage(page: number) {
    if (!quickCallbackCurrent() || !activeQuick?.result) return;
    const result = layerSceneRef.current?.quickSelectPage(activeQuick.result, page);
    if (result) { layerSceneRef.current?.previewQuickSelect(null, null); changeQuickUi({ context: quickContext, result, mode: activeQuick.mode, anchor: activeQuick.anchor }); }
  }
  function filterQuickCandidates(query: string) {
    if (!quickCallbackCurrent() || !activeQuick?.result) return;
    const result = layerSceneRef.current?.quickSelectPage({ ...activeQuick.result, query }, 0);
    if (result) { layerSceneRef.current?.previewQuickSelect(null, null); changeQuickUi({ context: quickContext, result, mode: activeQuick.mode, anchor: activeQuick.anchor }); }
  }
  useLayoutEffect(() => {
    onCancelQuickGesture();
    closeQuickSelect();
    return () => { layerSceneRef.current?.previewQuickSelect(null, null); };
  }, [quickContext]);
  useLayoutEffect(() => {
    quickLiveRef.current.alive = true;
    return () => { quickLiveRef.current.alive = false; quickUiRef.current = null; };
  }, []);
  return {
    active: activeQuick, toolRef: quickToolRef,
    isCurrent: quickCallbackCurrent,
    isOpen: () => quickUiRef.current?.context === quickContext,
    close: closeQuickSelect,
    preview: previewQuickCandidate, confirm: confirmQuickCandidate, page: quickPage, filter: filterQuickCandidates,
    open: () => { if (quickCallbackCurrent()) changeQuickUi({ context: quickContext, result: null, mode: "position" }); },
    show: (result: QuickSelectResult, anchor: { x: number; y: number }) => {
      if (quickCallbackCurrent()) changeQuickUi({ context: quickContext, result, mode: result.scope ?? "inside", anchor });
    },
    clearResult: () => {
      layerSceneRef.current?.previewQuickSelect(null, null);
      if (activeQuick && quickCallbackCurrent()) changeQuickUi({ context: quickContext, result: null, mode: activeQuick.mode });
    },
    changeMode: (mode: "inside" | "position") => {
      if (!quickCallbackCurrent()) return;
      layerSceneRef.current?.previewQuickSelect(null, null);
      changeQuickUi({ context: quickContext, result: null, mode });
      frameRef.current?.focus({ preventScroll: true });
    },
  };
}
export type CanvasQuickSelect = ReturnType<typeof useCanvasQuickSelect>;

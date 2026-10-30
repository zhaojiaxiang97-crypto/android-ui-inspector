import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { RendererStatus } from "./types";
import { LayerSceneRuntime } from "./scene-runtime";
import { browserScenePorts } from "./scene-runtime-ports";
import type { SceneGroups, SceneResourceContext } from "./scene-group-runtime";

/** React and DOM observation only; resource ownership lives in LayerSceneRuntime. */
export function useLayerSceneRuntime(canvas: RefObject<HTMLCanvasElement | null>, context: SceneResourceContext,
  callbacks: { painted(): void; resized(): void }) {
  const runtime = useRef<LayerSceneRuntime | null>(null);
  const latest = useRef(callbacks); latest.current = callbacks;
  const [status, setStatus] = useState<RendererStatus>("loading");
  const [warning, setWarning] = useState<string | null>(null);
  const [groups, setGroups] = useState<SceneGroups>(() => ({ context, images: context.savedGroups, requests: new Map() }));
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const scene = new LayerSceneRuntime(element, browserScenePorts, {
      status: setStatus, warning: setWarning, groups: setGroups, painted: () => latest.current.painted(),
    });
    runtime.current = scene;
    let active = true;
    const resize = new ResizeObserver(() => { if (active) { latest.current.resized(); scene.draw(); } });
    resize.observe(element);
    const appearance = new MutationObserver(() => { if (active) scene.draw(); });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] });
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => { if (active && preference.matches) scene.interruptMotion(); };
    preference.addEventListener?.("change", changed);
    return () => {
      active = false; resize.disconnect(); appearance.disconnect(); preference.removeEventListener?.("change", changed);
      scene.dispose(); if (runtime.current === scene) runtime.current = null;
    };
  }, [canvas]);
  useLayoutEffect(() => { runtime.current?.setContext(context); }, [context.root, context.src, context.sessionKey, context.capture, context.savedGroups]);
  return { runtime, status, warning, groups };
}

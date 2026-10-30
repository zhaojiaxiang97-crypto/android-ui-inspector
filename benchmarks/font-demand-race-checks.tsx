import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import type { LayerImageCaptureResult, UiSnapshot } from "../shared/types";
import type { ViewFontResult } from "../shared/view-font";
import { makeNode } from "./fixtures";

function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

/** Exercise App's explicit font route against the real 250ms demand controller. */
export async function verifyFontDemandRace() {
  const previousApi = window.electronApi;
  const storage = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!; return [key, localStorage.getItem(key)!] as const;
  });
  const host = document.createElement("div"); document.body.append(host);
  const renderer = createRoot(host);
  const layerReads: { requestId: string; result: ReturnType<typeof deferred<LayerImageCaptureResult>> }[] = [];
  const fontReads: { requestId: string; nodeId: string; result: ReturnType<typeof deferred<ViewFontResult>> }[] = [];
  const canceledLayers: string[] = [], canceledFonts: string[] = [], order: string[] = [];
  const check = (value: unknown, message: string) => { if (!value) throw new Error(`Font demand race: ${message}`); };
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const until = async (predicate: () => boolean, message: string) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) { check(performance.now() < deadline, message); await tick(); }
  };
  const click = (selector: string) => {
    const control = host.querySelector<HTMLButtonElement>(selector);
    check(control && !control.disabled, `unavailable ${selector}`);
    flushSync(() => control!.click());
  };
  const canvas = document.createElement("canvas"); canvas.width = 360; canvas.height = 640;
  canvas.getContext("2d")!.fillRect(0, 0, 360, 640); const png = canvas.toDataURL();
  const fixture = (): UiSnapshot => ({ serial: "font-demand", nodeCount: 2, xmlSize: 0, rawXml: null,
    screenshotDataUrl: png, warning: null, error: null, inspectionSource: "debug-view", layerCapture: "on-demand",
    root: { ...makeNode("0"), attributes: { "debug-process-id": "1", "debug-window-name": "font-window" }, children: [
      { ...makeNode("0/0", 1), layerImageStatus: "deferred", attributes: { "view-ref": "android.widget.TextView@a", "text-style-source": "view-debug", "text-size-px": "22.5" } },
    ] },
  });
  const font: ViewFontResult = { ref: "android.widget.TextView@a", capturedAtMillis: 1_792_000_000_000, source: "jdwp", basis: "text-paint",
    familyName: "sans-serif", familyNameStatus: "system-family", weight: 400, style: 0, usesDefaultTypeface: false };
  const fontBridge = {
    readViewFont: async (requestId: string, nodeId: string) => {
      order.push("font"); const result = deferred<ViewFontResult>(); fontReads.push({ requestId, nodeId, result }); return result.promise;
    },
    cancelViewFont: async (requestId: string) => { canceledFonts.push(requestId); },
  };
  window.electronApi = {
    ...fontBridge, runtime: { sandboxed: true, contextIsolated: true },
    probeAdb: async () => ({ adbPath: "fixture", adbVersion: "fixture", error: null,
      devices: [{ serial: "font-demand", state: "device", model: "fixture", androidVersion: "14", product: null, transportId: null }] }),
    inspectDevice: async () => fixture(), captureGroup: async () => null,
    captureLayerImages: async requestId => { order.push("layers"); const result = deferred<LayerImageCaptureResult>(); layerReads.push({ requestId, result }); return result.promise; },
    cancelLayerImages: async requestId => { order.push("cancel-layers"); canceledLayers.push(requestId); },
    refreshViewNode: async () => { throw new Error("Unexpected refresh"); }, readViewStyle: async () => { throw new Error("Unexpected SDK read"); },
    cancelInspection: async () => {}, showLayerMenu: async () => null,
    onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {}, copyText: async () => {},
    loadSnapshots: async () => ({ snapshots: [], error: null }), exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }),
    saveSnapshot: async () => ({ snapshots: [], error: null }), clearSnapshots: async () => ({ snapshots: [], error: null }),
  };
  try {
    localStorage.clear(); flushSync(() => renderer.render(<App />));
    await until(() => host.querySelector<HTMLButtonElement>(".capture-button")?.disabled === false, "capture unavailable");
    click(".capture-button");
    await until(() => Boolean(host.querySelector('.tree-row[data-tree-id="0/0"]')) && !host.querySelector(".inspection-progress"), "capture did not finish");
    click('.tree-row[data-tree-id="0/0"]'); click(".inspector-font-read");
    await until(() => fontReads.length === 1, "explicit font read did not start");
    await pause(350);
    check(layerReads.length === 0 && canceledFonts.length === 0, "delayed branch pixels competed with the explicit font read");
    check(fontReads[0].nodeId === "0/0", "font route changed selected node");
    fontReads[0].result.resolve(font);
    await until(() => Boolean(host.querySelector(".inspector-font-result")), "first font result did not appear");
    await pause(100); check(Boolean(host.querySelector(".inspector-font-result")), "first font result disappeared");

    // The next deliberate visit may still fetch pixels; a font click preempts that in-flight batch.
    click('.tree-row[data-tree-id="0/0"]');
    await until(() => layerReads.length === 1, "new deliberate visit could not read pixels");
    click(".inspector-font-read"); await until(() => fontReads.length === 2, "second font read did not start");
    check(canceledLayers.includes(layerReads[0].requestId), "in-flight pixel capture was not canceled");
    check(order.lastIndexOf("cancel-layers") < order.lastIndexOf("font"), "font route did not revoke pixels first");
    layerReads[0].result.resolve({ updates: [{ id: "0/0", layerImageStatus: "captured", layerImageDataUrl: png, layerImageSize: { width: 360, height: 640 } }], failures: [] });
    await pause(100);
    check(canceledFonts.length === 0 && host.querySelector<HTMLButtonElement>(".inspector-font-read")?.disabled, "late pixel patch replaced the font scope");
    fontReads[1].result.resolve(font);
    await until(() => Boolean(host.querySelector(".inspector-font-result")), "font result was lost after stale pixels returned");
    await pause(350);
    check(layerReads.length === 1 && canceledFonts.length === 0 && host.querySelector(".inspector-font-result"), "pixels restarted or cleared the validated font");
    return { checks: ["font click clears pending 250ms branch request", "later visit still reads pixels", "font click cancels active pixels before IPC", "late pixels cannot replace font scope or clear result"], fontReads: fontReads.length, layerReads: layerReads.length };
  } finally {
    flushSync(() => renderer.unmount()); host.remove(); window.electronApi = previousApi;
    localStorage.clear(); for (const [key, value] of storage) localStorage.setItem(key, value);
  }
}

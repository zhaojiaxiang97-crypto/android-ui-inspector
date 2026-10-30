import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { ScreenshotPreview } from "../src/components/ScreenshotPreview";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import type { InspectionPort } from "../src/platform/desktop-services";
import type { InspectionPreview, LayerImageCaptureResult, QmlGroupImage, UiNode, UiSnapshot } from "../shared/types";
import { makeNode } from "./fixtures";

const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function check(value: unknown, message: string) { if (!value) throw new Error(`Demand layers: ${message}`); }
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) { check(performance.now() < deadline, message); await tick(); }
}
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function node(id: string): UiNode { return { ...makeNode(id), text: id, attributes: { "view-ref": `View@${id}` }, layerImageStatus: "deferred" }; }
function fixture(): UiSnapshot {
  const root = node("0"), branch = node("0/0");
  root.attributes = { ...root.attributes, "debug-process-id": "1", "debug-window-name": "fixture-window" };
  branch.children = Array.from({ length: 40 }, (_, i) => node(`0/0/${i}`));
  root.children = [branch, node("0/1")];
  return { serial: "demand-fixture", root, nodeCount: 43, screenshotDataUrl: null, rawXml: null, xmlSize: 0,
    warning: null, error: null, inspectionSource: "debug-hybrid", layerCapture: "on-demand" };
}

export async function verifyDemandLayerCapture() {
  const host = document.createElement("div"); document.body.append(host);
  const reactRoot = createRoot(host);
  const oldApi = window.electronApi;
  const storage = Array.from({ length: localStorage.length }, (_, i) => { const key = localStorage.key(i)!; return [key, localStorage.getItem(key)!] as const; });
  let workspace!: ReturnType<typeof useInspectionWorkspace>;
  const calls: { id: string; ids: string[]; result: ReturnType<typeof deferred<LayerImageCaptureResult>> }[] = [], modes: unknown[] = [], canceled: string[] = [];
  let preview: ((event: InspectionPreview) => void) | null = null, captureId = "";
  let delayedCapture: ReturnType<typeof deferred<UiSnapshot>> | null = null;
  const image: QmlGroupImage = { dataUrl: "data:image/png;base64,aGVsbG8=", size: { width: 4, height: 4 }, capturedAt: "2026-10-15T00:00:00Z" };
  const api: InspectionPort = {
    inspectDevice: async (_serial, id, _priority, _single, _diagnostic, mode) => {
      captureId = id; modes.push(mode);
      if (delayedCapture) return delayedCapture.promise;
      return { ...fixture(), layerCapture: mode ?? "full", layerGroupImages: [{ nodeId: "0", image }] };
    },
    captureLayerImages: async (id, ids) => { const result = deferred<LayerImageCaptureResult>(); calls.push({ id, ids, result }); return result.promise; },
    cancelLayerImages: async id => { canceled.push(id); }, cancelInspection: async () => {},
    captureGroup: async () => image, refreshViewNode: async () => ({ nodes: [], failures: [] }),
    showLayerMenu: async () => null, onInspectionPreview: callback => { preview = callback; return () => { preview = null; }; }, onInspectionProgress: () => () => {},
  };
  function Probe() { workspace = useInspectionWorkspace({ api }); return null; }
  const readCapture = async (mode: "on-demand" | "full") => {
    let pending!: Promise<UiSnapshot | null>;
    flushSync(() => { pending = workspace.inspectDevice("demand-fixture", null, undefined, mode); });
    await pending; await until(() => !workspace.inspectionLoading && Boolean(workspace.snapshot), "capture did not settle");
  };
  try {
    localStorage.clear(); flushSync(() => reactRoot.render(<Probe />));
    await readCapture("on-demand"); await pause(350);
    check(calls.length === 0, "initial tree presentation automatically read the tree");
    const initial = workspace.snapshot!, branch = initial.root!.children[0];
    await workspace.requestGroup(initial.root!); await tick();
    check(workspace.availableGroupImages.length === 1, "group cache fixture not ready");
    flushSync(() => workspace.handleLayerAction("focus-branch", branch));
    await until(() => calls.length === 1, "focus did not read its branch");
    check(calls[0].ids.length === 32 && calls[0].ids.every(id => id.startsWith("0/0")), "branch selection escaped scope or budget");
    calls[0].result.resolve({ updates: calls[0].ids.map(id => ({ id, layerImageStatus: "captured", layerImageDataUrl: "fresh-pixels" })), failures: [] });
    await until(() => !workspace.demandImages.loading && workspace.snapshot !== initial, "branch images did not apply");
    check(workspace.selectedNode?.id === branch.id && workspace.layerFocus?.node === workspace.snapshot!.root!.children[0], "image patch lost focus/selection");
    check(workspace.availableGroupImages.length === 0 && !workspace.snapshotForStorage()!.layerGroupImages?.length, "patch retained stale group pixels in rendering/export");
    await pause(350); check(calls.length === 1, "image patch automatically queued the remaining tree");
    flushSync(() => workspace.handleLayerAction("exit-focus"));
    check(workspace.selectedNode?.id === "0" && workspace.snapshot!.root!.children[0].layerImageDataUrl === "fresh-pixels", "exit focus lost patched tree or original selection");
    flushSync(() => workspace.demandImages.invalidate());

    flushSync(() => workspace.setSelectedNode(workspace.snapshot!.root!.children[1]));
    await until(() => calls.length === 2, "next branch did not start");
    const stale = calls[1]; await readCapture("full");
    check(canceled.includes(stale.id), "new capture did not cancel the old branch request");
    const full = workspace.snapshot;
    stale.result.resolve({ updates: [{ id: "0/1", layerImageDataUrl: "stale", layerImageStatus: "captured" }], failures: [] });
    await pause(350); check(workspace.snapshot === full && !workspace.snapshot!.root!.children[1].layerImageDataUrl, "old branch patched a new session");
    check(modes.join(",") === "on-demand,full", "capture mode did not reach the sixth API argument");
    flushSync(() => workspace.showSnapshot(fixture()));
    flushSync(() => workspace.setSelectedNode(workspace.snapshot!.root!.children[0]));
    await pause(350); check(calls.length === 2 && !workspace.demandImages.available, "offline snapshot started live branch reads");

    delayedCapture = deferred<UiSnapshot>();
    let earlyCapture!: Promise<UiSnapshot | null>;
    flushSync(() => { earlyCapture = workspace.inspectDevice("demand-fixture", null, undefined, "on-demand"); });
    flushSync(() => preview!({ phase: "tree", requestId: captureId, snapshot: fixture() }));
    flushSync(() => workspace.handleExpandedChange(new Set(["0", "0/0"])));
    flushSync(() => workspace.setSelectedNode(workspace.snapshot!.root!.children[1]));
    await pause(350); check(calls.length === 2, "preview selection read layers before capture became ready");
    delayedCapture.resolve(fixture()); delayedCapture = null; await earlyCapture;
    await until(() => calls.length === 3, "preview visit was lost after capture completed");
    check(calls[2].ids.join(",") === "0/1", "capture replayed more than the latest explicit preview visit");
    calls[2].result.resolve({ updates: [{ id: "0/1", layerImageStatus: "captured", layerImageDataUrl: "early-visit-pixels" }], failures: [] });
    await until(() => !workspace.demandImages.loading, "preview visit patch did not finish");
    await pause(350); check(calls.length === 3, "preview visit restarted an implicit tree scan");

    // Exercise the actual App entry points, including the quick default and full fallback.
    flushSync(() => reactRoot.render(null));
    const canvas = document.createElement("canvas"); canvas.width = 360; canvas.height = 640;
    canvas.getContext("2d")!.fillRect(0, 0, 360, 640);
    const png = canvas.toDataURL();
    let failedLayers = false;
    const fullFixture = (): UiSnapshot => {
      const snapshot = fixture(), nodes = [snapshot.root!];
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].layerImageStatus = failedLayers ? "failed" : "captured";
        if (!failedLayers) { nodes[i].layerImageDataUrl = png; nodes[i].layerImageSize = { width: 360, height: 640 }; }
        nodes.push(...nodes[i].children);
      }
      return { ...snapshot, layerCapture: "full", screenshotDataUrl: png };
    };
    window.electronApi = { ...api,
      runtime: { sandboxed: true, contextIsolated: true },
      probeAdb: async () => ({ adbPath: "fixture", adbVersion: "fixture", error: null, devices: [{ serial: "demand-fixture", state: "device", model: "fixture", androidVersion: "14", product: null, transportId: null }] }),
      inspectDevice: async (...args) => { const result = await api.inspectDevice(...args);
        return args[5] === "full" ? fullFixture() : { ...result, layerGroupImages: [], screenshotDataUrl: png }; },
      loadSnapshots: async () => ({ snapshots: [], error: null }), copyText: async () => {},
      readViewStyle: async () => { throw new Error("Unexpected style read"); },
      exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }),
      saveSnapshot: async () => ({ snapshots: [], error: null }), clearSnapshots: async () => ({ snapshots: [], error: null }),
    };
    flushSync(() => reactRoot.render(<App />));
    const click = (selector: string) => { const element = host.querySelector<HTMLButtonElement>(selector); check(element && !element.disabled, `missing control ${selector}, modes=${modes.join(",")}, present=${Boolean(element)}, disabled=${element?.disabled}`); flushSync(() => element!.click()); };
    const captureReady = () => host.querySelector<HTMLButtonElement>('.capture-button')?.disabled === false;
    await until(() => host.querySelector<HTMLButtonElement>(".capture-button")?.disabled === false, "home capture unavailable");
    click(".capture-button");
    await until(() => Boolean(host.querySelector(".demand-layer-status")) && captureReady(), "quick App capture did not finish");
    check(modes.at(-1) === "on-demand", "App did not default to quick capture");
    await until(() => Boolean(host.querySelector(".view-mode-toggle")), "canvas controls unavailable");
    check(host.querySelector(".view-mode-toggle button:first-child")?.getAttribute("aria-pressed") === "true", "quick capture did not open in 2D");
    delayedCapture = deferred<UiSnapshot>();
    const before3d = modes.length;
    click('.view-mode-3d');
    await until(() => modes.length === before3d + 1 && modes.at(-1) === "full", "3D did not request a complete capture");
    check(host.querySelector('.preparing-3d-preview'), "preparing 3D discarded the previous screenshot");
    flushSync(() => preview!({ phase: "tree", requestId: captureId, snapshot: { ...fixture(), layerCapture: "full" } }));
    await until(() => Boolean(host.querySelector('.view-mode-3d')), "full preview did not mount");
    check(host.querySelector('.preparing-3d-fallback img')?.getAttribute('src') === png, "tree before screenshot discarded the previous 2D preview");
    check(!host.querySelector('.screenshot-stage img'), "previous screenshot was attached to new tree coordinates");
    flushSync(() => preview!({ phase: "screen", requestId: captureId, screen: { screenshotDataUrl: png } }));
    await until(() => Boolean(host.querySelector('.screenshot-stage img')), "new screen did not replace preparation preview");
    check(host.querySelector('.view-mode-3d')?.getAttribute('aria-pressed') === 'false', "tree preview exposed unread 3D planes");
    delayedCapture.resolve(fullFixture()); delayedCapture = null;
    await until(() => host.querySelector('.view-mode-3d')?.getAttribute('aria-pressed') === 'true', "complete images did not enter 3D with unchanged selection");
    check(modes.length === before3d + 1, "preparing 3D duplicated capture requests");

    // The existing full-capture entry must still work, and an explicit 2D choice wins.
    click('.capture-button');
    await until(() => Boolean(host.querySelector('.demand-layer-status')) && captureReady(), "second quick capture did not finish");
    delayedCapture = deferred<UiSnapshot>();
    click('.demand-layer-status button:last-child');
    flushSync(() => preview!({ phase: "tree", requestId: captureId, snapshot: { ...fixture(), layerCapture: "full", screenshotDataUrl: png } }));
    await until(() => host.querySelector<HTMLButtonElement>('.view-mode-toggle button:first-child')?.disabled === false, "2D preview unavailable while preparing 3D");
    click('.view-mode-toggle button:first-child');
    delayedCapture.resolve(fullFixture()); delayedCapture = null;
    await until(() => captureReady() && !host.querySelector('.demand-layer-status'), "full capture fallback did not finish");
    check(host.querySelector('.view-mode-toggle button:first-child')?.getAttribute('aria-pressed') === 'true', "completion overrode explicit 2D choice");

    click('.capture-button');
    await until(() => Boolean(host.querySelector('.demand-layer-status')) && captureReady(), "failure fixture quick capture did not finish");
    failedLayers = true; click('.view-mode-3d');
    await until(() => captureReady() && !host.querySelector('.demand-layer-status') && Boolean(host.querySelector('.view-mode-3d')), "failed images did not settle");
    check(host.querySelector<HTMLButtonElement>('.view-mode-3d')?.disabled && host.querySelector('.view-mode-toggle button:first-child')?.getAttribute('aria-pressed') === 'true', "all failed images automatically entered empty-frame 3D");
    failedLayers = false;
    click('.capture-button');
    await until(() => Boolean(host.querySelector('.demand-layer-status')) && captureReady(), "cancel fixture quick capture did not finish");
    delayedCapture = deferred<UiSnapshot>(); const canceledFull = delayedCapture;
    click('.view-mode-3d');
    const cancelButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '取消采集');
    check(cancelButton, "missing preparation cancel"); flushSync(() => cancelButton!.click());
    delayedCapture = deferred<UiSnapshot>(); const quickAgain = delayedCapture;
    click('.capture-button');
    check(!host.querySelector('.preparing-3d-preview') && !host.textContent?.includes('正在准备 3D 图层'), "quick retry inherited canceled 3D preparation");
    quickAgain.resolve(fixture()); delayedCapture = null;
    await until(() => Boolean(host.querySelector('.demand-layer-status')) && captureReady(), "quick retry did not finish");
    canceledFull.resolve(fullFixture()); await pause(100);
    check(host.querySelector('.view-mode-toggle button:first-child')?.getAttribute('aria-pressed') === 'true', "late canceled 3D result changed new quick view");

    // Availability is a capture fact. Hiding all captured planes must retain a way back.
    const capturedRoot = fullFixture().root!, allIds = new Set<string>(), nodes = [capturedRoot];
    for (let i = 0; i < nodes.length; i++) { allIds.add(nodes[i].id); nodes.push(...nodes[i].children); }
    let hiddenIds = new Set<string>();
    const renderCanvas = (root: UiNode, sessionKey = 'captured') => flushSync(() => reactRoot.render(<ScreenshotPreview
      sessionKey={sessionKey} src={png} root={root} selectedNode={root} expandedNodeIds={allIds} enter3dWhenReady
      layerFocus={null} hiddenNodeIds={hiddenIds} doubleClickAction="expand" onSelect={() => {}} onDoubleClick={() => {}}
      onOpenLayerMenu={() => {}} onLayerAction={action => { if (action === 'restore') { hiddenIds = new Set(); renderCanvas(root); } }} />));
    renderCanvas(capturedRoot);
    await until(() => host.querySelector('.view-mode-3d')?.getAttribute('aria-pressed') === 'true', "captured canvas did not enter 3D");
    hiddenIds = allIds; renderCanvas(capturedRoot); await tick();
    check(host.querySelector('.view-mode-3d')?.getAttribute('aria-pressed') === 'true', "manual hiding was mistaken for capture failure");
    click('.restore-layers'); check(hiddenIds.size === 0, "hidden captured layers could not be restored");
    renderCanvas(fixture().root!, 'offline-pending');
    await until(() => Boolean(host.querySelector('.layer-settings')), "offline pending scene cannot reach structure settings");
    check(host.querySelector<HTMLButtonElement>('.view-mode-3d')?.disabled && host.querySelector('.view-mode-toggle button:first-child')?.getAttribute('aria-pressed') === 'true', "offline pending scene entered empty 3D");
    return { checks: ["no automatic whole-tree capture", "focus reads one bounded branch batch and keeps selection", "patch invalidates cached/saved group images", "exit focus preserves images and original selection", "new session cancels and rejects old patches", "offline snapshot cannot start reads", "latest early preview visit replays once after capture", "actual App defaults to quick/2D", "3D prepares complete images once and keeps 2D during capture", "tree before screenshot keeps a separately labeled old preview", "completion enters 3D with unchanged selection", "full entry retained and explicit 2D choice respected", "all failed images keep 2D", "cancel and immediate quick retry discard old 3D intent", "manual hiding retains 3D and restore", "offline unread images keep 2D with explicit structure settings"] };
  } finally {
    flushSync(() => reactRoot.unmount()); host.remove(); window.electronApi = oldApi;
    localStorage.clear(); for (const [key, value] of storage) localStorage.setItem(key, value);
  }
}

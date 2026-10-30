import { createRoot } from "react-dom/client";
import { createRef } from "react";
import { flushSync } from "react-dom";
import type { CaptureGeometry, LayerFocus, LayerMenuAction, PixelSize, UiNode } from "../shared/types";
import { ScreenshotPreview } from "./screenshot-preview-fixture";
import { ScreenshotPreview as ControlledScreenshotPreview } from "../src/components/ScreenshotPreview";
import { makeNode } from "./fixtures";
import { composeSubtreeImage } from "../shared/layer-textures";
import { qmlStyleFrom, qmlStyleSvg } from "../shared/qml-style";
import { Layer3DPreview } from "../src/features/layers/Layer3DPreview";
import { DEFAULT_LAYER_APPEARANCE, LAYER_APPEARANCE_STORAGE_KEY } from "../src/features/layers/appearance";
import { verifyLayerHoverIntegration } from "./node-hover-checks";
import { verifyLayerDemand } from "./layer-provenance-checks";
import { verifyQuickSelect } from "./quick-select-checks";
import { verifyFlatMeasurementControls } from "./workbench-canvas-checks";
import { verifyInvisibleLayers } from "./invisible-layer-checks";
import { verifyLookinMigrationIntegration } from "./lookin-migration-checks";
import { type LayerSceneHandle } from "../src/features/layers/types";
import { NodeImageActions } from "../src/components/NodeImageActions";
import { nodeImageExportPlan } from "../shared/node-image-export";
import { prepareNodeImageExport } from "../src/features/layers/prepareNodeImageExport";
import type { ExportSnapshotResult, NodeImageOutputRequest, QmlGroupImage } from "../shared/types";
import { changedLayerImages, layerImageBaseline, mergeLayerImages, nodeDisplayLabel, flattenNodes } from "../shared/tree-utils";
import "../src/App.css";
// @ts-ignore -- pure probe helper is shared with the Node desktop smoke tool.
import { layerPreviewReadiness } from "../scripts/lib/layer-preview-readiness";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function near(actual: number, expected: number, message: string, tolerance = 0.08) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`);
}
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 4000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error(message); await tick(); }
}
function node(id: string, left: number, top: number, right: number, bottom: number) {
  return { ...makeNode(id), bounds: { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` } };
}
function fixture(size: PixelSize) {
  const { width: w, height: h } = size;
  const root = node("0", 0, h * .05, w, h * .95);
  root.children = [node("0/0", 0, h * .1, w * .5, h * .4), node("0/1", w * .5, h * .1, w, h * .4), node("0/2", -w * .1, h * .65, w * .25, h * 1.1), node("0/3", w * .5, h * .5, w * .5 + 1, h * .5 + 1)];
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#162030"; ctx.fillRect(0, 0, w, h);
  root.children.forEach((child, index) => {
    ctx.fillStyle = ["#407d64", "#486caa", "#d88b45", "#eeeeee"][index];
    const b = child.bounds!; ctx.fillRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
  });
  const frame = { ...size, rotation: (w > h ? 1 : 0) as 0 | 1 };
  const geometry: CaptureGeometry = { hierarchyRotation: frame.rotation, beforeScreenshot: frame, afterScreenshot: frame, screenshotSize: size };
  return { root, src: canvas.toDataURL("image/png"), geometry };
}

async function verifyCoordinates() {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "680px", marginLeft: "37.375px", marginTop: "73.125px", marginBottom: "900px" });
  document.body.append(host);
  const reactRoot = createRoot(host);
  const checks: string[] = [];
  let selected: UiNode | null = null, calls = 0;
  let current = fixture({ width: 1080, height: 2400 });
  let geometry: CaptureGeometry | undefined = current.geometry;
  const selectedId = () => selected?.id;
  const render = () => flushSync(() => reactRoot.render(<ScreenshotPreview src={current.src} root={current.root} selectedNode={selected} expandedNodeIds={new Set([current.root.id])} geometry={geometry} onSelect={value => { selected = value; calls++; render(); }} />));
  const image = () => host.querySelector<HTMLImageElement>("img")!;
  const stage = () => host.querySelector<HTMLElement>(".screenshot-stage")!;
  const ready = () => until(() => image().complete && image().naturalWidth > 0 && stage().dataset.coordinateStatus !== "loading", "image did not become ready");
  const zoomReadout = () => host.querySelector<HTMLElement>(".zoom-readout")?.textContent;
  const setZoom = async (target: 0.25 | 0.5 | 1 | 2 | 4 | 8 | 16) => {
    host.querySelector<HTMLButtonElement>(".zoom-reset")?.click();
    await until(() => zoomReadout() === "100%", "zoom reset did not reach 100%");
    const preset = host.querySelector<HTMLSelectElement>(".zoom-preset-select");
    assert(preset, "zoom preset select missing");
    preset.value = String(target);
    preset.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => zoomReadout() === `${target * 100}%`, `zoom did not reach ${target * 100}%`);
  };
  const click = (fx: number, fy: number) => {
    // These assertions exercise flat screenshot coordinates, not the oblique 3D scene.
    flushSync(() => [...host.querySelectorAll<HTMLButtonElement>(".view-mode-toggle button")].find(button => button.textContent === "2D")!.click());
    const r = image().getBoundingClientRect();
    image().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, pointerType: "mouse", isPrimary: true, button: 0 }));
  };
  const checkOverlay = (b: { left: number; top: number; right: number; bottom: number }) => {
    const r = image().getBoundingClientRect(), overlay = host.querySelector<HTMLElement>(".selection-overlay");
    assert(overlay, "selection overlay missing");
    const o = overlay.getBoundingClientRect(), w = image().naturalWidth, h = image().naturalHeight;
    // Independent expected projection: no calls to production coordinate helpers.
    near(o.left, r.left + Math.max(0, b.left) / w * r.width, "overlay left");
    near(o.top, r.top + Math.max(0, b.top) / h * r.height, "overlay top");
    near(o.right, r.left + Math.min(w, b.right) / w * r.width, "overlay right");
    near(o.bottom, r.top + Math.min(h, b.bottom) / h * r.height, "overlay bottom");
  };
  try {
    checks.push(...await verifyLayerDemand());
    checks.push(...await verifyLayerHoverIntegration());
    checks.push(...await verifyCollapsedReload());
    checks.push(...await verifyLayerComposites());
    checks.push(...await verifyLayerOcclusion());
    checks.push(...await verifyLayerBorders());
    checks.push(...await verifyRequiredOutlines());
    checks.push(...await verifyLayerAppearancePreferences());
    checks.push(...await verifyInvisibleLayers());
    checks.push(...await verifyHorizontalRotation());
    checks.push(...await verifyLayerContentBounds());
    checks.push(...await verifyLayerMenu());
    checks.push(...await verifyLayerExpansion());
    checks.push(...await verifyLayerMotion());
    checks.push(...await verifyLayerMeasurements());
    checks.push(...await verifyPinnedMeasurementControls());
    checks.push(...await verifyFlatMeasurementControls());
    checks.push(...await verifyNodeImageOutput());
    checks.push(...await verifyLayerFraming());
    for (const [width, height] of [[720, 1280], [1080, 2400], [1440, 3200], [1280, 720], [2400, 1080], [3200, 1440], [2560, 1600], [1600, 2560], [1000, 1000]]) {
      current = fixture({ width, height }); geometry = current.geometry; selected = current.root; render(); await ready();
      flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button")!.click());
      for (const panelWidth of [240, 680]) {
        flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button")!.click());
        host.style.width = `${panelWidth}px`; await tick(); await tick(); await tick();
        const r = image().getBoundingClientRect(), s = stage().getBoundingClientRect();
        near(r.left, s.left, "image/stage left"); near(r.top, s.top, "image/stage top");
        near(r.width, s.width, "image/stage width"); near(r.height, s.height, "image/stage height");
        assert(r.height <= 400.08 && r.width <= panelWidth - 30 + .08, "image exceeds container constraints");
        near(r.height, r.width * height / width, "image is not aspect-preserving");
        assert(stage().dataset.coordinateStatus === "checked", "metadata check missing");
        for (const [fx, fy, id] of [[.1, .2, "0/0"], [.75, .2, "0/1"], [.5, .2, "0/1"], [.1, .8, "0/2"], [.75, .6, "0"]] as const) {
          click(fx, fy); assert(selected?.id === id, `${width}x${height}/${panelWidth}: point ${fx},${fy} selected ${selected?.id}, wanted ${id}`);
          checkOverlay(selected.bounds!);
        }
        const before = calls;
        click(.75, .01); click(-.01, .2); click(1, .2); click(.5, 1);
        assert(calls === before, "padding/outer edges/status bar should not select a node");
        // A full-screen box and a one-pixel box must not grow by a CSS border.
        selected = node("full", 0, 0, width, height); render(); checkOverlay(selected.bounds!);
        selected = current.root.children[3]; render(); checkOverlay(selected.bounds!);
        checks.push(`${width}x${height}: panel ${panelWidth}, fit/click/edge/clipping/thin-overlay`);
      }
    }

    // Exercise the actual ScreenshotPreview controls at the extreme manual
    // zoom values and re-run reverse lookup against the resized layout box.
    current = fixture({ width: 1080, height: 2400 }); geometry = current.geometry; host.style.width = "680px"; selected = current.root; render(); await ready();
    flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button")!.click());
    for (const target of [0.25, 0.5, 1, 2, 4, 8, 16] as const) {
      selected = current.root; render(); await tick(); await setZoom(target);
      flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button")!.click());
      const r = image().getBoundingClientRect(), s = stage().getBoundingClientRect();
      near(r.left, s.left, `zoom ${target}: image/stage left`); near(r.top, s.top, `zoom ${target}: image/stage top`);
      near(r.width, s.width, `zoom ${target}: image/stage width`); near(r.height, s.height, `zoom ${target}: image/stage height`);
      near(r.width / 180, target, `zoom ${target}: width scale`, 0.002);
      click(.1, .2);
      assert(selected?.id === "0/0", `zoom ${target}: reverse lookup selected ${selected?.id}`);
      checkOverlay(selected.bounds!);
    }
    await setZoom(1);
    checks.push("ScreenshotPreview zoom 25/50/100/200/400/800/1600%, layout box and reverse lookup");

    const wheel = (deltaY: number, ctrlKey = false) => {
      const frame = host.querySelector<HTMLElement>(".screenshot-frame")!;
      const rect = frame.getBoundingClientRect();
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, ctrlKey, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
      flushSync(() => frame.dispatchEvent(event));
      assert(event.defaultPrevented, "workspace zoom must prevent browser/page zoom");
    };
    const settleZoom = async () => { await tick(); await tick(); };
    for (const mode of ["2D", "3D 层级"]) {
      flushSync(() => [...host.querySelectorAll<HTMLButtonElement>(".view-mode-toggle button")].find(button => button.textContent === mode)!.click());
      await tick(); await tick(); await setZoom(1);
      const initialWidth = parseFloat(stage().style.width);
      const scale = () => parseFloat(stage().style.width) / initialWidth;
      for (let i = 0; i < 20; i++) wheel(-0.1, true);
      near(scale(), 1, `${mode}: pinch must coalesce a burst instead of rendering each event`);
      await settleZoom();
      const fineScale = scale();
      near(fineScale, Math.exp(0.01), `${mode}: tiny pinch deltas accumulate gently`, 0.00001);
      for (let i = 0; i < 20; i++) wheel(0.1, true);
      await settleZoom();
      near(scale(), 1, `${mode}: pinch in/out is reversible`, 0.00001);
      wheel(-2, true);
      await settleZoom();
      near(scale(), fineScale, `${mode}: zoom depends on gesture distance, not event count`, 0.00001);
      wheel(2, true);
      wheel(-120);
      await settleZoom();
      assert(zoomReadout() === "125%", `${mode}: regular mouse wheel changed`);
      wheel(120);
      await settleZoom();
      assert(zoomReadout() === "100%", `${mode}: regular mouse wheel reverse changed`);
      for (let i = 0; i < 20; i++) wheel(-0.1);
      await settleZoom();
      near(scale(), Math.exp(0.004), `${mode}: small unmodified wheel deltas must zoom gently`, 0.00001);
      for (let i = 0; i < 20; i++) wheel(0.1);
      await settleZoom();
      near(scale(), 1, `${mode}: small wheel deltas must reverse`, 0.00001);
      wheel(-2); await settleZoom();
      near(scale(), Math.exp(0.004), `${mode}: small wheel zoom must depend on distance`, 0.00001);
      wheel(2); await settleZoom();
      wheel(-10000, true);
      await settleZoom();
      assert(zoomReadout() === "1600%", `${mode}: pinch exceeded maximum zoom`);
      wheel(10000, true);
      await settleZoom();
      assert(zoomReadout() === "25%", `${mode}: pinch exceeded minimum zoom`);
      await setZoom(1);
      wheel(-20, true);
      flushSync(() => host.querySelector<HTMLButtonElement>(".zoom-reset")!.click());
      await settleZoom();
      assert(zoomReadout() === "100%", `${mode}: queued wheel overrides reset`);
    }
    checks.push("pinch: gentle continuous 2D/3D zoom, tiny deltas, event-rate independence, reversal, limits and unchanged mouse wheel");
    checks.push("fine wheel: small unmodified pixel deltas accumulate gently and reverse in 2D/3D; mouse detents stay unchanged");

    // Scroll changes client rect origin, not device pixel coordinates.
    window.scrollTo(0, 60); await tick(); click(.1, .2);
    assert(selectedId() === "0/0", "scroll offset changed the mapping");
    window.scrollTo(0, 0); checks.push("scroll-offset mapping");

    for (const rotation of [0, 1, 2, 3] as const) {
      const frame = { ...current.geometry.screenshotSize, rotation };
      geometry = { ...current.geometry, hierarchyRotation: rotation, beforeScreenshot: frame, afterScreenshot: frame };
      render(); assert(stage().dataset.coordinateStatus === "checked", "stable rotation rejected");
      click(.75, .2); assert(selectedId() === "0/1", "coordinates were rotated twice");
    }
    checks.push("all stable rotations, including 180 degrees and square images");
    geometry = { ...current.geometry, afterScreenshot: { ...current.geometry.afterScreenshot!, rotation: 2 } };
    render(); const beforeMismatch = calls; click(.1, .2);
    assert(calls === beforeMismatch && !host.querySelector(".selection-overlay"), "mismatch permits stale screenshot mapping");
    assert(host.querySelector(".screenshot-status")?.textContent?.includes("暂停"), "mismatch lacks explanation");
    geometry = { ...current.geometry, screenshotSize: { width: 111, height: 222 } }; render(); click(.1, .2);
    assert(calls === beforeMismatch && !host.querySelector(".selection-overlay"), "decoded size mismatch permits mapping");
    checks.push("rotation and decoded-size mismatch disable mapping/highlights");

    geometry = undefined; render(); click(.1, .2);
    assert(calls === beforeMismatch + 1 && stage().dataset.coordinateStatus === "unverified", "legacy snapshot not usable/unverified");
    checks.push("legacy snapshot fallback");

    const oldImage = image();
    current = { ...fixture({ width: 2400, height: 1080 }), src: "data:image/png;base64,YmFk" }; geometry = undefined; render();
    assert(!host.querySelector(".selection-overlay"), "previous dimensions leaked before image decoding");
    await until(() => stage().dataset.coordinateStatus === "error", "invalid PNG did not report decode error");
    oldImage.dispatchEvent(new Event("load"));
    const beforeError = calls; click(.1, .2);
    assert(calls === beforeError && !host.querySelector(".selection-overlay"), "broken/stale image permits selection");
    checks.push("decode failure and stale image events");

    for (const size of [{ width: 720, height: 1280 }, { width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
      current = fixture(size); geometry = current.geometry; selected = current.root; render(); await ready();
      assert(image().naturalWidth === size.width, "snapshot retained old image dimensions");
      click(.75, .2); assert(selected?.id === "0/1", "snapshot swap broke reverse lookup"); checkOverlay(selected.bounds!);
    }
    checks.push("portrait/landscape/cached-portrait snapshot changes and decode recovery");
    await tick();
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); window.scrollTo(0, 0); }
  checks.push(...await verifyQuickSelect());
  checks.push(...(await verifyLookinMigrationIntegration({ quickSelect: true })).checks);
  return { checks, devicePixelRatio: window.devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } };
}

Object.assign(window, { verifyCoordinates, benchmarkLayerRendering, verifyLookinMigrationIntegration });

async function verifyLayerBorders() {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "440px", height: "400px", position: "relative" });
  document.body.append(host);
  const reactRoot = createRoot(host), scene = createRef<LayerSceneHandle>();
  const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
  const bitmap = document.createElement("canvas"); bitmap.width = 240; bitmap.height = 200;
  const context = bitmap.getContext("2d")!;
  context.fillStyle = "black"; context.fillRect(0, 0, 240, 200);
  context.fillStyle = "red"; context.fillRect(80, 80, 80, 40);
  const screen = bitmap.toDataURL();
  bitmap.width = 160; bitmap.height = 120;
  try {
    for (const mode of ["native", "trimmed", "composite", "isolated"]) {
      context.clearRect(0, 0, 160, 120); context.fillStyle = "red";
      const inset = mode === "trimmed" ? 20 : 0;
      context.fillRect(inset, inset, 160 - inset * 2, 120 - inset * 2);
      const root = node("0", 0, 0, 240, 200), face = node("0/0", 40, 40, 200, 160);
      root.layerImageEmpty = true; root.children = [face];
      face.layerImageDataUrl = bitmap.toDataURL(); face.layerImageSize = { width: 160, height: 120 };
      if (mode === "isolated") { delete face.layerImageDataUrl; delete face.layerImageSize; face.className = "android.widget.TextView"; }
      if (mode === "composite") {
        face.children = [{ ...face, id: "0/0/0", children: [] }];
        delete face.layerImageDataUrl; delete face.layerImageSize; face.layerImageEmpty = true;
      }
      let selected: UiNode | null = null, hidden: ReadonlySet<string> = new Set(), appearance = DEFAULT_LAYER_APPEARANCE;
      const original = JSON.stringify(root);
      const render = () => flushSync(() => reactRoot.render(<Layer3DPreview key={mode} ref={scene} src={screen} root={root} selectedNode={selected} expandedNodeIds={new Set([root.id])} hiddenNodeIds={hidden} appearance={appearance} size={{ width: 240, height: 200 }} renderScale={1} origin={{ left: 80, top: 80 }} camera={camera} onSelect={() => {}} />));
      render();
      const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
      await until(() => canvas.dataset.layerRenderer === "webgl" && canvas.dataset.layerTextureCount === (mode === "isolated" ? "0" : "1"), `${mode}: border textures did not settle`);
      const gl = canvas.getContext("webgl")!, rect = canvas.getBoundingClientRect();
      const pivotZ = Number(host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerPivotZ);
      const z = Number(host.querySelector<HTMLElement>('[data-layer-node-id="0/0"]')!.dataset.layerZ);
      const scale = 1100 / (1100 - z + pivotZ);
      const point = (x: number, y: number) => ({ x: 200 + (x - 120) * scale, y: 180 + (y - 100) * scale });
      const patch = (x: number, y: number) => {
        const p = point(x, y), pixels = new Uint8Array(5 * 5 * 4);
        gl.readPixels(Math.round(p.x * canvas.width / rect.width) - 2, Math.round(canvas.height - p.y * canvas.height / rect.height) - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return Array.from({ length: 25 }, (_, i) => [...pixels.subarray(i * 4, i * 4 + 4)]);
      };
      scene.current!.paintCamera(camera);
      for (const [x, y] of [[40 + inset, 100], [200 - inset, 100], [120, 40 + inset], [120, 160 - inset]]) {
        assert(patch(x, y).some(p => p[2] > 60), `${mode}: missing white border at ${x},${y}`);
      }
      assert(patch(120, 100).every(p => p[0] === 255 && p[1] === 0 && p[2] === 0), `${mode}: adding borders altered the layer's own pixels`);
      const center = point(120, 100);
      assert(scene.current!.pick(rect.left + center.x, rect.top + center.y)?.id === face.id, `${mode}: border intercepted picking`);
      flushSync(() => scene.current!.hover(rect.left + center.x, rect.top + center.y));
      scene.current!.paintCamera(camera);
      assert(patch(40 + inset, 100).some(p => p[2] > p[0] + 40 && p[1] > p[0] + 20), `${mode}: white border covered the blue hover`);
      flushSync(() => scene.current!.clearHover()); selected = face; render(); scene.current!.paintCamera(camera);
      assert(patch(40 + inset, 100).some(p => p[1] > p[0] + 20 && p[1] > p[2] + 40), `${mode}: white border covered the green selection`);
      const upload = gl.texImage2D.bind(gl), textureBytes = canvas.dataset.layerTextureBytes;
      let uploads = 0;
      gl.texImage2D = ((...args: Parameters<typeof upload>) => { uploads++; upload(...args); }) as typeof upload;
      appearance = { ...DEFAULT_LAYER_APPEARANCE, showOutlines: false, highlightStrength: "light" }; selected = null; render(); scene.current!.paintCamera(camera);
      for (const [x, y] of [[40 + inset, 100], [200 - inset, 100], [120, 40 + inset], [120, 160 - inset]]) {
        assert(patch(x, y).every(p => p[2] === 0), `${mode}: disabled ordinary border is still painted`);
      }
      assert(patch(120, 100).every(p => p[0] === 255 && p[1] === 0 && p[2] === 0), `${mode}: outlines toggle changed content pixels`);
      assert(scene.current!.pick(rect.left + center.x, rect.top + center.y)?.id === face.id, `${mode}: outlines toggle changed picking`);
      selected = face; const greens: number[] = [];
      for (const highlightStrength of ["light", "medium", "strong"] as const) {
        appearance = { ...DEFAULT_LAYER_APPEARANCE, showOutlines: false, highlightStrength }; render(); scene.current!.paintCamera(camera);
        greens.push(patch(120, 100)[12][1]);
        assert(patch(40 + inset, 100).some(p => p[1] > p[0] + 20 && p[1] > p[2] + 40), `${mode}: outline toggle hid the selected border`);
      }
      assert(greens[0] === 0 && greens[1] > greens[0] + 10 && greens[2] > greens[1] + 10, `${mode}: highlight levels did not change GPU pixels`);
      selected = null; render(); flushSync(() => scene.current!.hover(rect.left + center.x, rect.top + center.y)); scene.current!.paintCamera(camera);
      assert(patch(120, 100)[12][2] > 10, `${mode}: strong hover did not tint the content`);
      assert(patch(40 + inset, 100).some(p => p[2] > p[0] + 40 && p[1] > p[0] + 20), `${mode}: outline toggle hid the hover border`);
      flushSync(() => scene.current!.clearHover()); appearance = DEFAULT_LAYER_APPEARANCE; render(); scene.current!.paintCamera(camera);
      await tick(); scene.current!.paintCamera(camera);
      assert(uploads === 0 && canvas.dataset.layerTextureBytes === textureBytes, `${mode}: appearance changes reloaded textures`);
      assert(JSON.stringify(root) === original && gl.getError() === gl.NO_ERROR, `${mode}: appearance changes modified the snapshot or caused GPU errors`);
      selected = null; hidden = new Set([face.id]); render(); scene.current!.paintCamera(camera);
      assert(patch(40 + inset, 100).every(p => p[3] === 0), `${mode}: hiding the layer left its border behind`);
    }
    return ["pixel: native/trimmed/composite/legacy content has all four borders, unchanged own pixels and picking, blue/green highlights, hidden-border removal",
      "pixel: ordinary outlines disabled without changing content, picking, texture uploads or snapshot data",
      "pixel: three selection strengths and hover emphasis remain visible with ordinary outlines disabled"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
}

async function verifyRequiredOutlines() {
  const host = document.createElement("div"); Object.assign(host.style, { width: "500px", height: "400px", position: "relative" }); document.body.append(host);
  const mounted = createRoot(host), scene = createRef<LayerSceneHandle>(), current = fixture({ width: 300, height: 180 });
  const empty = node("empty", 10, 50, 90, 130), missing = node("missing", 110, 50, 190, 130), broken = node("broken", 210, 50, 290, 130);
  current.root.bounds = { left: 0, top: 0, right: 300, bottom: 180, raw: "[0,0][300,180]" };
  current.root.layerImageEmpty = empty.layerImageEmpty = true;
  missing.attributes = { "inspection-source": "debug-view" }; missing.layerImageStatus = "failed";
  broken.layerImageDataUrl = "data:image/png;base64,bm90LWFuLWltYWdl"; broken.layerImageSize = { width: 80, height: 80 };
  current.root.children = [empty, missing, broken]; const original = JSON.stringify(current.root);
  const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
  let selected: UiNode | null = broken;
  const draw = () => flushSync(() => mounted.render(<Layer3DPreview ref={scene} src={current.src} root={current.root} selectedNode={selected}
    expandedNodeIds={new Set([current.root.id])} appearance={{ ...DEFAULT_LAYER_APPEARANCE, showOutlines: false, highlightStrength: "light" }} size={{ width: 300, height: 180 }} renderScale={1} origin={{ left: 80, top: 80 }} camera={camera} onSelect={() => {}} />));
  try {
    draw(); const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
    await until(() => canvas.dataset.layerRenderer === "webgl" && Number(canvas.dataset.layerRenderVersion) > 0, "required-outline scene did not draw");
    scene.current!.paintCamera(camera); const gl = canvas.getContext("webgl")!, bounds = canvas.getBoundingClientRect();
    const point = (target: UiNode, edge: boolean) => {
      const z = Number(host.querySelector<HTMLElement>(`[data-layer-node-id="${target.id}"]`)!.dataset.layerZ), pivotZ = Number(host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerPivotZ);
      const scale = 1100 / (1100 - z + pivotZ), x = edge ? target.bounds!.left : (target.bounds!.left + target.bounds!.right) / 2;
      return { x: 230 + (x - 150) * scale, y: 170 };
    };
    const alpha = (target: UiNode) => {
      const p = point(target, true), pixels = new Uint8Array(5 * 5 * 4);
      gl.readPixels(Math.round(p.x * canvas.width / bounds.width) - 2, Math.round(canvas.height - p.y * canvas.height / bounds.height) - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return Math.max(...pixels.filter((_, i) => i % 4 === 3));
    };
    const alphas = [empty, missing, broken].map(alpha);
    assert(alphas[0] === 0 && alphas[1] > 60 && alphas[2] > 60, `outline toggle hid missing/undecodable images or left an ordinary empty outline: ${alphas}`);
    for (const target of [empty, missing, broken]) { const p = point(target, false); assert(scene.current!.pick(bounds.left + p.x, bounds.top + p.y)?.id === target.id, "outline visibility changed layer picking"); }
    selected = empty; draw(); scene.current!.paintCamera(camera);
    assert(alpha(empty) > 60 && alpha(broken) > 60, "invisible ordinary outline did not reveal selection or hid the unselected broken image");
    assert(JSON.stringify(current.root) === original && gl.getError() === gl.NO_ERROR, "required-outline rendering changed the snapshot or caused a GPU error");
    const folded = { ...missing, layerImageEmpty: true, children: [{ ...missing, id: "missing/child", children: [] }] };
    selected = null; current.root = { ...current.root, children: [empty, folded] }; draw(); scene.current!.paintCamera(camera);
    assert(alpha(folded) > 60, "folded parent with empty own image hid its missing-descendant outline");
    return ["pixel: missing and undecodable images retain outlines; confirmed empty outlines can hide and still pick/select; folded missing descendants stay visible"];
  } finally { flushSync(() => mounted.unmount()); host.remove(); }
}

async function verifyLayerAppearancePreferences() {
  const previous = localStorage.getItem(LAYER_APPEARANCE_STORAGE_KEY), host = document.createElement("div");
  Object.assign(host.style, { width: "640px", height: "520px" }); document.body.append(host);
  const mounted = createRoot(host), current = fixture({ width: 400, height: 320 }); let generation = 0, sessionKey = 0;
  const draw = () => flushSync(() => mounted.render(<ScreenshotPreview key={generation} sessionKey={sessionKey} src={current.src} root={current.root} selectedNode={current.root.children[0]} expandedNodeIds={new Set([current.root.id])} geometry={current.geometry} onSelect={() => {}} />));
  const controls = async () => {
    await until(() => { const button = host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child"); return Boolean(button && !button.disabled); }, "appearance controls did not enable");
    flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")!.click());
    flushSync(() => host.querySelector<HTMLElement>(".layer-settings summary")!.click());
    return { checkbox: host.querySelector<HTMLInputElement>('[aria-label="显示普通轮廓"]')!, select: host.querySelector<HTMLSelectElement>('[aria-label="选中强调强度"]')!, rotation: host.querySelector<HTMLSelectElement>('[aria-label="3D 旋转模式"]')! };
  };
  try {
    localStorage.removeItem(LAYER_APPEARANCE_STORAGE_KEY); draw(); let inputs = await controls();
    assert(inputs.checkbox.checked && inputs.select.value === "light" && inputs.rotation.value === "free", "appearance defaults changed the existing view");
    flushSync(() => inputs.checkbox.click());
    flushSync(() => { inputs.select.value = "strong"; inputs.select.dispatchEvent(new Event("change", { bubbles: true })); });
    flushSync(() => { inputs.rotation.value = "horizontal"; inputs.rotation.dispatchEvent(new Event("change", { bubbles: true })); });
    assert(JSON.stringify(JSON.parse(localStorage.getItem(LAYER_APPEARANCE_STORAGE_KEY)!)) === JSON.stringify({ showOutlines: false, showInvisible: false, highlightStrength: "strong", rotationMode: "horizontal" }), "appearance changes were not persisted");
    sessionKey++; draw(); inputs = await controls(); assert(!inputs.checkbox.checked && inputs.select.value === "strong" && inputs.rotation.value === "horizontal", "new snapshot reset local appearance");
    generation++; draw(); inputs = await controls(); assert(!inputs.checkbox.checked && inputs.select.value === "strong" && inputs.rotation.value === "horizontal", "reopening the preview did not restore appearance");
    assert(host.querySelector<HTMLElement>(".screenshot-frame")?.dataset.cameraPaintElevation === "0", "stored horizontal rotation started with pitch");
    flushSync(() => host.querySelector<HTMLButtonElement>(".layer-appearance-help button")!.click());
    assert(inputs.checkbox.checked && String(inputs.select.value) === "light" && String(inputs.rotation.value) === "free", "restore defaults did not update the controls");
    assert(localStorage.getItem(LAYER_APPEARANCE_STORAGE_KEY) === JSON.stringify(DEFAULT_LAYER_APPEARANCE), "restore defaults was not persisted");
    for (const value of ['{"showOutlines":"false","highlightStrength":"unknown","rotationMode":"vertical"}', "broken", "[]", "x".repeat(1024)]) {
      localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, value); generation++; draw(); inputs = await controls();
      assert(inputs.checkbox.checked && inputs.select.value === "light" && inputs.rotation.value === "free", "invalid appearance storage did not restore defaults");
    }
    localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, JSON.stringify({ showOutlines: false, highlightStrength: "medium" }));
    generation++; draw(); inputs = await controls();
    assert(!inputs.checkbox.checked && inputs.select.value === "medium" && inputs.rotation.value === "free", "legacy appearance did not keep its values with free rotation");
    return ["ScreenshotPreview: appearance controls persist across new snapshots/remount, restore defaults and recover malformed local preferences"];
  } finally {
    flushSync(() => mounted.unmount()); host.remove();
    if (previous === null) localStorage.removeItem(LAYER_APPEARANCE_STORAGE_KEY); else localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, previous);
  }
}

async function verifyHorizontalRotation() {
  const previous = localStorage.getItem(LAYER_APPEARANCE_STORAGE_KEY), host = document.createElement("div");
  host.style.cssText = "position:relative;width:640px;height:520px"; document.body.append(host);
  const mounted = createRoot(host), current = fixture({ width: 400, height: 320 });
  let selected: UiNode = current.root.children[0], layerFocus: LayerFocus | null = null;
  const draw = () => flushSync(() => mounted.render(<ControlledScreenshotPreview src={current.src} root={current.root} selectedNode={selected}
    expandedNodeIds={new Set([current.root.id])} geometry={current.geometry} layerFocus={layerFocus} hiddenNodeIds={new Set()} doubleClickAction="focus-branch"
    onSelect={value => { selected = value; draw(); }} onDoubleClick={() => {}} onOpenLayerMenu={() => {}}
    onLayerAction={action => { if (action === "exit-focus") { layerFocus = null; draw(); } }} />));
  const frame = () => host.querySelector<HTMLElement>(".screenshot-frame")!;
  const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
  const key = (value: string) => flushSync(() => frame().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value })));
  const yaw = () => Number(frame().dataset.cameraPaintAzimuth);
  const pan = () => host.querySelector<HTMLElement>(".screenshot-stage")!.style.getPropertyValue("--layer-live-pan");
  const zoom = () => host.querySelector(".zoom-readout")?.textContent;
  const chooseMode = (value: "free" | "horizontal") => {
    const settings = host.querySelector<HTMLDetailsElement>(".layer-settings")!;
    settings.open = true;
    const select = settings.querySelector<HTMLSelectElement>('[aria-label="3D 旋转模式"]')!;
    flushSync(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
    settings.open = false;
  };
  const horizontal = () => {
    assert(Number(frame().dataset.cameraPaintElevation) === 0 && Number(frame().dataset.cameraPaintRoll) === 0, "horizontal camera regained pitch or roll");
    const gl = canvas().getContext("webgl")!, program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    const rotation = gl.getUniform(program, gl.getUniformLocation(program, "u_rotation")!) as Float32Array;
    const roll = gl.getUniform(program, gl.getUniformLocation(program, "u_roll")!) as Float32Array;
    near(rotation[2], 1, "horizontal GPU view retained pitch", .0001);
    near(rotation[3], 0, "horizontal GPU view retained pitch", .0001);
    near(roll[0], 1, "horizontal GPU view retained roll", .0001);
    near(roll[1], 0, "horizontal GPU view retained roll", .0001);
  };
  const drag = (dx: number, dy: number, shiftKey = false) => {
    const bounds = frame().getBoundingClientRect(); frame().setPointerCapture = () => {};
    for (const [type, x, y] of [["pointerdown", 100, 100], ["pointermove", 100 + dx, 100 + dy], ["pointerup", 100 + dx, 100 + dy]] as const) {
      flushSync(() => frame().dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 96, isPrimary: true, button: 0, shiftKey, clientX: bounds.left + x, clientY: bounds.top + y })));
    }
  };
  try {
    localStorage.removeItem(LAYER_APPEARANCE_STORAGE_KEY); draw();
    await until(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.disabled === false, "rotation fixture image did not load");
    flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")!.click());
    await until(() => canvas()?.dataset.layerRenderer === "webgl", "rotation fixture scene did not load");
    key("ArrowDown"); drag(40, 50);
    assert(Number(frame().dataset.cameraPaintElevation) > 12, "free rotation lost vertical drag or keyboard orbit");
    drag(30, 20, true);
    const preset = host.querySelector<HTMLSelectElement>(".zoom-preset-select")!;
    flushSync(() => { preset.value = "2"; preset.dispatchEvent(new Event("change", { bubbles: true })); });
    const before = { yaw: yaw(), pan: pan(), zoom: zoom(), selected: selected.id };
    chooseMode("horizontal"); horizontal();
    assert(yaw() === before.yaw && pan() === before.pan && zoom() === before.zoom && selected.id === before.selected, "rotation mode reset yaw, pan, zoom or selection");
    drag(0, 60); horizontal(); near(yaw(), before.yaw, "vertical-only drag rotated the horizontal view");
    drag(40, 60); horizontal(); near(yaw(), before.yaw + 18, "horizontal drag did not rotate yaw");
    const beforeKeys = yaw(); key("ArrowUp"); key("ArrowDown"); horizontal(); near(yaw(), beforeKeys, "vertical keys rotated the horizontal view");
    key("ArrowLeft"); key("ArrowRight"); horizontal(); near(yaw(), beforeKeys, "horizontal keys did not reverse yaw");
    for (const mode of ["2D", "3D 层级"]) flushSync(() => [...host.querySelectorAll<HTMLButtonElement>(".view-mode-toggle button")].find(button => button.textContent === mode)!.click());
    await until(() => canvas()?.dataset.layerRenderer === "webgl", "horizontal 3D view did not return");
    horizontal(); assert(pan() === before.pan && zoom() === before.zoom, "2D/3D switch lost the horizontal view's pan or zoom");
    key("Home"); horizontal();
    await until(() => { horizontal(); return Math.abs(yaw() - 40) < .001; }, "horizontal reset animation did not finish");
    key("0"); horizontal();
    chooseMode("free"); key("ArrowDown");
    assert(Number(frame().dataset.cameraPaintElevation) === 6, "free rotation did not restore vertical controls");
    drag(24, 18, true);
    flushSync(() => { preset.value = "2"; preset.dispatchEvent(new Event("change", { bubbles: true })); });
    const saved = { yaw: yaw(), pan: pan(), zoom: zoom(), selected: selected.id };
    layerFocus = { kind: "branch", node: current.root }; draw(); chooseMode("horizontal"); horizontal();
    chooseMode("free");
    flushSync(() => host.querySelector<HTMLButtonElement>(".exit-layer-focus")!.click());
    assert(Number(frame().dataset.cameraPaintElevation) === 0 && Number(frame().dataset.cameraPaintRoll) === 0, "focus return restored the old tilted camera after a mode change");
    assert(yaw() === saved.yaw && pan() === saved.pan && zoom() === saved.zoom && selected.id === saved.selected, "focus return failed to restore pan, zoom, yaw or selection");
    key("ArrowDown"); key("ArrowRight"); key("Home"); chooseMode("horizontal");
    for (let i = 0; i < 16; i++) { await tick(); horizontal(); }
    layerFocus = { kind: "branch", node: current.root }; draw();
    flushSync(() => host.querySelector<HTMLButtonElement>(".exit-layer-focus")!.click()); horizontal();
    return ["ScreenshotPreview: horizontal drag/keys, fit/reset animation and mid-animation mode changes keep GPU pitch/roll at zero; 2D/3D and branch focus return preserve the view; free mode restores vertical controls"];
  } finally {
    flushSync(() => mounted.unmount()); host.remove();
    if (previous === null) localStorage.removeItem(LAYER_APPEARANCE_STORAGE_KEY); else localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, previous);
  }
}

async function verifyLayerOcclusion() {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "800px", height: "900px", position: "relative" });
  document.body.append(host);
  const reactRoot = createRoot(host), scene = createRef<LayerSceneHandle>();
  const root = node("0", 0, 0, 360, 780), face = node("0/0", 0, 0, 360, 780), front = node("0/1", 40, 100, 100, 160);
  root.layerImageEmpty = front.layerImageEmpty = true;
  face.index = 0; front.index = 1;
  const bitmap = document.createElement("canvas"); bitmap.width = bitmap.height = 4;
  const context = bitmap.getContext("2d")!;
  context.fillStyle = "red"; context.fillRect(0, 0, 4, 4);
  face.layerImageDataUrl = bitmap.toDataURL(); face.layerImageSize = { width: 4, height: 4 };
  root.children = [face, front];
  const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
  const render = (alpha: number) => flushSync(() => reactRoot.render(<Layer3DPreview key={alpha} ref={scene} src={face.layerImageDataUrl!} root={{ ...root, children: [{ ...face, attributes: { "effective-alpha": String(alpha) } }, front] }} selectedNode={null} expandedNodeIds={new Set([root.id])} size={{ width: 360, height: 780 }} renderScale={1} origin={{ left: 220, top: 30 }} camera={camera} onSelect={() => {}} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>("canvas")!;
  const ready = () => until(() => canvas()?.dataset.layerRenderer === "webgl" && canvas().dataset.layerTextureCount === "1", "angled occlusion textures did not settle");
  try {
    render(1); await ready();
    const pivotZ = Number(host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerPivotZ);
    const frontZ = Number(host.querySelector<HTMLElement>('[data-layer-node-id="0/1"]')!.dataset.layerZ);
    const faceZ = Number(host.querySelector<HTMLElement>('[data-layer-node-id="0/0"]')!.dataset.layerZ);
    assert(frontZ > faceZ, "occlusion fixture must place the small outline in front of the full-size face");
    const views = [0, 20, 29, 30, 30.5, 31, 35, 40, 60, 80, 89, 91, 100, 140, 150, 160, 180, 200, 330, 30].map(azimuth => ({ ...camera, azimuth }));
    views.push({ ...camera, azimuth: 31, elevation: 25, roll: 18 }, { ...camera, azimuth: 150, elevation: -20, roll: -15 });
    const sample = (view: typeof camera) => {
      scene.current!.paintCamera(view);
      const yaw = -view.azimuth * Math.PI / 180, pitch = -view.elevation * Math.PI / 180, roll = -view.roll * Math.PI / 180;
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const project = (x: number, y: number) => {
        const rx = cy * (x - 180) + sy * (frontZ - pivotZ), rz = -sy * (x - 180) + cy * (frontZ - pivotZ);
        const ry = cp * (390 - y) - sp * rz, depth = sp * (390 - y) + cp * rz;
        const scale = view.distance / (view.distance - depth);
        return { x: 400 + (Math.cos(roll) * rx - Math.sin(roll) * ry) * scale, y: 420 - (Math.sin(roll) * rx + Math.cos(roll) * ry) * scale };
      };
      // Independent oracle: intersect the eye-to-control ray with the opaque
      // face, rather than sharing the renderer's plane-sort implementation.
      const eye = { x: 180 - sy * cp * view.distance, y: 390 - sp * view.distance, z: pivotZ + cy * cp * view.distance };
      const blocked = (x: number, y: number) => {
        const t = (faceZ - eye.z) / (frontZ - eye.z);
        const bx = eye.x + (x - eye.x) * t, by = eye.y + (y - eye.y) * t;
        return t > 0 && t < 1 && bx > 0 && bx < 360 && by > 0 && by < 780;
      };
      const bounds = canvas().getBoundingClientRect(), edge = project(100, 130), center = project(70, 130);
      const pixels = new Uint8Array(5 * 5 * 4), gl = canvas().getContext("webgl")!;
      gl.readPixels(Math.round(edge.x * canvas().width / bounds.width) - 2, Math.round(canvas().height - edge.y * canvas().height / bounds.height) - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { blue: Math.max(...pixels.filter((_, i) => i % 4 === 2)), edgeBlocked: blocked(100, 130), expectedPick: blocked(70, 130) ? face.id : front.id, picked: scene.current!.pick(bounds.left + center.x, bounds.top + center.y)?.id };
    };
    for (const view of views) {
      const result = sample(view), label = `orbit ${view.azimuth}/${view.elevation}/${view.roll}`;
      assert(result.edgeBlocked ? result.blue === 0 : result.blue > 10, `${label}: incorrect border occlusion (${JSON.stringify(result)})`);
      assert(result.picked === result.expectedPick, `${label}: picking disagrees with the nearest ray intersection (${JSON.stringify(result)})`);
    }
    // A translucent foreground must attenuate a rear border, not erase it.
    render(0.5); await ready();
    const translucent = sample({ ...camera, azimuth: 150 });
    assert(translucent.edgeBlocked && translucent.blue > 10 && translucent.blue < 120, `translucent foreground lost alpha blending over the rear border (${JSON.stringify(translucent)})`);
    return ["pixel: off-center outline vs opaque face across 30°/31°, front/back/edge-on orbit, pitch/roll, ray-checked picking and translucent foreground"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
}

async function benchmarkLayerRendering() {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "840px", height: "580px", position: "relative" });
  document.body.append(host);
  const reactRoot = createRoot(host), scene = createRef<LayerSceneHandle>();
  const root = node("render-root", 0, 0, 360, 780);
  const bitmap = document.createElement("canvas"); bitmap.width = bitmap.height = 16;
  const context = bitmap.getContext("2d")!;
  for (let cell = 0; cell < 32; cell++) {
    const x = cell % 4 * 88, y = Math.floor(cell / 4) * 96;
    for (let layer = 0; layer < 16; layer++) {
      const child = node(`render-${cell}-${layer}`, x, y, x + 80, y + 88);
      child.attributes = { "inspection-source": "debug-view" };
      if (layer < 15) child.layerImageEmpty = true;
      else {
        context.fillStyle = `hsl(${cell * 11}, 55%, 55%)`; context.fillRect(0, 0, 16, 16);
        child.layerImageDataUrl = bitmap.toDataURL(); child.layerImageSize = { width: 16, height: 16 };
      }
      root.children.push(child);
    }
  }
  root.layerImageEmpty = true;
  const camera = { distance: 1100, azimuth: 40, elevation: 12, roll: 0, layerGap: 96, panX: 0, panY: 0 };
  const samples: number[] = [], draws: number[] = [];
  const screenSrc = bitmap.toDataURL(), expanded = new Set([root.id]), baseline = layerImageBaseline(root);
  let displayedRoot: UiNode = structuredClone(root);
  let recoveryFocus: UiNode | null = null;
  const render = () => flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} src={screenSrc} root={displayedRoot} selectedNode={displayedRoot.children[15]} focusedNode={recoveryFocus} expandedNodeIds={expanded} size={{ width: 360, height: 780 }} renderScale={.55} origin={{ left: 321, top: 75 }} camera={camera} onSelect={() => {}} />));
  try {
    render();
    const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
    await until(() => canvas.dataset.layerRenderer === "webgl" && canvas.dataset.layerTextureCount === "32", "render benchmark textures did not settle");
    const gl = canvas.getContext("webgl")!, draw = gl.drawArrays.bind(gl), upload = gl.texImage2D.bind(gl);
    const rendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const gpuRenderer = String(rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    let calls = 0, uploads = 0;
    gl.drawArrays = (...args) => { calls++; draw(...args); };
    gl.texImage2D = ((...args: Parameters<typeof upload>) => { uploads++; upload(...args); }) as typeof upload;
    for (let i = 0; i < 132; i++) {
      await tick(); calls = 0;
      const start = performance.now();
      scene.current!.paintCamera({ ...camera, azimuth: 20 + Math.sin(i / 20) * 30, elevation: 12 + Math.cos(i / 20) * 8 });
      if (i >= 12) { samples.push(performance.now() - start); draws.push(calls); }
    }
    assert(uploads === 0, "orbit uploaded or decoded unchanged textures");
    assert(Math.max(...draws) < 128, "512-layer borders reverted to per-plane draw calls");
    assert(host.querySelectorAll(".layer-plane").length === 512, "render optimization dropped controls");
    const bounds = canvas.getBoundingClientRect();
    assert(scene.current!.pick(bounds.left + Number(canvas.dataset.layerProbeX), bounds.top + Number(canvas.dataset.layerProbeY)), "batched scene lost picking");
    assert(gl.getError() === gl.NO_ERROR, "render benchmark has a WebGL error");
    const batchBitmap = document.createElement("canvas"); batchBitmap.width = batchBitmap.height = 256;
    const batchContext = batchBitmap.getContext("2d")!;
    const previewTimes: Array<{ mergeMs: number; commitMs: number; gpuReadyMs: number; uploads: number }> = [];
    const previewReady = (ids: string[]) => layerPreviewReadiness(ids,
      Array.from(host.querySelectorAll<HTMLElement>(".layer-plane[data-layer-texture-identity]")).map(plane => ({ id: plane.dataset.layerNodeId, key: plane.dataset.layerTextureIdentity })),
      JSON.parse(canvas.dataset.layerCommittedNativeTextures || "[]"));
    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < 40; i++) {
        const index = (batch * 40 + i) % 32 * 16 + Math.floor((batch * 40 + i) / 32);
        const child = root.children[index];
        batchContext.fillStyle = `hsl(${(batch * 40 + i) * 17}, 70%, 50%)`;
        batchContext.fillRect(0, 0, 256, 256);
        child.layerImageDataUrl = batchBitmap.toDataURL(); child.layerImageSize = { width: 256, height: 256 };
        child.layerImageStatus = "captured"; child.layerImageEmpty = false;
      }
      const started = performance.now(), updates = changedLayerImages(root, baseline)!;
      displayedRoot = mergeLayerImages(displayedRoot, updates);
      const merged = performance.now();
      render();
      const committed = performance.now(), beforeUploads = uploads;
      const ids = updates.map(update => update.id);
      assert(!previewReady(ids).ready, "previous submitted image versions falsely satisfy a fresh batch");
      await until(() => previewReady(ids).ready, "preview identities did not reach the submitted draw");
      assert(Number(canvas.dataset.layerTextureCount) === 32 + (batch + 1) * 40, "preview texture cache count changed unexpectedly");
      await tick(); scene.current!.paintCamera(camera); gl.finish();
      const uploaded = uploads - beforeUploads;
      assert(updates.length === 40 && uploaded === 40, `preview reuploaded unchanged textures: ${updates.length} updates, ${uploaded} uploads`);
      assert(gl.getError() === gl.NO_ERROR, "preview texture upload has a WebGL error");
      assert(previewReady(ids).eligible === 40 && previewReady(ids).drawn === 40, "preview readiness lost visible batch identities");
      previewTimes.push({ mergeMs: merged - started, commitMs: committed - merged, gpuReadyMs: performance.now() - started, uploads: uploaded });
    }
    const previewTextureBytes = Number(canvas.dataset.layerTextureBytes);
    // The main-process preview router re-anchors a tree when recovery changes bounds.
    const moved = root.children[15], oldLeft = moved.bounds!.left;
    moved.bounds = { ...moved.bounds!, left: oldLeft + 12, right: moved.bounds!.right + 12 };
    batchContext.fillStyle = "#ff00ff"; batchContext.fillRect(0, 0, 256, 256);
    moved.layerImageDataUrl = batchBitmap.toDataURL();
    assert(changedLayerImages(root, baseline) === null, "geometry recovery incorrectly used image-only preview");
    const beforeMoveVersion = Number(canvas.dataset.layerRenderVersion), beforeMoveUploads = uploads;
    displayedRoot = structuredClone(root); recoveryFocus = displayedRoot.children[15]; render();
    await until(() => Number(canvas.dataset.layerRenderVersion) > beforeMoveVersion && uploads > beforeMoveUploads,
      "re-anchored recovery did not render fresh geometry and pixels");
    assert(displayedRoot.children[15].bounds!.left === oldLeft + 12, "recovery retained old bounds");
    await tick(); scene.current!.paintCamera(camera); gl.finish();
    assert(gl.getError() === gl.NO_ERROR, "geometry recovery has a WebGL error");
    const recoveredPick = scene.current!.pick(bounds.left + Number(canvas.dataset.layerProbeX), bounds.top + Number(canvas.dataset.layerProbeY));
    assert(recoveredPick?.id === moved.id && recoveredPick.bounds!.left === oldLeft + 12,
      `recovered scene picking retained stale geometry: ${JSON.stringify({ expected: moved.id, left: oldLeft + 12, actual: recoveredPick?.id, bounds: recoveredPick?.bounds, probeX: canvas.dataset.layerProbeX, probeY: canvas.dataset.layerProbeY })}`);
    scene.current!.paintCamera(camera);
    const screenshot = canvas.toDataURL("image/png");
    // A rear outline must not bleed through an opaque face; a front outline
    // must remain visible and selectable. Check pixels, not only draw counts.
    const occlusionRoot = node("occlusion", 0, 0, 200, 160);
    const rear = node("rear-outline", 30, 30, 170, 130), face = node("opaque-face", 10, 10, 190, 150), front = node("front-outline", 50, 50, 150, 110);
    occlusionRoot.layerImageEmpty = rear.layerImageEmpty = front.layerImageEmpty = true;
    context.fillStyle = "red"; context.fillRect(0, 0, 16, 16);
    face.layerImageDataUrl = bitmap.toDataURL(); face.layerImageSize = { width: 16, height: 16 };
    occlusionRoot.children = [rear, face, front];
    const straight = { ...camera, azimuth: 0, elevation: 0, layerGap: 64 };
    const beforeOcclusionUploads = uploads;
    flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} src={face.layerImageDataUrl!} root={occlusionRoot} selectedNode={null} expandedNodeIds={new Set([occlusionRoot.id])} size={{ width: 200, height: 160 }} renderScale={1} origin={{ left: 80, top: 80 }} camera={straight} onSelect={() => {}} />));
    await until(() => canvas.dataset.layerRenderer === "webgl" && canvas.dataset.layerTextureCount === "1"
      && uploads > beforeOcclusionUploads, "occlusion textures did not settle");
    await tick();
    scene.current!.paintCamera(straight);
    const maxBlue = (x: number) => {
      const ratio = canvas.width / canvas.clientWidth, pixels = new Uint8Array(5 * 5 * 4);
      gl.readPixels(Math.round(x * ratio) - 2, Math.round(canvas.height - 160 * ratio) - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return Math.max(...pixels.filter((_, i) => i % 4 === 2));
    };
    assert(maxBlue(180 - 70 * 1100 / 1132) === 0, "batched rear outline leaks through the opaque face");
    assert(maxBlue(180 - 50 * 1100 / 1004) > 10, "front outline lost its visible border");
    assert(scene.current!.pick(bounds.left + 180, bounds.top + 160)?.id === front.id, "outline batching changed front-most picking");
    samples.sort((a, b) => a - b); draws.sort((a, b) => a - b);
    return { layers: 512, textures: 32, samples: samples.length, medianCpuMs: samples[60], p95CpuMs: samples[114], medianDrawCalls: draws[60], maxDrawCalls: draws.at(-1), previewTimes, geometryPreviewReanchored: true, textureBytes: previewTextureBytes, gpuRenderer, scope: "CPU submission and synthetic 40-image preview batches in WebGL; gl.finish confirms GPU completion, not monitor refresh", screenshot };
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
}

async function verifyCollapsedReload() {
  const pixels = document.createElement("canvas"); pixels.width = pixels.height = 600;
  pixels.getContext("2d")!.fillStyle = "blue"; pixels.getContext("2d")!.fillRect(0, 0, 600, 600);
  const src = pixels.toDataURL(), checks: string[] = [];
  for (const nested of [false, true]) {
    const parent = node(nested ? "0/0" : "0", 0, 0, 600, 600);
    const child = node(`${parent.id}/0`, 0, 0, 600, 600);
    parent.children = [child]; child.layerImageDataUrl = src; child.layerImageSize = { width: 600, height: 600 };
    const root = nested ? node("0", 0, 0, 600, 600) : parent;
    if (nested) root.children = [parent];
    const host = document.createElement("div"); Object.assign(host.style, { width: "800px", height: "800px", position: "relative" });
    document.body.append(host); const mounted = createRoot(host), scene = createRef<LayerSceneHandle>();
    const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
    const draw = (expanded: boolean) => flushSync(() => mounted.render(<Layer3DPreview ref={scene} src={src} root={root} selectedNode={child}
      expandedNodeIds={new Set([...(nested ? [root.id] : []), ...(expanded ? [parent.id] : [])])}
      size={{ width: 600, height: 600 }} renderScale={1} origin={{ left: 100, top: 100 }} camera={camera} onSelect={() => {}} />));
    const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
    const original = CanvasRenderingContext2D.prototype.getImageData; let toggled = false;
    CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof original>) {
      // Interrupt the production alpha scan after upload, while its texture is
      // still in flight. Expanding evicts it; folding reenters the same demand.
      if (!toggled && this.canvas.width === 600 && args[3] === 256) {
        toggled = true; draw(true); scene.current!.interruptMotion(); draw(false);
      }
      return original.apply(this, args);
    };
    const read = () => {
      scene.current!.paintCamera(camera);
      const gl = canvas().getContext("webgl")!, rgba = new Uint8Array(4);
      gl.readPixels(canvas().width / 2, canvas().height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      return [...rgba];
    };
    const settled = () => canvas()?.dataset.layerTextureCount === "1" && canvas()?.dataset.layerTexturePendingCount === "0" && canvas()?.dataset.layerAnimationProgress === "1";
    try {
      draw(false);
      await until(() => toggled && settled(), "folded parent did not reload its evicted in-flight composite");
      assert(read().join(",") === "0,0,255,255", "folded parent became blank after rapid reentry");
      const bounds = canvas().getBoundingClientRect();
      assert(scene.current!.pick(bounds.left + 400, bounds.top + 400)?.id === parent.id, "reloaded parent lost its hit target");
      for (let repeat = 0; repeat < 2; repeat++) {
        draw(true); await until(settled, "re-expansion did not load the child's independent image");
        draw(false); await until(settled, "repeated folding did not load the parent composite");
        assert(read().join(",") === "0,0,255,255", "repeated folding lost visible child pixels");
      }
      checks.push(`pixel: ${nested ? "nested" : "root"} parent reload after alpha-scan eviction, descendant selection and repeated folding`);
    } finally { CanvasRenderingContext2D.prototype.getImageData = original; flushSync(() => mounted.unmount()); host.remove(); }
  }
  return checks;
}

async function verifyLayerComposites() {
  const rect = { left: 0, top: 0, width: 20, height: 20 };
  const images = new Map<string, HTMLCanvasElement>();
  const imageNode = (id: string, color: string | null, left = 0, top = 0, right = 20, bottom = 20): UiNode => {
    const result = node(id, left, top, right, bottom);
    result.attributes = { alpha: "1", "effective-alpha": "1", "clip-children": "true" };
    if (color) {
      const image = document.createElement("canvas"); image.width = right - left; image.height = bottom - top;
      const context = image.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, image.width, image.height);
      images.set(id, image); result.layerImageDataUrl = id; result.layerImageSize = { width: image.width, height: image.height };
    }
    return result;
  };
  const render = (root: UiNode) => composeSubtreeImage(root, rect, async (node) => images.get(node.id) ?? null);
  const pixel = (canvas: HTMLCanvasElement, x: number, y: number) => [...canvas.getContext("2d")!.getImageData(x, y, 1, 1).data];
  const expect = (actual: number[], expected: number[], message: string) => assert(actual.every((n, i) => Math.abs(n - expected[i]) <= 1), `${message}: ${actual} != ${expected}`);
  const checks: string[] = [];
  const parent = imageNode("parent", "red"), child = imageNode("child", "blue", 0, 0, 10, 20);
  parent.attributes = { ...parent.attributes, alpha: "0.5", "effective-alpha": "0.5" };
  child.attributes = { ...child.attributes, "effective-alpha": "0.5" }; parent.children = [child];
  let output = await render(parent);
  expect(pixel(output, 4, 4), [0, 0, 255, 128], "group alpha must not accumulate on overlapping children");
  expect(pixel(output, 15, 4), [255, 0, 0, 128], "parent-only alpha");
  expect(pixel(images.get("child")!, 4, 4), [0, 0, 255, 255], "own bitmap must remain unchanged");
  parent.attributes["effective-alpha"] = "0.25";
  output = await render(parent);
  expect(pixel(output, 4, 4), [0, 0, 255, 64], "collapsed branch retains ancestor alpha once");
  checks.push("pixel: isolated bitmaps, group alpha and ancestor alpha");
  output = await composeSubtreeImage(parent, rect, async node => images.get(node.id) ?? null, 2_000_000, new Set([parent.id]));
  expect(pixel(output, 4, 4), [0, 0, 255, 64], "hidden parent's child remains visible when compositing");
  expect(pixel(output, 15, 4), [0, 0, 0, 0], "hidden parent's own background stays absent");
  output = await composeSubtreeImage(parent, rect, async node => images.get(node.id) ?? null, 2_000_000, new Set([child.id]));
  expect(pixel(output, 4, 4), [255, 0, 0, 64], "folding must not resurrect a hidden child");
  checks.push("pixel: hidden planes stay absent in collapsed composites without hiding their children");

  const root = imageNode("root", null), group = imageNode("group", null, 4, 4, 12, 12), overflow = imageNode("overflow", "blue", 0, 0, 18, 18);
  group.children = [overflow]; root.children = [group];
  output = await render(root);
  expect(pixel(output, 2, 2), [0, 0, 0, 0], "ancestor clip must hide overflow");
  expect(pixel(output, 6, 6), [0, 0, 255, 255], "content inside ancestor clip");
  root.attributes!["clip-children"] = "false";
  output = await render(root);
  expect(pixel(output, 2, 2), [0, 0, 255, 255], "clipChildren false allows overflow");
  checks.push("pixel: ancestor clipping and explicit overflow");

  const padded = imageNode("padded", "red"), full = imageNode("full", "blue"); padded.children = [full];
  padded.attributes = { ...padded.attributes, "clip-to-padding": "true", "padding-left": "4", "padding-top": "4", "padding-right": "4", "padding-bottom": "4" };
  output = await render(padded);
  expect(pixel(output, 2, 2), [255, 0, 0, 255], "padding clip must preserve parent's own background");
  expect(pixel(output, 6, 6), [0, 0, 255, 255], "padding interior");
  checks.push("pixel: padding clips descendants, not parent background");

  const roundedParent = imageNode("rounded-parent", "blue"), roundedRed = imageNode("rounded-red", "red");
  const roundedGreen = imageNode("rounded-green", "#00ff00", 8, 0, 20, 20);
  roundedParent.attributes = { ...roundedParent.attributes, alpha: "0.5", "effective-alpha": "0.5", "clip-to-outline": "true",
    "sdk-outlineLeft": "0", "sdk-outlineTop": "0", "sdk-outlineRight": "20", "sdk-outlineBottom": "20", "sdk-outlineRadius": "5" };
  roundedGreen.attributes = { ...roundedGreen.attributes, alpha: "0.5" };
  roundedParent.children = [roundedRed, roundedGreen];
  output = await render(roundedParent);
  expect(pixel(output, 0, 0), [0, 0, 0, 0], "rounded parent clips child pixels at its corner");
  expect(pixel(output, 3, 10), [255, 0, 0, 128], "parent alpha applies once to its opaque child");
  expect(pixel(output, 15, 10), [128, 128, 0, 128], "overlapping semi-transparent sibling stays inside one parent alpha");
  delete roundedParent.attributes["sdk-outlineRadius"];
  let unsupportedRejected = false;
  try { await render(roundedParent); }
  catch (error) { unsupportedRejected = error instanceof Error && error.message.includes("自定义轮廓裁剪"); }
  assert(unsupportedRejected, "unknown outlines must not show a misleading group image");
  checks.push("pixel: rounded outline, parent/child alpha and unsupported outline");

  const front = imageNode("front", "red"), back = imageNode("back", "blue");
  front.attributes!.z = "5"; back.attributes!.z = "1"; root.children = [front, back];
  output = await render(root);
  expect(pixel(output, 6, 6), [255, 0, 0, 255], "measured sibling Z controls compositing");
  front.visibleToUser = false; front.children = [imageNode("hidden-child", "green")];
  output = await render(root);
  expect(pixel(output, 6, 6), [0, 0, 255, 255], "hidden ancestor hides its branch");
  output = await render(imageNode("missing", null));
  expect(pixel(output, 6, 6), [0, 0, 0, 0], "missing bitmap must never borrow another layer or screenshot");
  checks.push("pixel: Z order, hidden branches and missing image transparency");

  const qmlNode = async (id: string, fill: number[], width = 20, radius = 0, borderWidth = 0) => {
    const result = imageNode(id, null, 0, 0, width, 20);
    const style = qmlStyleFrom([fill, [0, 0, 1, 1], borderWidth, [radius, radius, radius, radius], false, null, false])!;
    result.attributes = { "inspection-source": "debug-qml", alpha: "1", "effective-alpha": "1", z: "0" };
    result.layerImageStatus = "style";
    result.layerImageSize = { width, height: 20 };
    result.layerImageDataUrl = `data:image/svg+xml,${encodeURIComponent(qmlStyleSvg(style, result.layerImageSize, result.layerImageSize, 1))}`;
    const image = new Image(); image.src = result.layerImageDataUrl; await image.decode();
    const decoded = document.createElement("canvas"); decoded.width = width; decoded.height = 20;
    decoded.getContext("2d")!.drawImage(image, 0, 0); images.set(id, decoded);
    return result;
  };
  const rounded = await qmlNode("qml-rounded", [1, 0, 0, 0.5], 20, 6, 2);
  expect(pixel(images.get(rounded.id)!, 10, 10), [255, 0, 0, 128], "QML own color retains alpha");
  expect(pixel(images.get(rounded.id)!, 0, 0), [0, 0, 0, 0], "QML rounded corner stays transparent");
  expect(pixel(images.get(rounded.id)!, 10, 0), [0, 0, 255, 255], "QML border stays inside the bounds");
  const qmlParent = await qmlNode("qml-parent", [1, 0, 0, 1]);
  const qmlChild = await qmlNode("qml-child", [0, 0, 1, 1], 10);
  qmlParent.children = [qmlChild];
  qmlParent.attributes!["effective-alpha"] = qmlChild.attributes!["effective-alpha"] = "0.5";
  output = await render(qmlParent);
  expect(pixel(output, 4, 4), [85, 0, 170, 192], "ordinary QML opacity applies per item, not as an offscreen group");
  qmlParent.attributes!["qml-layer-enabled"] = "true";
  output = await render(qmlParent);
  expect(pixel(output, 4, 4), [0, 0, 255, 128], "QML layer.enabled applies group opacity once");
  qmlParent.attributes!["qml-layer-enabled"] = "false";
  qmlParent.attributes!["effective-alpha"] = qmlChild.attributes!["effective-alpha"] = "1";
  qmlChild.attributes!.z = "-1";
  output = await render(qmlParent);
  expect(pixel(output, 4, 4), [255, 0, 0, 255], "negative QML Z draws behind own background");
  qmlChild.attributes!.z = "0";
  qmlParent.bounds = { left: 4, top: 4, right: 12, bottom: 12, raw: "" };
  qmlParent.attributes!["qml-clip"] = "true";
  const qmlContainer = imageNode("qml-container", null); qmlContainer.children = [qmlParent];
  qmlContainer.attributes = { "inspection-source": "debug-qml" };
  output = await render(qmlContainer);
  expect(pixel(output, 2, 2), [0, 0, 0, 0], "QML clip cuts descendants at this item's bounds");
  expect(pixel(output, 6, 6), [0, 0, 255, 255], "QML clip retains children inside");
  qmlParent.bounds = { left: 0, top: 0, right: 20, bottom: 20, raw: "" };
  checks.push("pixel: QML RGBA, round corners, border, per-item/group opacity, negative Z and clipping");

  const host = document.createElement("div");
  Object.assign(host.style, { width: "400px", height: "400px", position: "relative" });
  document.body.append(host);
  const reactRoot = createRoot(host), scene = createRef<LayerSceneHandle>();
  const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
  parent.attributes["effective-alpha"] = "0.5";
  parent.layerImageDataUrl = images.get("parent")!.toDataURL();
  child.layerImageDataUrl = images.get("child")!.toDataURL();
  const draw = (expanded: boolean, screen = parent.layerImageDataUrl!) => flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} src={screen} root={parent} selectedNode={parent} expandedNodeIds={new Set(expanded ? [parent.id] : [])} size={{ width: 20, height: 20 }} renderScale={10} origin={{ left: 50, top: 50 }} camera={camera} onSelect={() => {}} />));
  try {
    draw(true);
    const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
    try {
      await until(() => canvas()?.dataset.layerTextureCount === "2", "independent WebGL textures did not load");
    } catch (error) {
      throw new Error(`${error}; canvas=${JSON.stringify(canvas()?.dataset)}, warning=${host.querySelector(".layer-resource-note")?.textContent ?? "none"}`);
    }
    const stableCanvas = canvas(), stableGl = stableCanvas.getContext("webgl")!;
    const beforeVersion = Number(stableCanvas.dataset.layerRenderVersion);
    const deleteTexture = stableGl.deleteTexture.bind(stableGl);
    let deleted = 0;
    stableGl.deleteTexture = texture => { deleted++; deleteTexture(texture); };
    try {
      draw(true, child.layerImageDataUrl!);
      await until(() => Number(canvas().dataset.layerRenderVersion) > beforeVersion, "new screenshot did not repaint WebGL");
      assert(canvas() === stableCanvas && deleted === 0 && canvas().dataset.layerTextureCount === "2", "replacing the screen rebuilt independent layer textures");
    } finally {
      stableGl.deleteTexture = deleteTexture;
    }
    draw(false);
    await until(() => canvas()?.dataset.layerTextureCount === "1", "folding did not replace native textures with one composite");
    assert(Number(canvas().dataset.layerTextureBytes) <= 64_000_000, "texture budget exceeded");
    scene.current!.paintCamera(camera);
    const gl = canvas().getContext("webgl")!, rgba = new Uint8Array(4);
    gl.readPixels(Math.floor(canvas().width / 4), Math.floor(canvas().height * 3 / 4), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    expect([...rgba], [0, 0, 128, 128], "WebGL must preserve composite alpha, not square it");
    draw(true);
    await until(() => canvas()?.dataset.layerTextureCount === "2", "reopening did not reload independent textures");
    checks.push("pixel: WebGL native/composite reload, texture release and alpha blend");

    // Use an unrelated red screen image: style layers must not sample it.
    const nonVisualChild = imageNode("qml-pen", null); nonVisualChild.visibleToUser = false;
    qmlChild.children = [nonVisualChild];
    const drawQml = (expanded: boolean) => flushSync(() => reactRoot.render(<Layer3DPreview key="qml" ref={scene} src={parent.layerImageDataUrl!} root={qmlParent} selectedNode={null} expandedNodeIds={new Set(expanded ? [qmlParent.id, qmlChild.id] : [])} size={{ width: 20, height: 20 }} renderScale={10} origin={{ left: 50, top: 50 }} camera={camera} onSelect={() => {}} />));
    drawQml(true);
    await until(() => canvas()?.dataset.layerTextureCount === "2", "QML parents with children did not load own styles");
    assert(host.querySelector(`[data-layer-node-id="${qmlChild.id}"]`)?.getAttribute("data-layer-role") === "surface", "QML style parent incorrectly became an outline");
    scene.current!.paintCamera(camera);
    const qmlGl = canvas().getContext("webgl")!;
    qmlGl.readPixels(Math.floor(canvas().width / 4), Math.floor(canvas().height * 3 / 4), 1, 1, qmlGl.RGBA, qmlGl.UNSIGNED_BYTE, rgba);
    expect([...rgba], [0, 0, 255, 255], "expanded QML child displays its own blue, not the red screenshot");
    drawQml(false);
    await until(() => canvas()?.dataset.layerTextureCount === "1", "QML fold did not compose styles");
    scene.current!.paintCamera(camera);
    qmlGl.readPixels(Math.floor(canvas().width / 4), Math.floor(canvas().height * 3 / 4), 1, 1, qmlGl.RGBA, qmlGl.UNSIGNED_BYTE, rgba);
    expect([...rgba], [0, 0, 255, 255], "collapsed QML branch retains child's own blue");
    drawQml(true);
    await until(() => canvas()?.dataset.layerTextureCount === "2", "QML re-expansion did not restore styles");
    checks.push("pixel: QML WebGL own styles with children, collapse and re-expansion");

    const transparent = imageNode("transparent", "rgba(0,0,0,0)");
    const colored = imageNode("colored", "blue", 0, 0, 10, 20);
    transparent.layerImageDataUrl = images.get(transparent.id)!.toDataURL();
    transparent.layerImageEmpty = true;
    colored.layerImageDataUrl = images.get(colored.id)!.toDataURL();
    transparent.children = [colored];
    const transparentRoot = imageNode("transparent-root", null);
    transparentRoot.children = [transparent];
    const allEmptyRoot = { ...transparentRoot, children: [{ ...transparent, children: [{ ...colored, layerImageEmpty: true }] }] };
    const drawTransparent = (expanded: boolean, allEmpty = false) => {
      flushSync(() => reactRoot.render(<Layer3DPreview key="transparent" ref={scene} src={parent.layerImageDataUrl!} root={allEmpty ? allEmptyRoot : transparentRoot} selectedNode={null} expandedNodeIds={new Set(expanded ? [transparentRoot.id, transparent.id] : [transparentRoot.id])} size={{ width: 20, height: 20 }} renderScale={10} origin={{ left: 50, top: 50 }} camera={camera} onSelect={() => {}} />));
    };
    drawTransparent(true);
    await until(() => canvas()?.dataset.layerRenderer === "webgl" && canvas()?.dataset.layerTextureCount === "1", "transparent own image should not allocate a texture");
    assert(host.querySelector(".layer-scene")?.getAttribute("data-layer-texture-count") === "1", "transparent parent must render only an outline");
    scene.current!.paintCamera(camera);
    const canvasRect = canvas().getBoundingClientRect();
    const pickedTransparent = scene.current!.pick(canvasRect.left + 200, canvasRect.top + 100)?.id;
    assert(pickedTransparent === transparent.id, `transparent outline remains selectable: picked=${pickedTransparent}`);
    drawTransparent(false);
    await until(() => canvas()?.dataset.layerTextureCount === "1" && canvas()?.dataset.layerTextureBytes === "1600", "transparent parent must retain child's folded image");
    scene.current!.paintCamera(camera);
    const emptyGl = canvas().getContext("webgl")!;
    emptyGl.readPixels(Math.floor(canvas().width / 4), Math.floor(canvas().height * 3 / 4), 1, 1, emptyGl.RGBA, emptyGl.UNSIGNED_BYTE, rgba);
    expect([...rgba], [0, 0, 255, 255], "transparent parent must composite the visible blue child");
    drawTransparent(false, true);
    await until(() => canvas()?.dataset.layerTextureCount === "0", "an entirely empty branch needs no texture");
    assert(host.querySelector(".layer-scene")?.getAttribute("data-layer-texture-count") === "0", "empty folded branch must keep an outline");
    checks.push("pixel: transparent outline picking, no empty GPU texture, visible-child folding and fully empty folding");

    const hideParent = imageNode("hide-parent", "red"), hideChild = imageNode("hide-child", "blue", 0, 0, 10, 20);
    hideParent.layerImageDataUrl = images.get(hideParent.id)!.toDataURL();
    hideChild.layerImageDataUrl = images.get(hideChild.id)!.toDataURL();
    hideParent.children = [hideChild];
    const hideRoot = imageNode("hide-root", null); hideRoot.children = [hideParent];
    const originalTree = JSON.stringify(hideRoot);
    const drawHidden = async (hidden: string[], expanded = true, focusedNode: UiNode | null = null, focusKind: "branch" | "layer" = "layer") => {
      flushSync(() => reactRoot.render(<Layer3DPreview key="hide" ref={scene} src={parent.layerImageDataUrl!} root={hideRoot} selectedNode={hideChild} expandedNodeIds={new Set(expanded ? [hideRoot.id, hideParent.id] : [hideRoot.id])} hiddenNodeIds={new Set(hidden)} focusedNode={focusedNode} focusKind={focusKind} size={{ width: 20, height: 20 }} renderScale={10} origin={{ left: 50, top: 50 }} camera={camera} onSelect={() => {}} />));
      await until(() => canvas()?.dataset.layerRenderer === "webgl" && canvas()?.dataset.layerTextureVisibility === JSON.stringify([...hidden].sort()), "hidden-layer textures did not settle");
      scene.current!.paintCamera(camera);
    };
    await drawHidden([]);
    const pivot = host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerPivotZ;
    const childZ = host.querySelector<HTMLElement>('[data-layer-node-id="hide-child"]')!.dataset.layerZ;
    await drawHidden([hideChild.id]);
    assert(!host.querySelector('[data-layer-node-id="hide-child"]'), "hidden layer metadata still rendered");
    assert(host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerSelectionCount === "0", "hidden selection still highlighted");
    let bounds = canvas().getBoundingClientRect();
    assert(scene.current!.pick(bounds.left + 100, bounds.top + 100)?.id === hideParent.id, "picking should pass through the hidden child");
    await drawHidden([hideParent.id]);
    assert(host.querySelector<HTMLElement>('[data-layer-node-id="hide-child"]')!.dataset.layerZ === childZ, "hiding a parent moved its child");
    assert(host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerPivotZ === pivot, "hiding a layer moved the camera pivot");
    await drawHidden([hideChild.id], false);
    const hideGl = canvas().getContext("webgl")!;
    hideGl.readPixels(canvas().width / 4, canvas().height * 3 / 4, 1, 1, hideGl.RGBA, hideGl.UNSIGNED_BYTE, rgba);
    expect([...rgba], [255, 0, 0, 255], "folded hidden child must remain absent");
    await drawHidden([], false);
    hideGl.readPixels(canvas().width / 4, canvas().height * 3 / 4, 1, 1, hideGl.RGBA, hideGl.UNSIGNED_BYTE, rgba);
    expect([...rgba], [0, 0, 255, 255], "restore must invalidate the folded texture cache");
    await drawHidden([hideParent.id, hideChild.id]);
    bounds = canvas().getBoundingClientRect();
    assert(scene.current!.pick(bounds.left + 100, bounds.top + 100) === null, "all hidden planes must stop receiving picks");
    assert(canvas().dataset.layerTextureCount === "0", "hidden textures were not released");
    assert(JSON.stringify(hideRoot) === originalTree, "hiding modified the original snapshot");
    checks.push("pixel: hide/restore own planes, pass-through picking, fixed Z/pivot, folded-cache invalidation and immutable snapshot");

    const focusedPixel = () => {
      scene.current!.paintCamera(camera);
      hideGl.readPixels(Math.floor(canvas().width * .3125), Math.floor(canvas().height * .625), 1, 1, hideGl.RGBA, hideGl.UNSIGNED_BYTE, rgba);
      return [...rgba];
    };
    await drawHidden([], true, hideParent);
    await until(() => canvas().dataset.layerTextureCount === "1" && focusedPixel()[0] === 255, "focused parent did not load its own red pixels");
    expect(focusedPixel(), [255, 0, 0, 255], "expanded parent focus must not borrow its blue child's image");
    assert(host.querySelectorAll(".layer-plane").length === 1 && !host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerParentId, "focus retained another plane or root backdrop");
    await drawHidden([], true, hideChild);
    await until(() => focusedPixel()[2] === 255, "focused child did not load blue pixels");
    expect(focusedPixel(), [0, 0, 255, 255], "child focus retains only its own image");
    bounds = canvas().getBoundingClientRect();
    assert(scene.current!.pick(bounds.left + 150, bounds.top + 100)?.id === hideChild.id, "focused child is not centered/selectable");
    assert(scene.current!.pick(bounds.left + 70, bounds.top + 100) === null, "isolated parent still receives hits outside the child");
    await drawHidden([], false, hideParent);
    await until(() => host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerCompositeCount === "1" && focusedPixel()[2] === 255, "focused folded parent lost its combined picture");
    assert(host.querySelectorAll(".layer-plane").length === 1, "focused folded parent expanded into multiple planes");
    await drawHidden([hideChild.id], false, hideParent);
    expect(focusedPixel(), [255, 0, 0, 255], "focus resurrected a manually hidden child in a folded parent");
    await drawHidden([], true, hideRoot);
    await until(() => canvas().dataset.layerTextureCount === "0", "empty root focus retained child textures");
    assert(host.querySelectorAll(".layer-plane").length === 1 && scene.current!.pick(bounds.left + 150, bounds.top + 100)?.id === hideRoot.id, "root focus must be a single selectable plane");
    assert(JSON.stringify(hideRoot) === originalTree, "focus modified the captured snapshot");
    checks.push("pixel: focused leaf/root/parent, centered picking, no backdrop or child leakage, folded composites and hidden-state preservation");
    await drawHidden([], true, hideParent, "branch");
    await until(() => canvas().dataset.layerTextureCount === "2", "branch focus did not load parent and child textures");
    assert(host.querySelectorAll(".layer-plane").length === 2 && !host.querySelector('[data-layer-node-id="hide-root"]'), "branch focus retained a page backdrop or omitted descendants");
    scene.current!.paintCamera(camera);
    const branchCanvas = canvas(), branchBounds = branchCanvas.getBoundingClientRect();
    const probeX = Number(branchCanvas.dataset.layerProbeX), probeY = Number(branchCanvas.dataset.layerProbeY);
    hideGl.readPixels(Math.floor(probeX * branchCanvas.width / branchBounds.width), Math.floor(branchCanvas.height - probeY * branchCanvas.height / branchBounds.height), 1, 1, hideGl.RGBA, hideGl.UNSIGNED_BYTE, rgba);
    expect([...rgba], [0, 0, 255, 255], "branch focus draws the front child's own blue pixels");
    assert(scene.current!.pick(branchBounds.left + probeX, branchBounds.top + probeY)?.id === hideChild.id, "focused child pixels and picking disagree");
    await drawHidden([hideChild.id], true, hideParent, "branch");
    await until(() => canvas().dataset.layerTextureCount === "1" && focusedPixel()[0] === 255, "branch focus resurrected hidden child pixels");
    expect(focusedPixel(), [255, 0, 0, 255], "branch focus keeps a hidden child absent");
    await drawHidden([], false, hideParent, "branch");
    await until(() => host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerCompositeCount === "1" && focusedPixel()[2] === 255, "folded branch focus lost child pixels");
    assert(host.querySelectorAll(".layer-plane").length === 1, "folded focused branch emitted descendant planes");
    await drawHidden([], true, hideChild, "branch");
    await until(() => focusedPixel()[2] === 255, "leaf branch focus lost its own pixels");
    expect(focusedPixel(), [0, 0, 255, 255], "leaf branch focus has only its own image");
    assert(JSON.stringify(hideRoot) === originalTree, "branch focus changed the captured hierarchy");
    checks.push("pixel: branch parent/descendants without backdrop, hidden child stays absent, folded composite and leaf own pixels");
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
  return checks;
}

async function verifyLayerContentBounds() {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "680px", height: "400px", position: "relative" });
  document.body.append(host);
  const reactRoot = createRoot(host), scene = createRef<LayerSceneHandle>();
  const bitmap = document.createElement("canvas"); bitmap.width = 1080; bitmap.height = 284;
  const ctx = bitmap.getContext("2d")!;
  const root = node("content-root", 0, 0, 1080, 500);
  const back = node("content-back", 0, 80, 1080, 364);
  ctx.fillStyle = "blue"; ctx.fillRect(0, 0, 1080, 284);
  back.layerImageDataUrl = bitmap.toDataURL(); back.layerImageSize = { width: 1080, height: 284 };
  ctx.clearRect(0, 0, 1080, 284); ctx.fillStyle = "white"; ctx.fillRect(31, 131, 1018, 22);
  const bar = node("content-bar", 0, 80, 1080, 364);
  bar.layerImageDataUrl = bitmap.toDataURL(); bar.layerImageSize = back.layerImageSize;
  const below = node("content-below", 20, 420, 100, 460);
  root.children = [back, bar, below];
  const original = JSON.stringify(root);
  let selected = bar, expanded = new Set([root.id]), hidden = new Set<string>();
  const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
  const render = () => flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} src={back.layerImageDataUrl!} root={root} selectedNode={selected} expandedNodeIds={expanded} hiddenNodeIds={hidden} size={{ width: 1080, height: 500 }} renderScale={.5} origin={{ left: 60, top: 40 }} camera={camera} onSelect={() => {}} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>("canvas")!;
  // Independent projection of device coordinates, not production hit-test helpers.
  const point = (id: string, x: number, y: number, azimuth = 0, elevation = 0) => {
    const el = host.querySelector<HTMLElement>(`[data-layer-node-id="${id}"]`);
    const pivotZ = Number(host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerPivotZ);
    const z = el ? Number(el.dataset.layerZ) * .5 : pivotZ;
    const yaw = -azimuth * Math.PI / 180, pitch = -elevation * Math.PI / 180;
    const cx = (x - 540) * .5, cy = (250 - y) * .5, cz = z - pivotZ;
    const rx = Math.cos(yaw) * cx + Math.sin(yaw) * cz, rz = -Math.sin(yaw) * cx + Math.cos(yaw) * cz;
    const ry = Math.cos(pitch) * cy - Math.sin(pitch) * rz, dz = Math.sin(pitch) * cy + Math.cos(pitch) * rz;
    const bounds = canvas().getBoundingClientRect();
    return { x: bounds.left + 330 + rx * 1100 / (1100 - dz), y: bounds.top + 165 - ry * 1100 / (1100 - dz) };
  };
  const pick = (p: { x: number; y: number }) => scene.current!.pick(p.x, p.y)?.id;
  try {
    render();
    await until(() => canvas()?.dataset.layerTextureCount === "2" && canvas()?.dataset.layerTrimmedCount === "1", "transparent-margin textures did not settle");
    scene.current!.paintCamera(camera);
    const gl = canvas().getContext("webgl")!;
    const highlight = () => gl.getUniform(gl.getParameter(gl.CURRENT_PROGRAM), gl.getUniformLocation(gl.getParameter(gl.CURRENT_PROGRAM), "u_rect")!) as Float32Array;
    const box = highlight();
    near(box[0], 75.5, "highlight follows actual content X"); near(box[1], 145.5, "highlight follows actual content Y");
    near(box[2], 509, "highlight width excludes transparent margins"); near(box[3], 11, "highlight height excludes transparent margins");
    assert(pick(point(bar.id, 540, 220)) === bar.id, "painted progress bar must remain selectable");
    assert(pick(point(bar.id, 540, 100)) === back.id, "transparent progress-bar margin intercepted the layer behind it");
    const rgba = new Uint8Array(4), p = point(bar.id, 540, 220), bounds = canvas().getBoundingClientRect();
    gl.readPixels(Math.floor((p.x - bounds.left) * canvas().width / bounds.width), Math.floor(canvas().height - (p.y - bounds.top) * canvas().height / bounds.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    assert(rgba[0] > 240 && rgba[1] > 240 && rgba[2] > 240, "trimming stretched or displaced the white progress-bar pixels");
    selected = back; render();
    flushSync(() => scene.current!.hover(p.x, p.y));
    near(highlight()[2], 509, "blue hover follows content width"); near(highlight()[3], 11, "blue hover follows content height");
    flushSync(() => scene.current!.clearHover()); selected = bar; render();
    const target = point(below.id, 60, 440);
    flushSync(() => scene.current!.hover(target.x, target.y));
    assert(!host.querySelector(".layer-measurement-status"), "ordinary hover displayed progress-bar measurements");
    flushSync(() => { assert(scene.current!.toggleMeasurementPin(), "progress-bar pair did not pin"); });
    assert(host.querySelector(".layer-measurement-status")?.textContent?.includes("左 20 px，右 980 px，垂直 56 px"), "measurement must retain layout bounds, not visible-content bounds");
    flushSync(() => { scene.current!.clearPinnedMeasurement(); scene.current!.clearHover(); });
    const readPixels = CanvasRenderingContext2D.prototype.getImageData;
    let reads = 0;
    CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof readPixels>) { reads++; return readPixels.apply(this, args); };
    try {
      for (const angle of [15, 30, -20]) {
        scene.current!.paintCamera({ ...camera, azimuth: angle, elevation: 8 });
        assert(pick(point(bar.id, 540, 220, angle, 8)) === bar.id, "content picking lost perspective alignment");
        assert(pick(point(bar.id, 540, 100, angle, 8)) !== bar.id, "rotated transparent margin intercepted picking");
      }
      assert(reads === 0, "orbit rescanned image pixels instead of using cached bounds");
    } finally { CanvasRenderingContext2D.prototype.getImageData = readPixels; }
    // A folded branch has its own composite; don't reuse the parent's own bounds.
    selected = root; expanded = new Set(); hidden = new Set([back.id]); render();
    await until(() => canvas().dataset.layerTextureCount === "1" && canvas().dataset.layerTextureVisibility === JSON.stringify([back.id]), "folded content bounds did not refresh");
    scene.current!.paintCamera(camera);
    near(highlight()[2], 509, "folded image content width"); near(highlight()[3], 11, "folded image content height");
    assert(pick(point(root.id, 540, 220)) === root.id && pick(point(root.id, 540, 100)) === undefined, "folded composite still intercepts transparent margins");
    assert(JSON.stringify(root) === original, "visible-content presentation mutated layout, bitmaps or snapshot data");
    const clippedBar = { ...bar, bounds: { left: -50, top: 80, right: 1030, bottom: 364, raw: "[-50,80][1030,364]" } };
    const clippedRoot = { ...root, children: [clippedBar] };
    flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} src={back.layerImageDataUrl!} root={clippedRoot} selectedNode={clippedBar} expandedNodeIds={new Set([root.id])} size={{ width: 1080, height: 500 }} renderScale={.5} origin={{ left: 60, top: 40 }} camera={camera} onSelect={() => {}} />));
    await until(() => canvas().dataset.layerTextureCount === "1" && canvas().dataset.layerTrimmedCount === "1" && canvas().dataset.layerTextureVisibility === "[]",
      `screen-clipped content did not settle: texture=${canvas().dataset.layerTextureCount} trimmed=${canvas().dataset.layerTrimmedCount} visibility=${canvas().dataset.layerTextureVisibility}`);
    scene.current!.paintCamera(camera);
    near(highlight()[0], 60, "offscreen content must stay clipped at the screen edge");
    near(highlight()[2], 499.5, "cropped source UV must exclude only the offscreen/transparent pixels");
    const placed = { ...back, id: "verified-placement", layerCapturePlacement: {
      screen: { left: 100, top: 150, width: 80, height: 40 },
      source: { left: 20, top: 10, width: 100, height: 50 }, opacity: 0.5, hidden: false,
    } };
    const placementRoot = { ...root, children: [placed] };
    flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} src={back.layerImageDataUrl!} root={placementRoot} selectedNode={placed}
      expandedNodeIds={new Set([root.id])} size={{ width: 1080, height: 500 }} renderScale={.5}
      origin={{ left: 60, top: 40 }} camera={camera} onSelect={() => {}} />));
    await until(() => canvas().dataset.layerTextureCount === "1" && canvas().dataset.layerTrimmedCount === "0", "verified placement did not settle");
    scene.current!.paintCamera(camera);
    near(highlight()[0], 110, "verified border X matches scaled capture"); near(highlight()[1], 115, "verified border Y matches scaled capture");
    near(highlight()[2], 40, "verified border width uses capture scale"); near(highlight()[3], 20, "verified border height uses capture scale");
    assert(pick(point(placed.id, 140, 170)) === placed.id, "verified capture's painted center must be clickable");
    assert(pick(point(placed.id, 350, 170)) !== placed.id, "legacy layout outside verified capture must not intercept clicks");
    const inside = point(placed.id, 140, 170), placementCanvasBounds = canvas().getBoundingClientRect();
    await until(() => {
      scene.current!.paintCamera(camera);
      gl.readPixels(Math.floor((inside.x - placementCanvasBounds.left) * canvas().width / placementCanvasBounds.width),
        Math.floor(canvas().height - (inside.y - placementCanvasBounds.top) * canvas().height / placementCanvasBounds.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      return Math.abs(rgba[2] - 128) <= 2 && Math.abs(rgba[3] - 128) <= 2;
    }, `verified texture/alpha did not become ready (expected blue at 0.5 alpha)`);
    scene.current!.paintCamera({ ...camera, azimuth: 25, elevation: 10 });
    assert(pick(point(placed.id, 140, 170, 25, 10)) === placed.id, "verified placement picking must remain aligned during orbit");
    const hiddenPlaced = { ...placed, layerCapturePlacement: { ...placed.layerCapturePlacement, hidden: true } };
    flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} src={back.layerImageDataUrl!} root={{ ...root, children: [hiddenPlaced] }} selectedNode={hiddenPlaced}
      expandedNodeIds={new Set([root.id])} size={{ width: 1080, height: 500 }} renderScale={.5}
      origin={{ left: 60, top: 40 }} camera={camera} onSelect={() => {}} />));
    scene.current!.paintCamera(camera);
    assert(pick(point(placed.id, 140, 170)) !== placed.id, "fully clipped capture must not remain clickable");
    return ["pixel: progress-bar content/layout separation, unchanged pixels and measurements, perspective pass-through picking, cached scans, historical images and folded composites"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
}

async function verifyLayerMenu() {
  const host = document.createElement("div"); host.style.width = "680px"; document.body.append(host);
  const reactRoot = createRoot(host), previousApi = window.electronApi;
  let menu: { canHide: boolean; canRestore: boolean; canExitFocus: boolean; resolve: (choice: LayerMenuAction) => void } | null = null;
  let menuCalls = 0, selectionCalls = 0, selected: UiNode | null = null;
  const selectedId = () => selected?.id;
  let current = fixture({ width: 1080, height: 2400 });
  const render = () => flushSync(() => reactRoot.render(<ScreenshotPreview src={current.src} root={current.root} selectedNode={selected} expandedNodeIds={new Set([current.root.id])} geometry={current.geometry} onSelect={node => { selected = node; selectionCalls++; render(); }} />));
  window.electronApi = { ...previousApi, showLayerMenu: (canHide, canRestore, canExitFocus) => {
    menuCalls++;
    return new Promise<LayerMenuAction>(resolve => { menu = { canHide, canRestore, canExitFocus, resolve }; });
  } };
  const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
  const frame = () => host.querySelector<HTMLElement>(".screenshot-frame")!;
  const ready = () => until(() => canvas()?.dataset.layerRenderer === "webgl" && Boolean(canvas()?.dataset.layerProbeX), "menu scene not ready");
  const rightClick = () => {
    const c = canvas(), bounds = c.getBoundingClientRect();
    assert(c.dataset.layerProbeX && c.dataset.layerProbeY, `menu ${menuCalls}: no rendered pick target; scene=${JSON.stringify(host.querySelector<HTMLElement>(".layer-scene")?.dataset)}`);
    c.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 2, isPrimary: true, clientX: bounds.left + Number(c.dataset.layerProbeX), clientY: bounds.top + Number(c.dataset.layerProbeY) }));
  };
  try {
    render(); await ready(); await tick(); await tick();
    const original = JSON.stringify(current.root);
    // Synthetic pointers do not own OS pointer capture.
    frame().setPointerCapture = () => {};
    const bounds = canvas().getBoundingClientRect();
    const x = bounds.left + Number(canvas().dataset.layerProbeX), y = bounds.top + Number(canvas().dataset.layerProbeY);
    const pointer = (type: string, dx = 0, shiftKey = false) => flushSync(() => frame().dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 7, isPrimary: true, clientX: x + dx, clientY: y, shiftKey,
    })));
    pointer("pointermove"); await tick();
    const label = () => host.querySelector<HTMLElement>(".layer-hover-label");
    const hoveredId = label()?.dataset.nodeId;
    assert(hoveredId && label()!.querySelector("strong")?.textContent && selectedId() === undefined, `hover must identify the pointed node without selecting it: ${JSON.stringify({ hoveredId, selected: selectedId(), x, y, bounds, scene: host.querySelector(".layer-scene")?.getAttribute("data-layer-hovered-id") })}`);
    assert(label()!.querySelector("strong")?.textContent === nodeDisplayLabel(flattenNodes(current.root).get(hoveredId)!), "hover title does not share the property panel's meaningful name");
    assert(getComputedStyle(label()!).pointerEvents === "none", "hover label intercepts clicks");
    assert(getComputedStyle(canvas()).cursor === "crosshair", "idle canvas must use a precise cursor");
    const probe = canvas().dataset.layerProbeX;
    pointer("pointerdown"); pointer("pointermove", 2); await tick();
    assert(!frame().dataset.gesture && canvas().dataset.layerProbeX === probe, "click jitter rotated the scene");
    pointer("pointerup", 2);
    assert(selectedId() === hoveredId && label()?.classList.contains("is-selected"), "click must select the pressed node and identify it as selected");
    for (const shift of [false, true]) {
      pointer("pointerdown", 0, shift); pointer("pointermove", 16, shift); await tick();
      assert(frame().dataset.gesture === (shift ? "pan" : "rotate"), "gesture not classified after drag threshold");
      assert(getComputedStyle(canvas()).cursor === (shift ? "grabbing" : "move"), "drag cursor does not match the gesture");
      assert(!label() && !host.querySelector(".layer-measurement-status"), "drag retained hover/measurement labels");
      pointer("pointerup", 16, shift);
      assert(selectedId() === hoveredId && !frame().dataset.gesture, "drag changed selection or left a stuck cursor");
    }
    for (const end of ["pointercancel", "lostpointercapture", "blur"]) {
      pointer("pointerdown"); pointer("pointermove", 16);
      if (end === "blur") flushSync(() => window.dispatchEvent(new Event("blur"))); else pointer(end, 16);
      assert(!frame().dataset.gesture && !frame().classList.contains("is-3d-dragging") && !label(), `${end} did not clean up the gesture`);
    }
    pointer("pointermove"); await tick();
    frame().focus();
    flushSync(() => frame().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " ", code: "Space" })));
    await tick();
    assert(getComputedStyle(canvas()).cursor === "grab" && !label(), "Space does not indicate pan readiness or retained a hover target");
    flushSync(() => frame().dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " ", code: "Space" })));
    await tick();
    assert(getComputedStyle(canvas()).cursor === "crosshair", "releasing Space retained the pan cursor");
    for (const end of ["pointercancel", "lostpointercapture"]) {
      pointer("pointerdown"); const before = selectionCalls; pointer(end); pointer("pointerup");
      assert(selectionCalls === before && !frame().dataset.gesture, "release after cancellation selected a layer");
    }
    pointer("pointerdown"); const beforeReplacement = selectionCalls;
    current = { ...current, root: { ...current.root } }; render(); pointer("pointerup");
    assert(selectionCalls === beforeReplacement && !frame().dataset.gesture && !label(), "root replacement reused a pressed node or left a gesture active");
    rightClick(); await until(() => Boolean(menu), "right click did not request a menu");
    assert(menu!.canHide && !menu!.canRestore, "initial menu enablement wrong");
    menu!.resolve("hide"); menu = null;
    await until(() => Boolean(host.querySelector(".restore-layers")), "hide did not expose restore button");
    assert(!host.querySelector(`[data-layer-node-id="${selected!.id}"]`), "chosen layer remains visible");
    assert(JSON.stringify(current.root) === original, "menu mutated the captured hierarchy");
    // Keyboard access restores via the same native menu; the selected layer is hidden.
    frame().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "F10", shiftKey: true }));
    await until(() => Boolean(menu), "keyboard menu unavailable");
    assert(!menu!.canHide && menu!.canRestore, "hidden selection menu enablement wrong");
    menu!.resolve("restore"); menu = null;
    await until(() => !host.querySelector(".restore-layers"), "menu restore failed");
    rightClick(); await until(() => Boolean(menu), "second menu unavailable");
    menu!.resolve(null); menu = null; await tick();
    assert(!host.querySelector(".restore-layers"), "cancel hid a layer");
    const beforeDrag = menuCalls;
    for (const [type, x] of [["pointerdown", 100], ["pointermove", 140], ["pointerup", 140]] as const) {
      frame().dispatchEvent(new PointerEvent(type, { bubbles: true, button: 2, buttons: type === "pointerup" ? 0 : 2, pointerId: 7, isPrimary: true, clientX: x, clientY: 100 }));
    }
    await tick(); assert(menuCalls === beforeDrag, "right orbit drag opened a menu");
    rightClick(); await until(() => Boolean(menu), "third menu unavailable");
    menu!.resolve("hide"); menu = null;
    await until(() => Boolean(host.querySelector(".restore-layers")), "second hide failed");
    const hiddenId = selectedId();
    const sceneState = () => host.querySelector<HTMLElement>(".layer-scene")!.dataset;
    const focus = async () => {
      await ready(); await tick();
      rightClick(); await until(() => Boolean(menu), "focus menu unavailable");
      assert(menu!.canHide, "pointed layer cannot be focused");
      const id = selectedId(); menu!.resolve("focus"); menu = null;
      await until(() => sceneState().layerFocusedId === id && sceneState().layerCount === "1", "focus did not isolate exactly one layer");
      await tick(); await tick();
      return id;
    };
    const focusId = await focus();
    assert(sceneState().layerHiddenCount === "1" && !host.querySelector(`[data-layer-node-id="${hiddenId}"]`), "focus erased the existing hidden state");
    selected = current.root; render(); await tick();
    assert(sceneState().layerFocusedId === focusId && sceneState().layerCount === "1" && sceneState().layerSelectionCount === "0", "tree selection changed isolation or highlighted an outside layer");
    assert(!host.querySelector(".layer-measurement-status"), "outside nodes remained available for measurement");
    rightClick(); await until(() => Boolean(menu), "focused layer menu unavailable");
    assert(menu!.canExitFocus, "focused menu lacks an exit");
    menu!.resolve("hide"); menu = null;
    await until(() => sceneState().layerCount === "0", "hiding the focused layer left a pickable plane");
    const emptyBounds = frame().getBoundingClientRect();
    frame().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 2, isPrimary: true, clientX: emptyBounds.left + 8, clientY: emptyBounds.top + 8 }));
    await until(() => Boolean(menu), "empty focused scene cannot open exit menu");
    assert(!menu!.canHide && menu!.canExitFocus, "empty focus menu enablement wrong");
    menu!.resolve("exit-focus"); menu = null;
    await until(() => !host.querySelector(".exit-layer-focus"), "menu exit focus failed");
    assert(sceneState().layerHiddenCount === "2" && !host.querySelector(`[data-layer-node-id="${hiddenId}"]`), "exit focus restored manually hidden layers");
    flushSync(() => host.querySelector<HTMLButtonElement>(".restore-layers")!.click());
    assert(!host.querySelector(".restore-layers"), "toolbar restore failed");
    await focus();
    flushSync(() => host.querySelector<HTMLButtonElement>(".exit-layer-focus")!.click());
    assert(sceneState().layerMode === "overview", "toolbar exit focus failed");
    await focus();
    flushSync(() => frame().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    assert(sceneState().layerMode === "overview" && frame().classList.contains("layers3d-active"), "Esc must leave focus without leaving 3D");
    await focus();
    flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button")!.click());
    assert(!host.querySelector(".exit-layer-focus") && !frame().classList.contains("layers3d-active"), "2D switch retained invisible isolation state");
    flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")!.click()); await ready();
    assert(JSON.stringify(current.root) === original, "focus/exit mutated the original hierarchy");
    rightClick(); await until(() => Boolean(menu), "stale menu unavailable");
    const stale = menu!; menu = null;
    current = fixture({ width: 720, height: 1280 }); selected = null; render(); await ready();
    stale.resolve("focus"); await tick();
    assert(!host.querySelector(".exit-layer-focus") && !host.querySelector(".restore-layers"), "old menu changed a new snapshot");
    return ["pointer: precise cursor, hover identity, click jitter, rotate/pan distinction, stable selection and interrupted-gesture cleanup", "menu: right-click hide/focus, keyboard/toolbar/empty-scene exit, immutable hidden state, stable tree selection, 2D switch and stale snapshot protection"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); window.electronApi = previousApi; }
}

async function verifyLayerExpansion() {
  const host = document.createElement("div"); host.style.width = "680px"; document.body.append(host);
  const reactRoot = createRoot(host), current = fixture({ width: 1080, height: 2400 });
  let selected: UiNode = current.root;
  let expanded = new Set<string>(), expansions = 0;
  const render = () => flushSync(() => reactRoot.render(<ScreenshotPreview src={current.src} root={current.root} selectedNode={selected} expandedNodeIds={expanded} geometry={current.geometry}
    onSelect={node => { selected = node; render(); }} onExpand={node => { expansions++; expanded = new Set([...expanded, node.id]); render(); }} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
  const frame = () => host.querySelector<HTMLElement>(".screenshot-frame")!;
  const ready = () => until(() => canvas()?.dataset.layerRenderer === "webgl" && Boolean(canvas()?.dataset.layerProbeX), "double-click scene not ready");
  const point = () => {
    const c = canvas(), r = c.getBoundingClientRect();
    return { x: r.left + Number(c.dataset.layerProbeX), y: r.top + Number(c.dataset.layerProbeY) };
  };
  const pointer = (type: string, p: { x: number; y: number }, shiftKey = false) => flushSync(() => frame().dispatchEvent(new PointerEvent(type, {
    bubbles: true, isPrimary: true, pointerId: 7, button: 0, clientX: p.x, clientY: p.y, shiftKey,
  })));
  const tap = (p: { x: number; y: number }, shift = false) => { pointer("pointerdown", p, shift); pointer("pointerup", p, shift); };
  const double = () => flushSync(() => frame().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 })));
  try {
    render();
    await until(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.disabled === false, "3D mode unavailable");
    flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")!.click());
    await ready(); await tick();
    frame().setPointerCapture = () => {};
    const p = point();
    tap(p);
    assert(expansions === 0 && expanded.size === 0, "single click expanded the parent");
    tap(p); double();
    assert(Number(expansions) === 1 && expanded.has(current.root.id), "double click failed to expand the picked parent");
    await tick();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      assert(Number(canvas().dataset.layerAnimationProgress) < 1, "expansion did not animate from the parent");
      const version = Number(canvas().dataset.layerRenderVersion);
      await tick(); await tick();
      assert(Number(canvas().dataset.layerRenderVersion) > version, "expansion did not repaint the WebGL scene");
    }
    await until(() => canvas().dataset.layerAnimationProgress === "1", "expansion animation did not finish");
    assert(host.querySelector(".layer-scene")?.getAttribute("data-layer-root-composite") === "false" && host.querySelectorAll(".layer-plane").length === 4, "children did not separate after expansion");
    const leaf = point(); tap(leaf); tap(leaf); double();
    assert(selected.children.length === 0 && Number(expansions) === 1, "leaf double click expanded a node");

    expanded = new Set(); selected = current.root; render(); await tick();
    const parentPoint = point();
    tap(parentPoint); tap(parentPoint, true); double();
    assert(expanded.size === 0, "pan-click triggered expansion");
    tap(parentPoint); pointer("pointerdown", parentPoint);
    const end = { x: parentPoint.x + 16, y: parentPoint.y };
    pointer("pointermove", end); pointer("pointerup", end); double();
    assert(expanded.size === 0, "orbit drag triggered expansion");
    flushSync(() => host.querySelector<HTMLButtonElement>(".zoom-reset")!.click()); await tick();
    tap(point()); pointer("pointerdown", point()); pointer("pointercancel", point()); double();
    assert(expanded.size === 0, "cancelled gesture triggered expansion");
    tap(point()); tap({ x: frame().getBoundingClientRect().left + 2, y: frame().getBoundingClientRect().top + 2 }); double();
    assert(expanded.size === 0, "empty-space click expanded the previous parent");
    expanded = new Set([current.root.id]); render(); await tick();
    expanded = new Set(); render(); await tick();
    if (!reduced) assert(Number(canvas().dataset.layerAnimationProgress) < 1, "collapse did not continue the previous expansion with a reverse motion");
    await until(() => canvas().dataset.layerAnimationProgress === "1", "reverse collapse did not finish");
    const previousMatchMedia = window.matchMedia;
    window.matchMedia = query => query.includes("prefers-reduced-motion") ? { matches: true } as MediaQueryList : previousMatchMedia.call(window, query);
    try {
      expanded = new Set([current.root.id]); render(); await tick();
      assert(canvas().dataset.layerAnimationProgress === "1", "reduced-motion setting was ignored");
    } finally { window.matchMedia = previousMatchMedia; }
    return ["double-click: parent-only expansion, 220ms GPU expansion/collapse, reversal/reduced motion; single/leaf/pan/drag/cancel/empty clicks do not expand"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
}

async function verifyLayerMotion() {
  const host = document.createElement("div"); host.style.cssText = "position:relative;width:680px;height:600px"; document.body.append(host);
  const mounted = createRoot(host), scene = createRef<LayerSceneHandle>(), checks: string[] = [];
  const previousMatchMedia = window.matchMedia, preference = new EventTarget();
  let reduced = false;
  const media = Object.assign(preference, { media: "(prefers-reduced-motion: reduce)", onchange: null }) as unknown as MediaQueryList;
  Object.defineProperty(media, "matches", { get: () => reduced });
  window.matchMedia = query => query.includes("prefers-reduced-motion") ? media : previousMatchMedia.call(window, query);
  const reduce = (value: boolean) => { reduced = value; preference.dispatchEvent(new Event("change")); };
  const bitmap = document.createElement("canvas"); bitmap.width = bitmap.height = 120;
  bitmap.getContext("2d")!.fillStyle = "blue"; bitmap.getContext("2d")!.fillRect(0, 0, 120, 120); const blue = bitmap.toDataURL();
  bitmap.getContext("2d")!.fillStyle = "red"; bitmap.getContext("2d")!.fillRect(0, 0, 120, 120); const screen = bitmap.toDataURL();
  const root = node("motion-root", 0, 0, 120, 120), parent = node("motion-parent", 0, 0, 120, 120), child = node("motion-child", 0, 0, 120, 120);
  root.children = [parent]; parent.children = [child]; child.layerImageDataUrl = blue; child.layerImageSize = { width: 120, height: 120 };
  root.layerImageEmpty = parent.layerImageEmpty = true;
  let expanded = new Set([root.id, parent.id]), hidden = new Set<string>(), focused: UiNode | null = null, session = 1;
  const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
  const render = () => flushSync(() => mounted.render(<Layer3DPreview ref={scene} sessionKey={session} src={screen} root={root} selectedNode={child}
    expandedNodeIds={expanded} hiddenNodeIds={hidden} focusedNode={focused} size={{ width: 120, height: 120 }} renderScale={1} origin={{ left: 280, top: 240 }} camera={camera} onSelect={() => {}} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
  const settled = () => canvas()?.dataset.layerAnimationProgress === "1" && canvas()?.dataset.layerTexturePendingCount === "0" && canvas()?.dataset.layerRetiringCount === "0";
  const depths = () => new Map<string, number>(JSON.parse(canvas().dataset.layerPaintedDepths!));
  const blueProbe = () => {
    scene.current!.paintCamera(camera);
    const gl = canvas().getContext("webgl")!, rgba = new Uint8Array(4), c = canvas();
    const x = Number(c.dataset.layerProbeX), y = Number(c.dataset.layerProbeY), bounds = c.getBoundingClientRect();
    gl.readPixels(Math.round(x * c.width / bounds.width), Math.round(c.height - y * c.height / bounds.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    assert(rgba[2] > 245 && rgba[0] < 10 && rgba[3] > 245, `motion lost collected blue pixels or sampled the unrelated red screen: ${[...rgba]}`);
    return scene.current!.pick(bounds.left + x, bounds.top + y)?.id;
  };
  try {
    render(); await until(() => canvas()?.dataset.layerRenderer === "webgl" && canvas()?.dataset.layerTextureCount === "1" && settled(), "motion's independent image did not load");
    assert(blueProbe() === child.id, "initial moving child not pickable");
    const initialDepth = depths().get(child.id)!, initialGap = initialDepth - depths().get(parent.id)!;
    expanded = new Set([root.id]); render();
    assert(Number(canvas().dataset.layerAnimationProgress) < 1 && Number(canvas().dataset.layerRetiringCount) > 0, "collapse immediately discarded its child planes");
    near(depths().get(child.id)!, initialDepth, "collapse begins on the painted child depth", 2);
    await tick(); await tick();
    const shrinking = depths().get(child.id)!;
    assert(shrinking - depths().get(parent.id)! < initialGap, "child depth did not travel back to its parent");
    expanded = new Set([root.id, parent.id]); render();
    near(depths().get(child.id)!, shrinking, "reverse expansion jumped away from the current frame", 2);
    await tick(); expanded = new Set([root.id]); render();
    await until(settled, "reverse fold did not finish and release old textures");
    assert(canvas().dataset.layerTextureCount === "1" && blueProbe() === parent.id, "folded parent lost real child pixels or hit testing");
    assert(Number(canvas().dataset.layerTextureBytes) <= 64_000_000, "motion exceeded the existing texture budget");
    expanded = new Set([root.id, parent.id]); render(); await until(settled, "expansion did not settle");
    const gl = canvas().getContext("webgl")!, upload = gl.texImage2D, readPixels = CanvasRenderingContext2D.prototype.getImageData;
    let uploads = 0, scans = 0;
    gl.texImage2D = ((...args: unknown[]) => { uploads++; Reflect.apply(upload, gl, args); }) as typeof upload;
    CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof readPixels>) { scans++; return readPixels.apply(this, args); };
    try {
      for (let frame = 0; frame < 8; frame++) { scene.current!.paintCamera({ ...camera, azimuth: frame * 2 }); await tick(); }
      assert(uploads === 0 && scans === 0, "motion/camera paint decoded, uploaded or rescanned unchanged textures");
    } finally { gl.texImage2D = upload; CanvasRenderingContext2D.prototype.getImageData = readPixels; }
    expanded = new Set([root.id]); render(); await tick(); hidden = new Set([child.id]); render();
    assert(canvas().dataset.layerAnimationProgress === "1" && canvas().dataset.layerRetiringCount === "0", "hidden pixels survived the old collapse motion");
    hidden = new Set(); expanded = new Set([root.id, parent.id]); render(); await tick(); focused = parent; render();
    assert(canvas().dataset.layerAnimationProgress === "1" && canvas().dataset.layerRetiringCount === "0", "focus carried retired outside planes");
    focused = null; render(); expanded = new Set([root.id]); render(); session++; render();
    assert(canvas().dataset.layerAnimationProgress === "1" && canvas().dataset.layerRetiringCount === "0", "new snapshot session carried the previous motion");
    await until(settled, "new session did not settle");
    expanded = new Set([root.id, parent.id]); render(); await tick(); reduce(true);
    assert(canvas().dataset.layerAnimationProgress === "1" && canvas().dataset.layerRetiringCount === "0", "live reduced-motion change failed to stop the layer motion");
    expanded = new Set([root.id]); render();
    assert(canvas().dataset.layerAnimationProgress === "1" && canvas().dataset.layerRetiringCount === "0", "reduced-motion collapse still animated");
    await until(settled, "reduced-motion composite did not settle");
    assert(blueProbe() === parent.id, "reduced-motion fold blanked the parent");
    checks.push("motion: 220ms child-to-parent fold, frame-continuous reversal, real folded pixels/picking, bounded textures, zero extra camera uploads/scans and hidden/focus/session cleanup");
    checks.push("motion: live reduced-motion changes finish active layer movement and keep folded parent pixels");

    // A failed reconstruction may hold collected child pixels briefly, then
    // releases them and stops; no endless frame loop or retained GPU images.
    reduce(false); expanded = new Set([root.id, parent.id]); render(); await until(settled, "failure fixture did not expand");
    const originalBitmap = window.createImageBitmap;
    window.createImageBitmap = (() => Promise.reject(new Error("fixture composite failure"))) as typeof createImageBitmap;
    try {
      expanded = new Set([root.id]); render();
      await until(() => (host.querySelector(".layer-resource-note")?.textContent ?? "").includes("fixture composite failure"), "failed reconstruction was not reported");
      assert(Number(canvas().dataset.layerRetiringCount) > 0, "pending failed composite immediately discarded collected pixels");
      await until(() => settled() && canvas().dataset.layerTextureCount === "0", "failed composite retained old GPU pixels or kept animating");
    } finally { window.createImageBitmap = originalBitmap; }
    checks.push("motion: failed folded reconstruction has a bounded pixel fallback and releases all retired textures");

    const current = fixture({ width: 720, height: 1280 });
    const drawPreview = () => flushSync(() => mounted.render(<ScreenshotPreview src={current.src} root={current.root} selectedNode={current.root} expandedNodeIds={new Set([current.root.id])} geometry={current.geometry} onSelect={() => {}} />));
    drawPreview();
    await until(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.disabled === false, "camera reset fixture image did not load");
    flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")!.click());
    try { await until(() => canvas()?.dataset.layerRenderer === "webgl" && Boolean(canvas()?.dataset.layerProbeX), "camera reset fixture did not load"); }
    catch (error) { throw new Error(`${error}; canvas=${JSON.stringify(canvas()?.dataset)}, mode=${host.querySelector(".screenshot-frame")?.className}`); }
    const frame = () => host.querySelector<HTMLElement>(".screenshot-frame")!;
    const key = (key: string) => flushSync(() => frame().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key })));
    key("ArrowRight"); key("ArrowRight"); key("ArrowRight");
    const beforeReset = Number(frame().dataset.cameraPaintAzimuth);
    const liveGl = canvas().getContext("webgl")!, liveUpload = liveGl.texImage2D; uploads = 0;
    liveGl.texImage2D = ((...args: unknown[]) => { uploads++; Reflect.apply(liveUpload, liveGl, args); }) as typeof liveUpload;
    try {
      flushSync(() => host.querySelector<HTMLButtonElement>(".zoom-reset")!.click());
      assert(Number(frame().dataset.cameraMotionProgress) < 1 && Math.abs(Number(frame().dataset.cameraPaintAzimuth) - beforeReset) < 2, "reset jumped to its destination");
      const program = liveGl.getParameter(liveGl.CURRENT_PROGRAM) as WebGLProgram;
      const rotation = liveGl.getUniform(program, liveGl.getUniformLocation(program, "u_rotation")!) as Float32Array;
      near(rotation[0], Math.cos(-Number(frame().dataset.cameraPaintAzimuth) * Math.PI / 180), "reset's first GPU frame disagrees with the current camera", .0001);
      await tick(); await tick();
      const interruptedAzimuth = Number(frame().dataset.cameraPaintAzimuth), bounds = frame().getBoundingClientRect();
      frame().setPointerCapture = () => {};
      const pointer = (type: string, x: number) => flushSync(() => frame().dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 98, isPrimary: true, button: 0, clientX: bounds.left + x, clientY: bounds.top + 100 })));
      pointer("pointerdown", 100);
      near(Number(frame().dataset.cameraPaintAzimuth), interruptedAzimuth, "manual orbit did not start at the current reset frame", .01);
      pointer("pointermove", 120); pointer("pointerup", 120);
      const manual = Number(frame().dataset.cameraPaintAzimuth);
      await until(() => Number(frame().dataset.cameraMotionProgress) === 1, "manual orbit did not stop the reset loop");
      for (let wait = 0; wait < 16; wait++) await tick();
      near(Number(frame().dataset.cameraPaintAzimuth), manual, "old reset overwrote the manual orbit", .01);
      flushSync(() => host.querySelector<HTMLButtonElement>(".zoom-reset")!.click()); await tick(); reduce(true);
      near(Number(frame().dataset.cameraPaintAzimuth), 40, "reduced motion did not finish active camera reset", .01);
      assert(frame().dataset.cameraMotionProgress === "1" && uploads === 0, "reset/reduced motion uploaded extra textures");
    } finally { liveGl.texImage2D = liveUpload; }
    checks.push("motion: camera reset follows current orbit, manual drag interrupts and continues from its painted frame, live reduction finishes reset, zero extra texture uploads");
    reduce(false);
    flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button")!.click());
    assert(!host.querySelector(".layer-scene") && frame().dataset.modeMotion === "flat", "2D switch retained an old animated 3D scene or lacked its short reveal");
    assert(host.querySelector<HTMLImageElement>(".screenshot-stage img")!.src === current.src, "mode reveal replaced the original screen image");
    flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")!.click());
    await until(() => canvas()?.dataset.layerRenderer === "webgl", "3D mode did not return");
    assert(frame().dataset.modeMotion === "layers3d" && Number(frame().dataset.cameraPaintAzimuth) === 40, "3D switch lost its camera or short reveal");
    reduce(true); assert(!frame().dataset.modeMotion, "live reduction left a mode reveal active");
    flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button")!.click());
    assert(!frame().dataset.modeMotion, "reduced-motion mode switch animated");
    checks.push("motion: short 2D/3D reveal preserves screen source and camera, rapid switches dispose the old scene, reduced motion bypasses mode animation");
    return checks;
  } finally { flushSync(() => mounted.unmount()); host.remove(); window.matchMedia = previousMatchMedia; }
}

async function verifyLayerFraming() {
  const host = document.createElement("div");
  host.style.width = "840px";
  document.body.append(host);
  const reactRoot = createRoot(host), current = fixture({ width: 1080, height: 2400 });
  current.root.bounds = { left: 0, top: 0, right: 1080, bottom: 2400, raw: "" };
  current.root.children = Array.from({ length: 100 }, (_, i) => ({ ...node(`layer-${i}`, 0, 0, 1080, 2400), ...(i < 80 ? { attributes: { "skip-draw": "true" } } : {}) }));
  const expanded = new Set([current.root.id]);
  let selected: UiNode = current.root;
  const render = () => flushSync(() => reactRoot.render(<ScreenshotPreview src={current.src} root={current.root} selectedNode={selected} expandedNodeIds={expanded} geometry={current.geometry} onSelect={node => { selected = node; render(); }} />));
  const image = () => host.querySelector<HTMLImageElement>("img")!;
  const canvas = () => host.querySelector<HTMLCanvasElement>("canvas")!;
  const frame = () => host.querySelector<HTMLElement>(".screenshot-frame")!;
  const checkFit = () => {
    const r = canvas().getBoundingClientRect(), scale = image().getBoundingClientRect().width / 1080;
    const centerZ = Number(host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerPivotZ);
    const depth = [...host.querySelectorAll<HTMLElement>(".layer-plane")].map(p => Number(p.dataset.layerZ) * scale);
    depth.push(centerZ * 2); // Root is the rear plane; the front plane is Z = 0.
    near(Number(host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerPivotX), r.width / 2, "stack must be horizontally centered", 1);
    near(Number(host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerPivotY), r.height / 2, "stack must be vertically centered", 1);
    // Independent perspective projection of every corner, not the fit helper.
    const yaw = -40 * Math.PI / 180, pitch = -12 * Math.PI / 180;
    for (const z of depth) for (const x of [-540, 540]) for (const y of [-1200, 1200]) {
      const rx = Math.cos(yaw) * x * scale + Math.sin(yaw) * (z - centerZ);
      const rz = -Math.sin(yaw) * x * scale + Math.cos(yaw) * (z - centerZ);
      const ry = Math.cos(pitch) * y * scale - Math.sin(pitch) * rz;
      const dz = Math.sin(pitch) * y * scale + Math.cos(pitch) * rz;
      const px = r.width / 2 + rx * 1100 / (1100 - dz), py = r.height / 2 - ry * 1100 / (1100 - dz);
      assert(dz < 1100 - 31 && px >= r.width * .065 && px <= r.width * .935 && py >= r.height * .065 && py <= r.height * .935, `3D stack clipped at ${r.width}x${r.height}: ${px},${py}`);
    }
  };
  try {
    render();
    Object.assign(frame().style, { position: "relative", height: "480px", maxHeight: "none" });
    await until(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.disabled === false, "3D mode unavailable for framing");
    flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")!.click());
    await until(() => canvas()?.dataset.layerRenderer === "webgl", "framing scene not ready");
    await tick(); await tick();
    for (const width of [840, 360]) {
      host.style.width = `${width}px`; await tick(); await tick(); await tick(); checkFit();
      const before = image().getBoundingClientRect().width;
      selected = current.root.children[2]; render(); await tick();
      near(image().getBoundingClientRect().width, before, "selection must not change framing");
      const frameElement = frame(); frameElement.focus();
      flushSync(() => frameElement.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })));
      near(image().getBoundingClientRect().width, before, "orbit must not auto-fit after every move");
      flushSync(() => host.querySelector<HTMLButtonElement>(".zoom-fit")!.click()); await tick(); checkFit();
      flushSync(() => host.querySelector<HTMLButtonElement>('[aria-label="放大截图"]')!.click()); await tick();
      near(image().getBoundingClientRect().width, before * 1.25, "manual zoom survives auto framing", 1);
      flushSync(() => host.querySelector<HTMLButtonElement>(".zoom-fit")!.click()); await tick();
    }
    assert(host.querySelectorAll(".layer-plane").length === 100, "framing must not remove any nodes");
    return ["3D framing: full deep stack at wide/narrow sizes, centered pivot, stable selection/orbit and manual zoom"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
}

async function verifyLayerMeasurements() {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "680px", height: "460px", position: "relative" });
  document.body.append(host);
  const reactRoot = createRoot(host), scene = createRef<LayerSceneHandle>();
  const current = fixture({ width: 400, height: 320 });
  const a = node("a", 20, 40, 180, 120), b = node("b", 220, 150, 380, 250), child = node("b/child", 240, 170, 320, 210);
  a.layerImageDataUrl = current.src; a.layerImageSize = current.geometry.screenshotSize;
  b.children = [child]; current.root.children = [a, b];
  let selected: UiNode | null = a, hidden = new Set<string>(), expanded = new Set([current.root.id, b.id]), scale = 1;
  let sessionKey: number | undefined, focused: UiNode | null = null;
  let camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
  let selections = 0;
  const render = () => flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} sessionKey={sessionKey} src={current.src} root={current.root} selectedNode={selected} expandedNodeIds={expanded} hiddenNodeIds={hidden} focusedNode={focused} focusKind="branch" size={{ width: 400, height: 320 }} renderScale={scale} origin={{ left: 100, top: 40 }} camera={camera} onSelect={() => { selections++; }} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>("canvas")!;
  const measurementStatus = () => host.querySelector<HTMLElement>(".layer-measurement-status");
  const hover = (id: string) => {
    const rect = canvas().getBoundingClientRect();
    for (let y = 12; y < rect.height; y += 8) for (let x = 12; x < rect.width; x += 8) {
      if (scene.current!.pick(rect.left + x, rect.top + y)?.id === id) {
        flushSync(() => scene.current!.hover(rect.left + x, rect.top + y));
        return;
      }
    }
    throw new Error(`measurement target ${id} not pickable`);
  };
  try {
    render(); await until(() => canvas()?.dataset.layerRenderer === "webgl" && canvas()?.dataset.layerTextureCount === "1", "measurement scene did not load");
    const textureBytes = canvas().dataset.layerTextureBytes;
    hover(b.id);
    assert(!measurementStatus(), "ordinary hover displayed automatic measurements");
    assert(host.querySelector<HTMLElement>(".layer-hover-label")?.dataset.nodeId === b.id, "suppressing automatic measurements removed hover identity");
    assert(selections === 0, "hover unexpectedly changed selection/properties");
    const originalTree = JSON.stringify(current.root), glUploads = canvas().getContext("webgl")!;
    const upload = glUploads.texImage2D; let uploads = 0;
    glUploads.texImage2D = ((...args: unknown[]) => { uploads++; Reflect.apply(upload, glUploads, args); }) as WebGLRenderingContext["texImage2D"];
    try {
      flushSync(() => { assert(scene.current!.toggleMeasurementPin(), "valid pair did not pin"); });
      assert(measurementStatus()?.dataset.measureAnchor === a.id && measurementStatus()?.dataset.measureTarget === b.id, "explicit measurement did not preserve the pair");
      assert(host.querySelector(".layer-measurement-status")?.textContent?.includes("水平 40 px，垂直 30 px"), "measurement must use device bounds, not scene pixels");
      flushSync(() => scene.current!.clearHover());
      assert(measurementStatus()?.dataset.measurePinned === "true" && measurementStatus()?.dataset.measureTarget === b.id, "pointer leave cleared the pinned pair");
      hover(child.id); selected = child; render();
      assert(measurementStatus()?.dataset.measureAnchor === a.id && measurementStatus()?.dataset.measureTarget === b.id, "selection/third hover changed the pinned endpoints");
      scene.current!.paintCamera({ ...camera, azimuth: 40, elevation: 18, panX: 20, panY: -10 });
      assert(measurementStatus()?.dataset.measureAnchor === a.id && measurementStatus()?.dataset.measureTarget === b.id
        && !host.querySelector(".layer-measurement, .measure-anchor, .measure-target"), "orbit changed the fixed pair or restored canvas measurement guides");
      camera = { ...camera, azimuth: 25, layerGap: 128 }; scale = .7; render();
      assert(host.querySelector(".layer-measurement-status")?.textContent?.includes("水平 40 px，垂直 30 px"), "pinned measurements changed with zoom/layer gap");
      assert(uploads === 0 && canvas().dataset.layerTextureBytes === textureBytes && JSON.stringify(current.root) === originalTree, "pin/camera/selection rebuilt textures or mutated the captured tree");
      flushSync(() => { assert(scene.current!.clearPinnedMeasurement(), "pinned pair did not release"); });
      assert(!measurementStatus() && !scene.current!.clearPinnedMeasurement(), "release retained the pinned pair");
    } finally { glUploads.texImage2D = upload; }
    camera = { ...camera, azimuth: 0, layerGap: 64 }; scale = 1; selected = a; render();
    hover(b.id); flushSync(() => scene.current!.clearHover());
    flushSync(() => { assert(scene.current!.toggleMeasurementPin(), "leaving for the toolbar lost the last valid pair"); });
    hidden = new Set([b.id]); render(); flushSync(() => scene.current!.clearHover());
    assert(!measurementStatus() && !scene.current!.toggleMeasurementPin(), "hidden target remained pinnable");
    hidden = new Set(); render(); assert(!measurementStatus(), "unhiding restored an obsolete pin");
    hover(b.id); flushSync(() => scene.current!.toggleMeasurementPin()); hidden = new Set([a.id]); render();
    assert(!measurementStatus(), "hidden anchor retained the pin"); hidden = new Set(); render();
    hover(child.id); flushSync(() => scene.current!.toggleMeasurementPin()); expanded = new Set([current.root.id]); render();
    assert(!measurementStatus(), "folded descendant retained the pin"); expanded = new Set([current.root.id, b.id]); render();
    hover(b.id); flushSync(() => scene.current!.toggleMeasurementPin()); focused = a; render();
    assert(!measurementStatus(), "branch focus retained an excluded endpoint"); focused = null; render();
    hover(b.id); flushSync(() => scene.current!.toggleMeasurementPin()); selected = null; render();
    assert(measurementStatus()?.dataset.measurePinned === "true", "clearing selection released a valid fixed pair");
    flushSync(() => { scene.current!.clearHover(); scene.current!.clearPinnedMeasurement(); });
    assert(!scene.current!.toggleMeasurementPin(), "no selected anchor reused an invalid recent pair"); selected = a; render();
    sessionKey = 1; render(); hover(b.id); flushSync(() => scene.current!.toggleMeasurementPin());
    current.root = { ...current.root, children: current.root.children.map(value => ({ ...value, attributes: { ...value.attributes, "image-capture-source": "test-refresh" } })) }; render();
    assert(measurementStatus()?.dataset.measurePinned === "true", "image-only refresh in the same capture cleared the pin");
    const oldBounds = b.bounds!;
    current.root = { ...current.root, children: current.root.children.map(value => value.id === b.id ? { ...value, bounds: { ...oldBounds, left: oldBounds.left + 1 } } : value) }; render();
    assert(measurementStatus()?.dataset.measurePinned !== "true", "changed source bounds retained old pinned numbers");
    current.root = { ...current.root, children: [a, b] }; render(); hover(b.id); flushSync(() => scene.current!.toggleMeasurementPin());
    current.root = { ...current.root, children: [a, { ...b, attributes: { ...b.attributes, "view-ref": "replaced-view" } }] }; render();
    assert(measurementStatus()?.dataset.measurePinned !== "true", "a reused ID for another View retained the pin");
    current.root = { ...current.root, children: [a, b] }; render(); hover(b.id); flushSync(() => scene.current!.toggleMeasurementPin());
    sessionKey++; render();
    assert(measurementStatus()?.dataset.measurePinned !== "true", "new capture with the same image retained the pin");
    hover(b.id); flushSync(() => scene.current!.toggleMeasurementPin()); const previousSrc = current.src; current.src = fixture({ width: 401, height: 320 }).src; render();
    assert(measurementStatus()?.dataset.measurePinned !== "true", "changed screenshot retained a stale pin"); current.src = previousSrc; sessionKey = undefined; render();
    await until(() => canvas().dataset.layerTextureBytes === textureBytes, "restored measurement fixture did not reload its original texture");
    hover(b.id);
    flushSync(() => scene.current!.toggleMeasurementPin());
    scene.current!.paintCamera({ ...camera, azimuth: 40, elevation: 18, panX: 20, panY: -10 });
    assert(host.querySelector(".layer-measurement-status")?.textContent?.includes("水平 40 px，垂直 30 px"), "orbit changed measured distance");
    camera = { ...camera, azimuth: 25, layerGap: 128 }; scale = 0.7; render();
    assert(host.querySelector(".layer-measurement-status")?.textContent?.includes("水平 40 px，垂直 30 px"), "zoom/exploded layer spacing changed measured distance");
    assert(canvas().dataset.layerTextureBytes === textureBytes, `measurement changed texture allocation: ${canvas().dataset.layerTextureBytes} != ${textureBytes}`);
    hidden = new Set([child.id]); render();
    const gl = canvas().getContext("webgl")!, program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    const pivot = gl.getUniform(program, gl.getUniformLocation(program, "u_pivot")!) as Float32Array;
    near(pivot[0], 100 + 200 * scale, "scaled pivot X");
    near(pivot[1], 40 + 160 * scale, "scaled pivot Y");
    near(pivot[2], -128 * scale, "Z pivot must scale with X/Y, even when hiding a layer");
    near(gl.getUniform(program, gl.getUniformLocation(program, "u_depth")!), -128 * scale, "rendered plane Z must scale with X/Y");
    hover(b.id);
    hidden = new Set(); render();
    flushSync(() => scene.current!.clearPinnedMeasurement());
    hover(child.id);
    assert(!measurementStatus(), "hovering a new candidate restored automatic measurements");
    flushSync(() => scene.current!.toggleMeasurementPin());
    assert(measurementStatus()?.dataset.measureTarget === child.id, "explicitly measuring the third layer did not update the target");
    flushSync(() => scene.current!.clearPinnedMeasurement());
    selected = b; camera = { ...camera, azimuth: 0 }; scale = 1; render(); hover(child.id);
    flushSync(() => scene.current!.toggleMeasurementPin());
    assert(measurementStatus()?.dataset.measureRelation === "contains", "containment measurement lost its relation");
    assert(host.querySelector(".layer-measurement-status")?.textContent?.includes("左 20 px，右 60 px，上 20 px，下 40 px"), "incorrect containment insets");
    for (const width of [680, 280]) {
      host.style.width = `${width}px`; await tick(); scene.current!.paintCamera(camera);
      const viewport = canvas().getBoundingClientRect();
      assert(!host.querySelector(".layer-measurement, .measure-anchor, .measure-target"), "measurement labels, lines or points cluttered the canvas");
      const label = host.querySelector<HTMLElement>(".layer-hover-label")!.getBoundingClientRect();
      assert(label.left >= viewport.left && label.right <= viewport.right && label.top >= viewport.top && label.bottom <= viewport.bottom, "hover identity label outside viewport");
    }
    host.style.width = "680px"; await tick(); scene.current!.paintCamera(camera);
    flushSync(() => scene.current!.clearPinnedMeasurement());
    selected = child; render();
    assert(!measurementStatus() && !scene.current!.toggleMeasurementPin(), "selected layer must not measure itself");
    hover(b.id);
    flushSync(() => scene.current!.toggleMeasurementPin());
    assert(measurementStatus()?.dataset.measureRelation === "inside", "new anchor should reverse containment");
    hidden = new Set([b.id]); render();
    assert(!measurementStatus(), "hidden target retained stale measurements");
    hidden = new Set(); selected = a; render(); hover(child.id);
    flushSync(() => scene.current!.toggleMeasurementPin());
    expanded = new Set([current.root.id]); render();
    assert(!measurementStatus(), "collapsed descendant retained stale measurements");
    hover(b.id);
    flushSync(() => scene.current!.toggleMeasurementPin());
    hidden = new Set([a.id]); render();
    assert(!measurementStatus(), "hidden anchor retained stale measurements");
    hidden = new Set(); render(); hover(b.id);
    flushSync(() => scene.current!.hover(-1000, -1000));
    assert(!measurementStatus(), "blank space retained measurements");
    hover(b.id); flushSync(() => scene.current!.clearHover());
    assert(!measurementStatus(), "pointer leave retained measurements");
    assert(!host.querySelector(".layer-hover-label"), "pointer leave retained hover identity");
    hover(b.id);
    flushSync(() => scene.current!.toggleMeasurementPin());
    current.root = { ...current.root }; render(); await tick();
    assert(!measurementStatus(), "new snapshot reused the old hover target");
    return ["measurement: hover identity without automatic guides/status; explicit source-pixel gaps/insets, camera/zoom/gap invariance, narrow labels and stale-state cleanup", "pinned measurement: fixed endpoints across hover/selection/orbit/zoom, toolbar travel, zero texture uploads; hidden/folded/focus/replaced View/bounds/source/session invalidate permanently"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
}

async function verifyPinnedMeasurementControls() {
  const previousAppearance = localStorage.getItem(LAYER_APPEARANCE_STORAGE_KEY);
  const host = document.createElement("div"), toolbar = document.createElement("div");
  Object.assign(host.style, { width: "680px", position: "relative" }); document.body.append(toolbar, host);
  const mounted = createRoot(host), current = fixture({ width: 400, height: 320 });
  const a = node("pin-a", 20, 40, 180, 120), b = node("pin-b", 220, 150, 380, 250), c = node("pin-c", 300, 270, 340, 290);
  for (const [value, color] of [[a, "#407d64"], [b, "#486caa"]] as const) {
    const raster = document.createElement("canvas"); raster.width = 160; raster.height = value.bounds!.bottom - value.bounds!.top;
    const context = raster.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, raster.width, raster.height);
    value.layerImageStatus = "captured"; value.layerImageDataUrl = raster.toDataURL("image/png");
    value.layerImageSize = { width: raster.width, height: raster.height };
  }
  current.root.children = [a, b];
  let selected: UiNode | null = a, sessionKey = 1, hoverCalls = 0;
  let navigationDisabled = false;
  const render = () => flushSync(() => mounted.render(<ScreenshotPreview sessionKey={sessionKey} src={current.src} root={current.root} selectedNode={selected} expandedNodeIds={new Set([current.root.id])} geometry={current.geometry} toolbarHost={toolbar} navigationDisabled={navigationDisabled} onSelect={value => { selected = value; render(); }} />));
  const frame = () => host.querySelector<HTMLElement>(".screenshot-frame")!;
  const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
  const measurementStatus = () => host.querySelector<HTMLElement>(".layer-measurement-status");
  const button = () => toolbar.querySelector<HTMLButtonElement>(".pin-layer-measurement")!;
  const ready = async () => {
    await until(() => toolbar.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.disabled === false, "pinned controls 3D button did not enable");
    if (!canvas()) flushSync(() => toolbar.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")!.click());
    await until(() => canvas()?.dataset.layerRenderer === "webgl" && Boolean(canvas()?.dataset.layerProbeX), "pinned controls scene did not load");
    await tick(); await tick();
  };
  const key = async (target: EventTarget, value: string, extra: KeyboardEventInit = {}) => {
    flushSync(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra }))); await tick();
  };
  const pointer = (type: string, x: number, y: number) => flushSync(() => frame().dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 9, button: 0, buttons: type === "pointermove" && frame().dataset.gesture ? 1 : 0, clientX: x, clientY: y })));
  const hover = async () => {
    hoverCalls++;
    const rect = canvas().getBoundingClientRect();
    const p = { x: rect.left + Number(canvas().dataset.layerProbeX), y: rect.top + Number(canvas().dataset.layerProbeY) };
    pointer("pointermove", p.x, p.y);
    await tick();
    const target = host.querySelector<HTMLElement>(".layer-hover-label")?.dataset.nodeId;
    assert(target === a.id || target === b.id, `controls probe did not hit a measurable node: ${JSON.stringify({ hoverCalls, target, p, canvas: canvas().getBoundingClientRect().toJSON(), scene: host.querySelector<HTMLElement>(".layer-scene")?.dataset, dataset: canvas().dataset, frame: frame().dataset })}`);
    selected = target === a.id ? b : a; render();
    assert(!measurementStatus() && !button().disabled, "valid hover must only enable explicit measurement, without automatic guides/status");
    return p;
  };
  const leave = async () => { flushSync(() => frame().dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: toolbar }))); await tick(); };
  try {
    render(); await ready(); await tick();
    assert(!button().disabled && button().getAttribute("aria-pressed") === "false", "measurement entry requires a hidden hover pair");
    await hover(); await leave();
    assert(!measurementStatus() && !button().disabled, "pointer travel to the toolbar lost the candidate");
    flushSync(() => button().click());
    await tick();
    const picker = host.querySelector<HTMLElement>(".measurement-card")!;
    assert(picker?.dataset.measurementMode === "live" && picker.dataset.measurementAnchor === selected!.id
      && !picker.dataset.measurementTarget && picker.textContent?.includes("悬停另一控件") && !measurementStatus(), "entry did not start selected/hovered measurement or reused a stale pair");
    await tick(); await hover(); await tick();
    assert(picker.dataset.measurementTarget && !picker.dataset.measurementPicking && !measurementStatus(), "live hover required a click or pinned the pair implicitly");
    await until(() => picker.querySelectorAll("image[data-measurement-image]").length === 2, "saved measurement pictures did not load");
    assert(picker.querySelectorAll('[data-measurement-axis="horizontal"]').length === 1
      && picker.querySelectorAll('[data-measurement-axis="vertical"]').length === 1, "result panel did not draw independent axis dimensions");
    await leave();
    flushSync(() => picker.querySelector<HTMLButtonElement>(".measurement-pin")!.click());
    await tick(); await tick();
    assert(measurementStatus()?.dataset.measurePinned === "true" && button().getAttribute("aria-pressed") === "true" && host.querySelector(".screenshot-pinned-measurement")?.textContent?.includes("40 px"), `toolbar failed to fix and describe the pair: ${JSON.stringify({ overlay: measurementStatus()?.dataset, pressed: button().getAttribute("aria-pressed"), summary: host.querySelector(".screenshot-pinned-measurement")?.textContent })}`);
    const endpoints = `${measurementStatus()!.dataset.measureAnchor}/${measurementStatus()!.dataset.measureTarget}`;
    const card = () => host.querySelector<HTMLElement>(".measurement-card");
    const checkCard = () => {
      const element = card(); assert(element, "valid fixed measurement did not show a 2D card");
      assert(`${element.dataset.measurementAnchor}/${element.dataset.measurementTarget}` === endpoints, "2D card changed the fixed endpoints");
      assert(element.querySelector(".measurement-card-values")?.textContent?.replace(/\s/g, "") === "水平40px垂直30px", "2D card changed the original pixel distances");
      assert(!host.querySelector(".layer-measurement, .measure-anchor, .measure-target"), "measurement card restored canvas labels, lines or points");
      const bounds = element.getBoundingClientRect(), viewport = frame().getBoundingClientRect();
      const left = viewport.left + frame().clientLeft, top = viewport.top + frame().clientTop;
      assert(bounds.left >= left - 1 && bounds.top >= top - 1 && bounds.right <= left + frame().clientWidth + 1
        && bounds.bottom <= top + frame().clientHeight + 1 && bounds.bottom <= viewport.bottom + 1
        && bounds.right <= viewport.right + 1 && element.scrollWidth <= element.clientWidth + 1, "2D card leaves or overflows available viewport");
    };
    checkCard();
    const cameraBeforeCard = `${frame().dataset.cameraPaintAzimuth}/${frame().dataset.cameraPaintElevation}/${toolbar.querySelector(".zoom-readout")?.textContent}`;
    flushSync(() => {
      for (const type of ["pointerdown", "pointermove", "pointerup"]) card()!.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 81, button: 0, clientX: 24, clientY: 24 }));
    }); await tick();
    assert(!frame().dataset.gesture && `${frame().dataset.cameraPaintAzimuth}/${frame().dataset.cameraPaintElevation}/${toolbar.querySelector(".zoom-readout")?.textContent}` === cameraBeforeCard && measurementStatus()?.dataset.measurePinned === "true", "2D card pointer input changed the scene");
    for (const [target, deltaY, ctrlKey] of [[card()!, 120, false], [card()!.querySelector("svg rect")!, -120, false], [card()!.querySelector("svg path")!, 12, true]] as const) {
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, ctrlKey });
      flushSync(() => target.dispatchEvent(wheel));
      await tick(); await tick(); await tick();
      assert(!wheel.defaultPrevented && `${frame().dataset.cameraPaintAzimuth}/${frame().dataset.cameraPaintElevation}/${toolbar.querySelector(".zoom-readout")?.textContent}` === cameraBeforeCard
        && measurementStatus()?.dataset.measurePinned === "true", "2D card wheel input zoomed the scene or blocked card scrolling");
    }
    host.style.width = "248px"; await tick(); await tick(); checkCard();
    host.style.width = "680px"; await tick(); await tick();
    const rect = canvas().getBoundingClientRect(), p = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    frame().setPointerCapture = () => {};
    pointer("pointerdown", p.x, p.y); pointer("pointermove", p.x + 24, p.y + 12); await tick();
    assert(measurementStatus()?.dataset.measurePinned === "true" && `${measurementStatus()!.dataset.measureAnchor}/${measurementStatus()!.dataset.measureTarget}` === endpoints, "drag changed the fixed measurement pair");
    checkCard();
    pointer("pointerup", p.x + 24, p.y + 12); await leave();
    flushSync(() => toolbar.querySelector<HTMLButtonElement>('[aria-label="放大截图"]')!.click());
    await tick();
    assert(`${measurementStatus()!.dataset.measureAnchor}/${measurementStatus()!.dataset.measureTarget}` === endpoints && card()?.querySelector(".measurement-card-values")?.textContent?.replace(/\s/g, "") === "水平40px垂直30px", "toolbar zoom changed the fixed pair or source distances");
    const viewBeforeMode = { pan: host.querySelector<HTMLElement>(".screenshot-stage")!.style.getPropertyValue("--layer-live-pan"), zoom: toolbar.querySelector(".zoom-readout")?.textContent, selected: selected!.id };
    for (const mode of ["horizontal", "free"]) {
      const settings = toolbar.querySelector<HTMLDetailsElement>(".layer-settings")!, rotation = settings.querySelector<HTMLSelectElement>('[aria-label="3D 旋转模式"]')!;
      settings.open = true;
      flushSync(() => { rotation.value = mode; rotation.dispatchEvent(new Event("change", { bubbles: true })); });
      settings.open = false; await tick();
      assert(measurementStatus()?.dataset.measurePinned === "true" && `${measurementStatus()!.dataset.measureAnchor}/${measurementStatus()!.dataset.measureTarget}` === endpoints
        && card()?.querySelector(".measurement-card-values")?.textContent?.replace(/\s/g, "") === "水平40px垂直30px" && button().getAttribute("aria-pressed") === "true", "rotation mode changed the fixed pair or source distances");
      assert(host.querySelector<HTMLElement>(".screenshot-stage")!.style.getPropertyValue("--layer-live-pan") === viewBeforeMode.pan
        && toolbar.querySelector(".zoom-readout")?.textContent === viewBeforeMode.zoom && selected!.id === viewBeforeMode.selected, "rotation mode reset the pinned view's pan, zoom or selection");
      checkCard();
    }
    const originalAnchor = [a, b].find(node => node.id === measurementStatus()!.dataset.measureAnchor)!;
    const originalTarget = [a, b].find(node => node.id === measurementStatus()!.dataset.measureTarget)!;
    current.root = { ...current.root, children: [a, b, c] };
    selected = c; render(); await tick();
    assert(`${measurementStatus()!.dataset.measureAnchor}/${measurementStatus()!.dataset.measureTarget}` === endpoints, "ordinary selection changed a fixed pair");
    flushSync(() => card()!.querySelector<HTMLButtonElement>('[data-measurement-pick="target"]')!.click()); await tick();
    assert(card()!.dataset.measurementPicking === "target" && !measurementStatus() && !card()!.querySelector<HTMLButtonElement>(".measurement-use-selected")!.disabled,
      "reselect B did not retain A or offer the current selection");
    flushSync(() => card()!.querySelector<HTMLButtonElement>(".measurement-use-selected")!.click()); await tick();
    assert(measurementStatus()?.dataset.measureAnchor === originalAnchor.id && measurementStatus()?.dataset.measureTarget === c.id, "explicit current selection did not replace only B");
    flushSync(() => card()!.querySelector<HTMLButtonElement>('[data-measurement-pick="anchor"]')!.click()); await tick();
    assert(card()!.dataset.measurementPicking === "anchor" && card()!.querySelector<HTMLButtonElement>(".measurement-use-selected")!.disabled,
      "reselect A did not prevent the same node as B");
    selected = originalTarget; render(); await tick();
    assert(measurementStatus()?.dataset.measureAnchor === originalTarget.id && measurementStatus()?.dataset.measureTarget === c.id, "tree selection did not replace only A");
    flushSync(() => card()!.querySelector<HTMLButtonElement>('[data-measurement-pick="anchor"]')!.click());
    selected = originalAnchor; render(); await tick();
    flushSync(() => card()!.querySelector<HTMLButtonElement>('[data-measurement-pick="target"]')!.click());
    selected = originalTarget; render(); await tick(); checkCard();
    current.root = { ...current.root, children: [a, b] }; render(); await tick();
    navigationDisabled = true; render(); await tick();
    assert(measurementStatus()?.dataset.measurePinned === "true" && button().disabled
      && card()!.querySelector<HTMLButtonElement>('[data-measurement-pick="anchor"]')!.disabled, "busy guard lost an existing measurement or permits reselecting");
    navigationDisabled = false; render(); await tick(); checkCard();
    const input = document.createElement("input"); frame().append(input); await key(input, "m"); await key(input, "Escape"); input.remove();
    assert(measurementStatus()?.dataset.measurePinned === "true", "editing shortcuts released the fixed pair");
    await key(frame(), "m", { repeat: true }); await key(frame(), "m", { ctrlKey: true }); await key(frame(), "m", { shiftKey: true });
    assert(measurementStatus()?.dataset.measurePinned === "true", "repeat/modified M toggled the fixed pair");
    await key(window, "Escape");
    assert(!measurementStatus() && !card() && canvas() && button().getAttribute("aria-pressed") === "false", "first Escape did not release before leaving 3D");
    await hover(); frame().focus(); await key(frame(), "m");
    assert(measurementStatus()?.dataset.measurePinned === "true", "canvas M did not show explicit measurements");
    await key(frame(), "m");
    assert(!measurementStatus() && host.querySelector(".layer-hover-label"), "unpinning while still hovering retained automatic measurements or lost hover identity");
    await key(frame(), "m"); await leave();
    assert(measurementStatus()?.dataset.measurePinned === "true", "canvas M did not pin the pair");
    await key(button(), "m");
    assert(!measurementStatus() && canvas(), "M in the portaled toolbar did not release the pair");
    await hover(); await key(frame(), "m"); await leave(); checkCard();
    await key(card()!.querySelector("button")!, "m");
    assert(!card() && !measurementStatus() && canvas(), "M in the measurement card did not release the pair");
    await hover(); await key(frame(), "m"); await leave();
    const beforeModeSwitch = card()!.textContent;
    flushSync(() => [...toolbar.querySelectorAll<HTMLButtonElement>(".view-mode-toggle button")].find(value => value.textContent === "2D")!.click());
    await tick();
    assert(card()?.textContent === beforeModeSwitch && card()?.dataset.measurementMode === "fixed", "2D switch changed the pinned endpoints or source-pixel values");
    flushSync(() => [...toolbar.querySelectorAll<HTMLButtonElement>(".view-mode-toggle button")].find(value => value.textContent === "3D 层级")!.click()); await ready();
    assert(card()?.textContent === beforeModeSwitch && measurementStatus()?.dataset.measurePinned === "true", "2D/3D switch changed a valid pinned pair");
    await key(frame(), "m");
    assert(!measurementStatus() && !card(), "shared pair did not release after switching views");
    await hover(); await key(frame(), "m"); await leave(); sessionKey++; render(); await ready();
    assert(!measurementStatus() && !card() && !button().disabled && !host.querySelector(".screenshot-pinned-measurement"), "new session with the same PNG restored a pinned pair");
    flushSync(() => button().click()); await tick();
    assert(card()?.dataset.measurementMode === "live", "a fresh session could not start hover measurement");
    await key(window, "Escape");
    assert(!card() && canvas() && document.activeElement !== document.body, "Escape during picking did not cancel before exiting 3D");
    selected = null; render(); await tick();
    flushSync(() => button().click()); await tick();
    await until(() => card()?.dataset.measurementMode === "live", "measurement without selection did not open the tutorial");
    assert(!card()?.dataset.measurementAnchor && !card()?.dataset.measurementTarget, "measurement without selection retained old endpoints");
    flushSync(() => card()!.querySelector<HTMLButtonElement>('[data-measurement-pick="anchor"]')!.click()); await tick();
    assert(card()?.dataset.measurementPicking === "anchor", "explicit A selection did not start the picker");
    selected = a; render(); await tick(); await tick();
    assert(card()?.dataset.measurementPicking === "target" && card()?.dataset.measurementAnchor === a.id && !measurementStatus(), "choosing A did not advance to B");
    selected = b; render(); await tick(); await tick();
    assert(measurementStatus()?.dataset.measureAnchor === a.id && measurementStatus()?.dataset.measureTarget === b.id, "choosing B after A did not complete measurement");
    await key(window, "Escape");
    await key(frame(), "Alt");
    assert(card()?.dataset.measurementMode === "temporary", "Option did not start temporary measurement");
    await hover(); await leave();
    assert(card()?.dataset.measurementTarget && !measurementStatus(), "temporary hover did not update the result");
    flushSync(() => frame().dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }))); await tick();
    assert(!card() && !measurementStatus() && canvas(), "releasing Option retained temporary measurement or exited 3D");
    await key(frame(), "Alt");
    flushSync(() => window.dispatchEvent(new Event("blur"))); await tick();
    assert(!card(), "window blur retained temporary measurement");
    await key(frame(), "Alt");
    flushSync(() => card()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); await tick();
    flushSync(() => frame().dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }))); await tick();
    assert(card()?.dataset.measurementMode === "live", "keeping measurement did not survive Option release");
    await key(window, "Escape");
    flushSync(() => button().click()); await tick();
    flushSync(() => card()!.querySelector<HTMLButtonElement>('[data-measurement-pick="target"]')!.click()); await tick();
    navigationDisabled = true; render(); await tick(); await tick();
    assert(!card() && !measurementStatus() && button().disabled && canvas(), "busy guard retained a partial pair or left 3D");
    navigationDisabled = false; render(); await tick();
    flushSync(() => button().click()); await tick();
    sessionKey++; render(); await ready();
    assert(!card() && !measurementStatus() && button().getAttribute("aria-pressed") === "false", "new capture retained a partial measurement pair");
    await key(window, "Escape"); assert(!canvas(), "Escape without a pin no longer exits 3D");
    return ["ScreenshotPreview: selected/hovered live measurement, saved A/B images and axis dimensions; explicit A/B reselect and same-node guard", "ScreenshotPreview: Option release/blur and persistent mode, M/Esc precedence, input/repeat guards, stable fixed pair through drag/zoom; 2D/new capture clears state", "measurement panel: original pixel distances, narrow viewport containment, scene input isolation and zero canvas measurement guides"];
  } finally {
    flushSync(() => mounted.unmount()); host.remove(); toolbar.remove();
    if (previousAppearance === null) localStorage.removeItem(LAYER_APPEARANCE_STORAGE_KEY); else localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, previousAppearance);
  }
}

async function verifyNodeImageOutput() {
  const raster = (width: number, height: number, color?: string) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!;
    if (color) { context.fillStyle = color; context.fillRect(0, 0, width, height); }
    return canvas;
  };
  const saved = (id: string, left: number, top: number, bitmap: HTMLCanvasElement): UiNode => ({ ...node(id, left, top, left + bitmap.width, top + bitmap.height),
    layerImageStatus: "captured", layerImageDataUrl: bitmap.toDataURL("image/png"), layerImageSize: { width: bitmap.width, height: bitmap.height } });
  const pixels = raster(16, 12), context = pixels.getContext("2d")!;
  context.fillStyle = "red"; context.fillRect(10, 2, 1, 1);
  context.putImageData(new ImageData(new Uint8ClampedArray([255, 0, 0, 1]), 1, 1), 12, 8);
  const parent = saved("parent", 10, 20, pixels), blue = raster(4, 4, "blue"), green = raster(6, 4, "lime");
  parent.attributes = { "clip-children": "true", "image-capture-source": "sdk" };
  parent.children = [saved("child", 12, 22, blue), saved("overflow", 24, 26, green),
    { ...saved("style", 10, 20, raster(16, 12, "red")), layerImageStatus: "style" }, node("missing", 10, 20, 11, 21),
    { ...saved("invisible", 10, 20, raster(16, 12, "yellow")), visibleToUser: false }];
  const branchPlan = nodeImageExportPlan(parent, "branch");
  assert(branchPlan.kind === "composite" && branchPlan.missingCount === 2, "branch export did not disclose missing/style layers");
  const composite = await prepareNodeImageExport(parent, branchPlan, new AbortController().signal);
  const compositeImage = new Image(); compositeImage.src = composite.dataUrl; await compositeImage.decode();
  const decoded = await createImageBitmap(compositeImage), output = raster(decoded.width, decoded.height); compositeImage.src = "";
  output.getContext("2d")!.drawImage(decoded, 0, 0); decoded.close();
  const pixel = (x: number, y: number) => [...output.getContext("2d")!.getImageData(x, y, 1, 1).data];
  assert(output.width === 16 && output.height === 12 && composite.size?.width === 16, "branch PNG dimensions were scaled or moved");
  assert(pixel(0, 0)[3] === 0 && pixel(3, 3).join() === "0,0,255,255" && pixel(10, 2).join() === "255,0,0,255"
    && pixel(12, 8)[3] === 1 && pixel(15, 7).join() === "0,255,0,255", `branch PNG lost transparency, child offset, overflow clipping, or mixed style pixels: ${[pixel(0, 0), pixel(3, 3), pixel(10, 2), pixel(12, 8), pixel(15, 7)]}`);
  const original = await prepareNodeImageExport(parent, nodeImageExportPlan(parent, "own"), new AbortController().signal);
  assert(original.dataUrl === parent.layerImageDataUrl, "own export substituted branch/camera pixels");
  const group: QmlGroupImage = { dataUrl: blue.toDataURL(), size: { width: 4, height: 4 }, capturedAt: "2026-10-11T00:00:00Z" };
  const native = await prepareNodeImageExport(parent, nodeImageExportPlan(parent, "branch", group), new AbortController().signal);
  assert(native.dataUrl === group.dataUrl && native.size?.width === 4, "saved native group was resized to current bounds");

  const host = document.createElement("div"); Object.assign(host.style, { width: "300px", padding: "12px", boxSizing: "border-box" }); document.body.append(host);
  const mounted = createRoot(host), previousApi = window.electronApi, previousDecode = window.createImageBitmap;
  const requests: NodeImageOutputRequest[] = []; let current = parent, source: QmlGroupImage | null = null, session = 1;
  let reply: (request: NodeImageOutputRequest) => Promise<ExportSnapshotResult> = async () => ({ canceled: false, filePath: "/test/control.png", error: null });
  window.electronApi = { ...previousApi, outputNodeImage: request => { requests.push(request); return reply(request); } };
  const render = () => flushSync(() => mounted.render(<NodeImageActions root={current} node={current} groupImage={source} sessionKey={session} />));
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
  const scope = (value: "own" | "branch") => flushSync(() => { const select = host.querySelector<HTMLSelectElement>("select")!;
    select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const status = () => host.querySelector(".node-image-output-status")?.textContent;
  const click = (index: number) => flushSync(() => buttons()[index].click());
  try {
    render(); assert(host.textContent?.includes("自身独立图 · SDK"), "own source was not shown");
    click(0); click(1); await until(() => Boolean(status()?.includes("已保存")), "own PNG output did not finish");
    assert(requests.length === 1 && requests[0].action === "save" && requests[0].dataUrl === parent.layerImageDataUrl, "busy actions duplicated output or used wrong pixels");
    click(1); await until(() => Boolean(status()?.includes("已复制图片")), "copy did not finish"); assert(requests.at(-1)?.action === "copy", "copy used save path");
    scope("branch"); assert(host.textContent?.includes("缺 2 层画面"), "local branch did not disclose missing layers");
    click(0); await until(() => Boolean(status()?.includes("已保存")), "local branch output did not finish");
    assert(requests.at(-1)?.dataUrl === composite.dataUrl && requests.at(-1)?.defaultFileName.includes("local-partial"), "local PNG or source filename did not match");
    source = group; render(); assert(host.textContent?.includes("已保存原生整组图"), "cached native image did not update panel");
    click(1); await until(() => Boolean(status()?.includes("已复制图片")), "native group copy did not finish");
    assert(requests.at(-1)?.dataUrl === group.dataUrl && requests.at(-1)?.size?.width === 4, "native group copy used local pixels");
    reply = async () => ({ canceled: true, filePath: null, error: null }); click(0); await until(() => !buttons()[0].disabled, "save cancel remained busy");
    assert(!status(), "cancel showed a false success/error");
    reply = async () => ({ canceled: false, filePath: null, error: "clipboard unavailable" }); click(1);
    await until(() => status() === "clipboard unavailable", "clipboard rejection became a success");
    let release!: (value: ExportSnapshotResult) => void;
    reply = () => new Promise(resolve => { release = resolve; }); click(1); await until(() => Boolean(release), "held output did not start");
    session++; render(); release({ canceled: false, filePath: null, error: "old output failed" }); await tick(); await tick();
    assert(!status() && !buttons()[0].disabled, "late output changed a new session with reused node identity");
    source = null; render(); let releaseBitmap!: () => void, closed = false;
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      const bitmap = await Reflect.apply(previousDecode, window, args);
      await new Promise<void>(resolve => { releaseBitmap = resolve; });
      const close = bitmap.close.bind(bitmap); bitmap.close = () => { closed = true; close(); }; return bitmap;
    }) as typeof createImageBitmap;
    const beforeAbort = requests.length; click(0); await until(() => Boolean(releaseBitmap), "local export never decoded saved pixels");
    current = { ...node("parent", 0, 0, 2, 2), attributes: { "image-capture-error": "该层图片未保存" } }; render(); releaseBitmap();
    await until(() => closed, "selection change leaked decoded bitmap"); await tick();
    assert(requests.length === beforeAbort && buttons().every(button => button.disabled) && host.textContent?.includes("没有可导出的图片") && !status(), "obsolete local export reached desktop or missing pixels remained actionable");
    scope("own"); assert(host.textContent?.includes("该层图片未保存"), "missing own capture reason was not shown");
    window.createImageBitmap = previousDecode; current = parent; render();
    for (const width of [300, 248]) {
      host.style.width = `${width}px`; await tick(); const container = host.getBoundingClientRect();
      for (const control of host.querySelectorAll<HTMLElement>("button,select")) { const rect = control.getBoundingClientRect();
        assert(rect.left >= container.left && rect.right <= container.right + 1, `image output control overflowed ${width}px inspector`); }
    }
    const previewImage = () => host.querySelector<HTMLImageElement>(".node-image-preview-image");
    const closePreview = () => flushSync(() => host.querySelector<HTMLButtonElement>(".node-image-preview .entry-dialog-close")!.click());
    window.electronApi = { ...window.electronApi, outputNodeImage: undefined };
    source = null; render(); scope("own");
    assert(buttons()[0].disabled && buttons()[1].disabled && !buttons()[2].disabled, "cached preview required output IPC");
    const outputCount = requests.length; click(2);
    await until(() => Boolean(previewImage()?.naturalWidth), "own image preview");
    const ownPreview = previewImage()!;
    assert(ownPreview.src === parent.layerImageDataUrl && ownPreview.naturalWidth === 16 && ownPreview.naturalHeight === 12
      && getComputedStyle(host.querySelector(".node-image-preview-viewport")!).backgroundImage.includes("conic-gradient"), "preview changed pixels/dimensions or lost transparency grid");
    closePreview(); assert(!previewImage() && !ownPreview.hasAttribute("src"), "closing preview retained the displayed image source");
    scope("branch"); click(2); await until(() => Boolean(previewImage()?.naturalWidth), "local composite preview");
    const localPreview = previewImage()!;
    assert(localPreview.src === composite.dataUrl && host.querySelector('.node-image-preview [data-image-source="composite"]'), "local preview mixed original and reconstruction sources");
    source = group; render();
    assert(!previewImage() && !localPreview.hasAttribute("src"), "new group retained old local preview");
    click(2); await until(() => Boolean(previewImage()?.naturalWidth), "saved group preview");
    assert(previewImage()!.src === group.dataUrl && previewImage()!.naturalWidth === 4
      && host.querySelector('.node-image-preview [data-image-source="group"]'), "native group preview resized original pixels or hid provenance");
    session++; render(); assert(!host.querySelector(".node-image-preview"), "new session retained a preview");
    source = null; render(); let releasePreviewBitmap!: () => void, previewBitmapClosed = false;
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      const bitmap = await Reflect.apply(previousDecode, window, args);
      await new Promise<void>(resolve => { releasePreviewBitmap = resolve; });
      const close = bitmap.close.bind(bitmap); bitmap.close = () => { previewBitmapClosed = true; close(); }; return bitmap;
    }) as typeof createImageBitmap;
    click(2); await until(() => Boolean(releasePreviewBitmap), "held preview bitmap");
    closePreview(); await tick();
    assert(!host.querySelector(".node-image-preview") && !buttons()[2].disabled, "closing held preparation did not promptly clear the dialog and busy state");
    releasePreviewBitmap(); await until(() => previewBitmapClosed, "preview leaked a late bitmap"); await tick();
    assert(!host.querySelector(".node-image-preview") && requests.length === outputCount, "obsolete preview reopened or sent output IPC");
    return ["PNG pixels: own/native group preserve original size; local branch offsets/clipping/alpha=0/1/255, excludes styles and invisible subtrees, discloses missing layers",
      "image actions: save/copy/busy guard, truthful native/local source, cancel/error, stale session/selection decode abort with bitmap cleanup, 300/248px widths",
      "image preview: own/native/local original pixels and transparency grid without output IPC; close/group/session release displayed sources and promptly cancel held preparation; late bitmap closes without reopening"];
  } finally { window.createImageBitmap = previousDecode; flushSync(() => mounted.unmount()); host.remove(); window.electronApi = previousApi; pixels.width = pixels.height = blue.width = blue.height = green.width = green.height = output.width = output.height = 0; }
}

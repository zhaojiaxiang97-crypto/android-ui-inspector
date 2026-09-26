import { createRoot } from "react-dom/client";
import { createRef } from "react";
import { flushSync } from "react-dom";
import type { CaptureGeometry, LayerMenuAction, PixelSize, UiNode } from "../shared/types";
import { ScreenshotPreview } from "../src/components/ScreenshotPreview";
import { makeNode } from "./fixtures";
import { composeSubtreeImage } from "../shared/layer-textures";
import { qmlStyleFrom, qmlStyleSvg } from "../shared/qml-style";
import { Layer3DPreview, type LayerSceneHandle } from "../src/components/Layer3DPreview";
import { nodeDisplayLabel, flattenNodes } from "../shared/tree-utils";
import "../src/App.css";

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
    checks.push(...await verifyLayerComposites());
    checks.push(...await verifyLayerOcclusion());
    checks.push(...await verifyLayerBorders());
    checks.push(...await verifyLayerContentBounds());
    checks.push(...await verifyLayerMenu());
    checks.push(...await verifyLayerExpansion());
    checks.push(...await verifyLayerMeasurements());
    checks.push(...await verifyLayerFraming());
    for (const [width, height] of [[720, 1280], [1080, 2400], [1440, 3200], [1280, 720], [2400, 1080], [3200, 1440], [2560, 1600], [1600, 2560], [1000, 1000]]) {
      current = fixture({ width, height }); geometry = current.geometry; selected = current.root; render(); await ready();
      flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button")!.click());
      for (const panelWidth of [240, 680]) {
        flushSync(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button")!.click());
        host.style.width = `${panelWidth}px`; await tick();
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
    return { checks, devicePixelRatio: window.devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } };
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); window.scrollTo(0, 0); }
}

Object.assign(window, { verifyCoordinates, benchmarkLayerRendering });

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
      let selected: UiNode | null = null, hidden: ReadonlySet<string> = new Set();
      const render = () => flushSync(() => reactRoot.render(<Layer3DPreview key={mode} ref={scene} src={screen} root={root} selectedNode={selected} expandedNodeIds={new Set([root.id])} hiddenNodeIds={hidden} size={{ width: 240, height: 200 }} renderScale={1} origin={{ left: 80, top: 80 }} camera={camera} onSelect={() => {}} />));
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
      selected = null; hidden = new Set([face.id]); render(); scene.current!.paintCamera(camera);
      assert(patch(40 + inset, 100).every(p => p[3] === 0), `${mode}: hiding the layer left its border behind`);
    }
    return ["pixel: native/trimmed/composite/legacy content has all four borders, unchanged own pixels and picking, blue/green highlights, hidden-border removal"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
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
  try {
    flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} src={bitmap.toDataURL()} root={root} selectedNode={root.children[15]} expandedNodeIds={new Set([root.id])} size={{ width: 360, height: 780 }} renderScale={.55} origin={{ left: 321, top: 75 }} camera={camera} onSelect={() => {}} />));
    const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
    await until(() => canvas.dataset.layerRenderer === "webgl" && canvas.dataset.layerTextureCount === "32", "render benchmark textures did not settle");
    const gl = canvas.getContext("webgl")!, draw = gl.drawArrays.bind(gl), upload = gl.texImage2D.bind(gl);
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
    flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} src={face.layerImageDataUrl!} root={occlusionRoot} selectedNode={null} expandedNodeIds={new Set([occlusionRoot.id])} size={{ width: 200, height: 160 }} renderScale={1} origin={{ left: 80, top: 80 }} camera={straight} onSelect={() => {}} />));
    await until(() => canvas.dataset.layerRenderer === "webgl" && canvas.dataset.layerTextureCount === "1", "occlusion textures did not settle");
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
    return { layers: 512, textures: 32, samples: samples.length, medianCpuMs: samples[60], p95CpuMs: samples[114], medianDrawCalls: draws[60], maxDrawCalls: draws.at(-1), scope: "CPU frame submission in real WebGL; excludes GPU completion/display refresh", screenshot };
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
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
  const draw = (expanded: boolean) => flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} src={parent.layerImageDataUrl!} root={parent} selectedNode={parent} expandedNodeIds={new Set(expanded ? [parent.id] : [])} size={{ width: 20, height: 20 }} renderScale={10} origin={{ left: 50, top: 50 }} camera={camera} onSelect={() => {}} />));
  try {
    draw(true);
    const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
    try {
      await until(() => canvas()?.dataset.layerTextureCount === "2", "independent WebGL textures did not load");
    } catch (error) {
      throw new Error(`${error}; canvas=${JSON.stringify(canvas()?.dataset)}, warning=${host.querySelector(".layer-resource-note")?.textContent ?? "none"}`);
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
    const drawHidden = async (hidden: string[], expanded = true, focusedNode: UiNode | null = null) => {
      flushSync(() => reactRoot.render(<Layer3DPreview key="hide" ref={scene} src={parent.layerImageDataUrl!} root={hideRoot} selectedNode={hideChild} expandedNodeIds={new Set(expanded ? [hideRoot.id, hideParent.id] : [hideRoot.id])} hiddenNodeIds={new Set(hidden)} focusedNode={focusedNode} size={{ width: 20, height: 20 }} renderScale={10} origin={{ left: 50, top: 50 }} camera={camera} onSelect={() => {}} />));
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
    assert(host.querySelector(".layer-measurement")?.textContent === "水平 0 px · 垂直 56 px", "measurement must retain layout bounds, not visible-content bounds");
    scene.current!.clearHover();
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
    await until(() => canvas().dataset.layerTextureCount === "1" && canvas().dataset.layerTrimmedCount === "1" && canvas().dataset.layerTextureVisibility === "[]", "screen-clipped content did not settle");
    scene.current!.paintCamera(camera);
    near(highlight()[0], 60, "offscreen content must stay clipped at the screen edge");
    near(highlight()[2], 499.5, "cropped source UV must exclude only the offscreen/transparent pixels");
    return ["pixel: progress-bar content/layout separation, unchanged pixels and measurements, perspective pass-through picking, cached scans, historical images and folded composites"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
}

async function verifyLayerMenu() {
  const host = document.createElement("div"); host.style.width = "680px"; document.body.append(host);
  const reactRoot = createRoot(host), previousApi = window.electronApi;
  let menu: { canHide: boolean; canRestore: boolean; canExitFocus: boolean; resolve: (choice: LayerMenuAction) => void } | null = null;
  let menuCalls = 0, selected: UiNode | null = null;
  const selectedId = () => selected?.id;
  let current = fixture({ width: 1080, height: 2400 });
  const render = () => flushSync(() => reactRoot.render(<ScreenshotPreview src={current.src} root={current.root} selectedNode={selected} expandedNodeIds={new Set([current.root.id])} geometry={current.geometry} onSelect={node => { selected = node; render(); }} />));
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
      assert(!label() && !host.querySelector(".layer-measurement"), "drag retained hover/measurement labels");
      pointer("pointerup", 16, shift);
      assert(selectedId() === hoveredId && !frame().dataset.gesture, "drag changed selection or left a stuck cursor");
    }
    for (const end of ["pointercancel", "lostpointercapture", "blur"]) {
      pointer("pointerdown"); pointer("pointermove", 16);
      if (end === "blur") flushSync(() => window.dispatchEvent(new Event("blur"))); else pointer(end, 16);
      assert(!frame().dataset.gesture && !frame().classList.contains("is-3d-dragging") && !label(), `${end} did not clean up the gesture`);
    }
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
    assert(!host.querySelector(".layer-measurement"), "outside nodes remained available for measurement");
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
    assert(canvas().dataset.layerAnimationProgress === "1", "collapse did not interrupt the previous expansion");
    const previousMatchMedia = window.matchMedia;
    window.matchMedia = query => query.includes("prefers-reduced-motion") ? { matches: true } as MediaQueryList : previousMatchMedia.call(window, query);
    try {
      expanded = new Set([current.root.id]); render(); await tick();
      assert(canvas().dataset.layerAnimationProgress === "1", "reduced-motion setting was ignored");
    } finally { window.matchMedia = previousMatchMedia; }
    return ["double-click: parent-only expansion, 240ms GPU animation, cancellation/reduced motion; single/leaf/pan/drag/cancel/empty clicks do not expand"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
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
  let selected = a, hidden = new Set<string>(), expanded = new Set([current.root.id, b.id]), scale = 1;
  let camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
  let selections = 0;
  const render = () => flushSync(() => reactRoot.render(<Layer3DPreview ref={scene} src={current.src} root={current.root} selectedNode={selected} expandedNodeIds={expanded} hiddenNodeIds={hidden} size={{ width: 400, height: 320 }} renderScale={scale} origin={{ left: 100, top: 40 }} camera={camera} onSelect={() => { selections++; }} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>("canvas")!;
  const overlay = () => host.querySelector<SVGElement>(".layer-measurement");
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
    assert(overlay()?.dataset.measureAnchor === a.id && overlay()?.dataset.measureTarget === b.id, "hover did not preserve the measurement anchor");
    assert(overlay()!.textContent === "水平 40 px · 垂直 30 px", "measurement must use device bounds, not scene pixels");
    assert(selections === 0, "hover unexpectedly changed selection/properties");
    const path = () => overlay()!.querySelector("path")!.getAttribute("d");
    const before = path();
    scene.current!.paintCamera({ ...camera, azimuth: 40, elevation: 18, panX: 20, panY: -10 });
    assert(path() !== before && !path()!.includes("NaN"), "measurement guides did not follow the imperative camera path");
    assert(overlay()!.textContent === "水平 40 px · 垂直 30 px", "orbit changed measured distance");
    camera = { ...camera, azimuth: 25, layerGap: 128 }; scale = 0.7; render();
    assert(overlay()!.textContent === "水平 40 px · 垂直 30 px", "zoom/exploded layer spacing changed measured distance");
    assert(canvas().dataset.layerTextureBytes === textureBytes, "measurement changed texture allocation");
    hidden = new Set([child.id]); render();
    const gl = canvas().getContext("webgl")!, program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    const pivot = gl.getUniform(program, gl.getUniformLocation(program, "u_pivot")!) as Float32Array;
    near(pivot[0], 100 + 200 * scale, "scaled pivot X");
    near(pivot[1], 40 + 160 * scale, "scaled pivot Y");
    near(pivot[2], -128 * scale, "Z pivot must scale with X/Y, even when hiding a layer");
    near(gl.getUniform(program, gl.getUniformLocation(program, "u_depth")!), -128 * scale, "rendered plane Z must scale with X/Y");
    hover(b.id);
    hidden = new Set(); render();
    hover(child.id);
    assert(overlay()?.dataset.measureTarget === child.id, "moving to a third layer did not update the target");
    selected = b; camera = { ...camera, azimuth: 0 }; scale = 1; render(); hover(child.id);
    assert(overlay()?.dataset.measureRelation === "contains" && overlay()!.querySelectorAll(".measure-label").length === 4, "containment should show four insets");
    assert(overlay()!.textContent === "左 20 px右 60 px上 20 px下 40 px", "incorrect containment insets");
    for (const width of [680, 280]) {
      host.style.width = `${width}px`; await tick(); scene.current!.paintCamera(camera);
      const viewport = canvas().getBoundingClientRect();
      for (const label of overlay()!.querySelectorAll(".measure-label rect")) {
        const rect = label.getBoundingClientRect();
        assert(rect.left >= viewport.left - 1 && rect.right <= viewport.right + 1 && rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1, "measurement label outside viewport");
      }
      const label = host.querySelector<HTMLElement>(".layer-hover-label")!.getBoundingClientRect();
      assert(label.left >= viewport.left && label.right <= viewport.right && label.top >= viewport.top && label.bottom <= viewport.bottom, "hover identity label outside viewport");
    }
    host.style.width = "680px"; await tick(); scene.current!.paintCamera(camera);
    selected = child; render();
    assert(!overlay(), "selected layer must not measure itself");
    hover(b.id);
    assert(overlay()?.dataset.measureRelation === "inside", "new anchor should reverse containment");
    hidden = new Set([b.id]); render();
    assert(!overlay(), "hidden target retained stale measurements");
    hidden = new Set(); selected = a; render(); hover(child.id);
    expanded = new Set([current.root.id]); render();
    assert(!overlay(), "collapsed descendant retained stale measurements");
    hover(b.id);
    hidden = new Set([a.id]); render();
    assert(!overlay(), "hidden anchor retained stale measurements");
    hidden = new Set(); render(); hover(b.id);
    flushSync(() => scene.current!.hover(-1000, -1000));
    assert(!overlay(), "blank space retained measurements");
    hover(b.id); flushSync(() => scene.current!.clearHover());
    assert(!overlay(), "pointer leave retained measurements");
    assert(!host.querySelector(".layer-hover-label"), "pointer leave retained hover identity");
    hover(b.id);
    current.root = { ...current.root }; render(); await tick();
    assert(!overlay(), "new snapshot reused the old hover target");
    return ["measurement: fixed anchor, hover targets, source-pixel gaps/insets, camera/zoom/gap invariance, narrow labels and stale-state cleanup"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
}

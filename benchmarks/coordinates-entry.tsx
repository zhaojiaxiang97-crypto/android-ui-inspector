import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { CaptureGeometry, PixelSize, UiNode } from "../shared/types";
import { ScreenshotPreview } from "../src/components/ScreenshotPreview";
import { makeNode } from "./fixtures";
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
  const render = () => flushSync(() => reactRoot.render(<ScreenshotPreview src={current.src} root={current.root} selectedNode={selected} geometry={geometry} onSelect={value => { selected = value; calls++; render(); }} />));
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
    for (const [width, height] of [[720, 1280], [1080, 2400], [1440, 3200], [1280, 720], [2400, 1080], [3200, 1440], [2560, 1600], [1600, 2560], [1000, 1000]]) {
      current = fixture({ width, height }); geometry = current.geometry; selected = current.root; render(); await ready();
      for (const panelWidth of [240, 680]) {
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
    for (const target of [0.25, 0.5, 1, 2, 4, 8, 16] as const) {
      selected = current.root; render(); await tick(); await setZoom(target);
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

Object.assign(window, { verifyCoordinates });

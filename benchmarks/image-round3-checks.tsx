import { StrictMode, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ExportSnapshotResult, NodeImageOutputRequest, UiNode } from "../shared/types";
import { NodeImageActions, NodeImageActionOverlay } from "../src/components/NodeImageActions";
import { useNodeImageActionController, type NodeImageActionController, type NodeImageActionRequest } from "../src/features/layers/useNodeImageActionController";
import { nodeImageScopeOptions } from "../src/features/layers/node-image-action-options";
import { makeNode } from "./fixtures";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";
import "../src/styles/entry.css";
import "../src/styles/appearance.css";

type NativeInput = { type: string; x?: number; y?: number; button?: string; clickCount?: number; keyCode?: string; modifiers?: string[]; deltaX?: number; deltaY?: number; canScroll?: boolean };
type FixtureNative = { input: (events: NativeInput[]) => Promise<void>; checkpoint: (name: string) => Promise<void> };
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const settle = async () => { for (let count = 0; count < 3; count++) await tick(); };
const check: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Image round 3: ${message}`);
};
async function until(condition: () => boolean, message: string) {
  const end = performance.now() + 6000;
  while (!condition()) { check(performance.now() < end, message); await tick(); }
}
const png = (width: number, height: number) => {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const paint = canvas.getContext("2d")!;
  for (let x = 0; x < width; x += 160) for (let y = 0; y < height; y += 160) {
    paint.fillStyle = (x / 160 + y / 160) % 2 ? "rgba(55, 117, 211, .65)" : "rgba(202, 117, 55, .5)";
    paint.fillRect(x + 16, y + 16, 112, 112);
  }
  paint.fillStyle = "#ffffff"; paint.font = "48px sans-serif"; paint.fillText("右下阅读点", width - 440, height - 180);
  const dataUrl = canvas.toDataURL("image/png"); canvas.width = canvas.height = 0; return dataUrl;
};

/** Self-owned PNG data and sandbox input only. This fixture never reads or operates a device. */
export async function verifyImageRound3(native: FixtureNative, appearance = "dark") {
  const originalApi = window.electronApi, originalBitmap = window.createImageBitmap;
  const originalAppearance = document.documentElement.getAttribute("data-appearance");
  document.documentElement.setAttribute("data-appearance", appearance);
  const largeData = png(3200, 2400), smallData = png(64, 40);
  const saved = (id: string, dataUrl: string, width: number, height: number): UiNode => ({ ...makeNode(id), text: `图片 ${id}`,
    bounds: { left: 0, top: 0, right: width, bottom: height, raw: `[0,0][${width},${height}]` },
    attributes: { "image-capture-source": "sdk" }, layerImageStatus: "captured", layerImageDataUrl: dataUrl, layerImageSize: { width, height } });
  const a = saved("same-id", largeData, 3200, 2400), b = saved("small", smallData, 64, 40);
  const firstRoot = { ...makeNode("image-root"), children: [a, b] };
  const group = { dataUrl: smallData, size: { width: 64, height: 40 }, capturedAt: "2026-10-13T00:00:00Z" };
  const host = document.createElement("div"); document.body.append(host);
  const renderer = createRoot(host), output: NodeImageOutputRequest[] = [];
  let deviceRequests = 0, underlyingEvents = 0, currentRoot = firstRoot, currentNode = a, session = 1;
  let controller!: NodeImageActionController, setHidden!: (value: boolean) => void;
  let replaceRoot!: (root: UiNode) => void, select!: (index: number) => void, nextSession!: () => void;
  let reply: (request: NodeImageOutputRequest) => Promise<ExportSnapshotResult> = async () => ({ canceled: false, error: null, filePath: "/offline/control.png" });
  window.electronApi = new Proxy({ outputNodeImage: (request: NodeImageOutputRequest) => { output.push(request); return reply(request); } } as typeof window.electronApi,
    { get(target, key) { if (key === "outputNodeImage") return target.outputNodeImage; return () => { deviceRequests++; throw new Error(`Device bridge forbidden: ${String(key)}`); }; } });
  function Harness() {
    const [root, updateRoot] = useState(firstRoot), [selected, updateSelected] = useState(0), [key, updateKey] = useState(1), [hidden, updateHidden] = useState(false);
    controller = useNodeImageActionController({ root, node: root.children[selected], sessionKey: key });
    currentRoot = root; currentNode = root.children[selected]; session = key;
    replaceRoot = updateRoot; select = updateSelected; setHidden = updateHidden; nextSession = () => updateKey(value => value + 1);
    return <main className="app-shell inspection-active" style={{ minHeight: "100vh", padding: 20 }}
      onPointerDown={() => { underlyingEvents++; }} onWheel={() => { underlyingEvents++; }} onKeyDown={() => { underlyingEvents++; }}>
      <h1 style={{ fontSize: 17 }}>离线控件图片检查</h1>
      <button type="button" data-menu-preview onClick={() => controller.run({ root, node: root.children[selected], sessionKey: key, scope: "own", action: "preview" })}>从树或画布预览已有图片</button>
      <section data-properties hidden={hidden} style={{ width: 248, marginTop: 20 }}>
        <NodeImageActions root={root} node={root.children[selected]} sessionKey={key} controller={controller} />
      </section>
      <NodeImageActionOverlay controller={controller} />
    </main>;
  }
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const result = host.querySelector<T>(selector) ?? document.querySelector<T>(selector); check(result, `missing ${selector}`); return result;
  };
  const click = async (selector: string) => { flushSync(() => get(selector).click()); await settle(); };
  const input = async (events: NativeInput[]) => { await native.input(events); await settle(); };
  const center = (element: Element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; };
  const nativeClick = async (selector: string) => { const point = center(get(selector)); await input([
    { type: "mouseMove", ...point }, { type: "mouseDown", ...point, button: "left", clickCount: 1 }, { type: "mouseUp", ...point, button: "left", clickCount: 1 },
  ]); };
  const run = (action: NodeImageActionRequest["action"], scope: NodeImageActionRequest["scope"] = "own", node = currentNode, key?: number) => {
    flushSync(() => controller.run({ root: currentRoot, node, sessionKey: session, scope, action, key }));
  };
  const viewport = () => get<HTMLDivElement>(".node-image-preview-viewport"), bitmap = () => get<HTMLImageElement>(".node-image-preview-image");
  const scale = () => Number(get(".node-image-preview-content").dataset.previewZoom);
  const imagePoint = (point: { x: number; y: number }) => { const rect = bitmap().getBoundingClientRect(); return { x: (point.x - rect.left) / scale(), y: (point.y - rect.top) / scale() }; };
  const vpPoint = (fractionX = .5, fractionY = .5) => { const element = viewport(), rect = element.getBoundingClientRect();
    return { x: rect.left + element.clientLeft + element.clientWidth * fractionX, y: rect.top + element.clientTop + element.clientHeight * fractionY }; };
  const near = (a: { x: number; y: number }, b: { x: number; y: number }, name: string) => check(Math.abs(a.x - b.x) < 3 && Math.abs(a.y - b.y) < 3, `${name} drifted ${JSON.stringify({ a, b })}`);
  const scenarios: string[] = [];
  try {
    flushSync(() => renderer.render(<StrictMode><Harness /></StrictMode>)); await settle();
    await nativeClick(".node-image-copy"); await until(() => Boolean(controller.status?.includes("已复制图片")), "property output did not finish");
    const firstCopy = output.at(-1)!; run("copy", "own", currentNode, 100); await until(() => output.length === 2 && !controller.busy, "menu output did not finish");
    check(output.at(-1)?.dataUrl === firstCopy.dataUrl && output.at(-1)?.size?.width === firstCopy.size?.width, "property/menu images differed");
    run("copy", "own", currentNode, 100); await settle(); check(output.length === 2, "duplicate menu key repeated output");
    check(nodeImageScopeOptions(makeNode("missing")).every(option => !option.available), "missing scopes became actionable");
    scenarios.push("property/menu output parity, duplicate request key, own/missing provenance");

    flushSync(() => controller.cancel()); flushSync(() => setHidden(true));
    get("[data-menu-preview]").focus(); const opener = document.activeElement;
    await nativeClick("[data-menu-preview]"); await until(() => Boolean(document.querySelector<HTMLImageElement>(".node-image-preview-image")?.naturalWidth), "body preview did not decode");
    check(!host.contains(get(".node-image-preview")) && get("[data-properties]").hidden, "preview depends on hidden inspector");
    check(bitmap().naturalWidth === 3200 && bitmap().naturalHeight === 2400 && get('.node-image-preview [data-image-source="own"]'), "decoded dimensions/source changed");
    check(getComputedStyle(viewport()).backgroundImage.includes("conic-gradient"), "transparent checker was removed");
    check(get(".node-image-preview-hints").textContent?.includes("CSS 像素"), "100% omitted CSS/DPI meaning");
    await nativeClick(".node-image-preview-pixels");
    viewport().scrollTo(viewport().scrollWidth - viewport().clientWidth - 120, viewport().scrollHeight - viewport().clientHeight - 120); await settle();
    const beforeCenter = imagePoint(vpPoint()), beforeScene = underlyingEvents;
    await nativeClick('[aria-label="放大预览图片"]'); near(beforeCenter, imagePoint(vpPoint()), "button visible center");
    const anchorPoint = vpPoint(.7, .55), beforeAnchor = imagePoint(anchorPoint), beforeWheel = scale();
    await input([{ type: "mouseMove", ...anchorPoint }, { type: "mouseWheel", ...anchorPoint, deltaY: -100, deltaX: 0, modifiers: ["control"], canScroll: true }]);
    check(scale() !== beforeWheel, "Ctrl wheel did not zoom"); near(beforeAnchor, imagePoint(anchorPoint), "wheel pointer anchor");
    check(underlyingEvents === beforeScene, "preview gestures reached underlying workspace");
    await native.checkpoint(`image-${appearance}-reading-point`);
    viewport().scrollTo(500, 500); await settle(); const beforeScroll = viewport().scrollTop;
    await input([{ type: "mouseMove", ...vpPoint() }, { type: "mouseWheel", ...vpPoint(), deltaY: -80, deltaX: 0, canScroll: true }]);
    await until(() => viewport().scrollTop !== beforeScroll, "plain wheel no longer scrolls");
    for (let frame = 0; frame < 30; frame++) await tick();
    check(scale() !== 1 && scale() === Number(get(".node-image-preview-content").dataset.previewZoom), "plain scrolling reset image zoom");
    scenarios.push("hidden-inspector portal, decoded size/transparency/source, native button center and Ctrl-wheel anchor, normal scroll, scene isolation");

    viewport().scrollTo(800, 700); await settle();
    const drag = async (button: "left" | "middle", dx: number, dy: number) => { const point = vpPoint(); await input([
      { type: "mouseMove", ...point }, { type: "mouseDown", ...point, button, clickCount: 1 },
      { type: "mouseMove", x: point.x + dx, y: point.y + dy, modifiers: [button === "middle" ? "middleButtonDown" : "leftButtonDown"] },
      { type: "mouseUp", x: point.x + dx, y: point.y + dy, button, clickCount: 1 },
    ]); };
    const initial = { x: viewport().scrollLeft, y: viewport().scrollTop };
    await drag("middle", -60, -45);
    check(Math.abs(viewport().scrollLeft - initial.x - 60) < 2 && Math.abs(viewport().scrollTop - initial.y - 45) < 2, `middle pan failed ${JSON.stringify({ initial, after: { x: viewport().scrollLeft, y: viewport().scrollTop }, gesture: viewport().dataset.previewGesture })}`);
    check(!viewport().dataset.previewGesture, "middle release kept drag mode");
    viewport().focus(); await input([{ type: "keyDown", keyCode: "Space" }]);
    check(viewport().dataset.previewGesture === "ready", "Space did not enable pan");
    const beforeSpace = viewport().scrollLeft; await drag("left", -35, -25);
    await input([{ type: "keyUp", keyCode: "Space" }]);
    check(Math.abs(viewport().scrollLeft - beforeSpace - 35) < 2 && !viewport().dataset.previewGesture, "Space drag/release failed");
    await input([{ type: "keyDown", keyCode: "Space" }]); window.dispatchEvent(new Event("blur")); await settle();
    check(!viewport().dataset.previewGesture, "blur kept Space pan armed"); await input([{ type: "keyUp", keyCode: "Space" }]);
    viewport().focus(); const beforeIme = scale();
    flushSync(() => viewport().dispatchEvent(new KeyboardEvent("keydown", { key: "+", isComposing: true, bubbles: true, cancelable: true })));
    check(scale() === beforeIme, "IME consumed zoom shortcut");
    const keyboard = async (keyCode: string) => input([{ type: "keyDown", keyCode }, { type: "keyUp", keyCode }]);
    await keyboard("1"); check(scale() === 1, "native 1 did not restore CSS pixel scale");
    const centerBeforeKey = imagePoint(vpPoint()); await keyboard("="); check(scale() === 1.25, "native +/= did not zoom"); near(centerBeforeKey, imagePoint(vpPoint()), "keyboard center");
    await keyboard("-"); check(scale() === 1, "native - did not zoom out");
    await keyboard("0"); check(get(".node-image-preview-content").dataset.previewMode === "fit", "native 0 did not fit");
    check(viewport().scrollWidth <= viewport().clientWidth + 1 && viewport().scrollHeight <= viewport().clientHeight + 1, "fit retained overflowing content");
    await native.checkpoint(`image-${appearance}-fit`);
    const imageBeforeClose = bitmap(); await keyboard("Escape");
    check(!document.querySelector(".node-image-preview") && !imageBeforeClose.hasAttribute("src") && document.activeElement === opener, "Escape did not release bitmap and restore focus");
    scenarios.push("native middle/Space panning and release, blur cleanup, IME exclusion, focused keyboard + - 0 1, Escape focus/source cleanup");

    let releaseReply!: (result: ExportSnapshotResult) => void;
    reply = () => new Promise(resolve => { releaseReply = resolve; }); run("save");
    await until(() => Boolean(releaseReply), "held save did not start");
    check(document.querySelector(".node-image-action-feedback") && controller.busy, "hidden inspector lost output feedback");
    flushSync(() => nextSession()); releaseReply({ canceled: false, error: "obsolete save", filePath: null }); await settle();
    check(!controller.status && !controller.busy && !document.querySelector(".node-image-action-feedback"), "late save altered new session");
    reply = async () => ({ canceled: true, error: null, filePath: null }); run("save"); await until(() => !controller.busy, "save cancel remained busy");
    check(!controller.status, "cancel falsely claimed output success");
    reply = async () => ({ canceled: false, error: "clipboard fixture failure", filePath: null }); run("copy"); await until(() => !controller.busy, "error output remained busy");
    check(controller.status === "clipboard fixture failure", "copy failure became success");
    flushSync(() => controller.cancel());
    const oldSelection = currentNode, beforeSelect = output.length;
    flushSync(() => select(1)); await settle();
    run("copy", "own", oldSelection); await settle();
    check(output.length === beforeSelect && !controller.busy, "same-root old selection remained actionable");
    run("preview", "branch", currentRoot.children[1]); await until(() => Boolean(document.querySelector<HTMLImageElement>(".node-image-preview-image")?.naturalWidth), "branch preview did not decode");
    check(get('.node-image-preview [data-image-source="composite"]') && get(".node-image-preview-detail").textContent?.includes("不保证"), "local composite did not disclose precision");
    flushSync(() => controller.cancel());
    flushSync(() => controller.run({ root: currentRoot, node: currentRoot.children[1], sessionKey: session, groupImage: group, scope: "branch", action: "preview" }));
    await until(() => Boolean(document.querySelector<HTMLImageElement>(".node-image-preview-image")?.naturalWidth), "native group did not decode");
    check(bitmap().naturalWidth === 64 && get('.node-image-preview [data-image-source="group"]') && get(".node-image-preview-detail").textContent?.includes("不同帧"), "saved group source/frame changed");
    flushSync(() => controller.cancel());
    scenarios.push("hidden output feedback, late session/save reply guard, cancel/error honesty, composite/native-group provenance");

    let releaseBitmap!: () => void, closedBitmap = false;
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      const picture = await Reflect.apply(originalBitmap, window, args), close = picture.close.bind(picture);
      picture.close = () => { closedBitmap = true; close(); };
      await new Promise<void>(resolve => { releaseBitmap = resolve; }); return picture;
    }) as typeof createImageBitmap;
    const beforeCancel = output.length; run("copy", "branch", currentRoot.children[1]);
    await until(() => Boolean(releaseBitmap), "held branch preparation did not reach bitmap");
    await click(".node-image-action-feedback button"); releaseBitmap();
    await until(() => closedBitmap, "cancel leaked late bitmap");
    check(!controller.status && !controller.busy && output.length === beforeCancel, "cancel allowed obsolete output");
    for (const change of ["selection", "root", "session"] as const) {
      releaseBitmap = undefined as unknown as () => void; closedBitmap = false;
      run("preview", "branch"); await until(() => Boolean(releaseBitmap), `held ${change} preview did not reach bitmap`);
      if (change === "selection") flushSync(() => select(0));
      else if (change === "root") flushSync(() => replaceRoot({ ...currentRoot, children: currentRoot.children.map(item => ({ ...item })) }));
      else flushSync(() => nextSession());
      releaseBitmap(); await until(() => closedBitmap, `late ${change} preview leaked bitmap`); await settle();
      check(!controller.preview && !controller.busy && !document.querySelector(".node-image-preview") && output.length === beforeCancel, `late ${change} preview reopened or output`);
      if (change === "selection") flushSync(() => select(1));
    }
    window.createImageBitmap = originalBitmap;
    flushSync(() => select(0)); await settle();
    const capturedRoot = currentRoot, capturedNode = currentNode, capturedSession = session;
    const replacement = saved("same-id", smallData, 64, 40);
    flushSync(() => replaceRoot({ ...currentRoot, children: [replacement, b] }));
    flushSync(() => controller.run({ root: capturedRoot, node: capturedNode, sessionKey: capturedSession, scope: "own", action: "copy" }));
    flushSync(() => controller.run({ root: currentRoot, node: capturedNode, sessionKey: session, scope: "own", action: "copy" }));
    await settle(); check(output.length === beforeCancel && !controller.busy && !controller.preview, "old root or same-ID old node acted on replacement");
    run("preview"); await until(() => Boolean(document.querySelector<HTMLImageElement>(".node-image-preview-image")?.naturalWidth), "replacement did not preview");
    check(bitmap().naturalWidth === 64 && viewport().scrollTop === 0 && viewport().scrollLeft === 0 && get(".node-image-preview-content").dataset.previewMode === "fit", "new image retained reading position/scale");
    flushSync(() => select(1)); await settle(); check(!controller.preview && !document.querySelector(".node-image-preview"), "selection change retained preview");
    scenarios.push("cancel held preparation with late bitmap cleanup; old-root/exact-node identity guard; image/selection reset");
    releaseBitmap = undefined as unknown as () => void; closedBitmap = false;
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      const picture = await Reflect.apply(originalBitmap, window, args), close = picture.close.bind(picture);
      picture.close = () => { closedBitmap = true; close(); };
      await new Promise<void>(resolve => { releaseBitmap = resolve; }); return picture;
    }) as typeof createImageBitmap;
    flushSync(() => renderer.render(<main style={{ padding: 20, width: 248 }}><NodeImageActions root={b} node={b} sessionKey="local-compatibility" /></main>));
    flushSync(() => { const element = get<HTMLSelectElement>(".node-image-output select"); element.value = "branch"; element.dispatchEvent(new Event("change", { bubbles: true })); });
    const localOpener = get<HTMLButtonElement>(".node-image-preview-open"); localOpener.focus();
    await nativeClick(".node-image-preview-open"); await until(() => Boolean(releaseBitmap), "local pending preview never reached bitmap");
    check(host.contains(get(".node-image-preview")), "standalone compatibility dialog unexpectedly moved");
    await input([{ type: "keyDown", keyCode: "Escape" }, { type: "keyUp", keyCode: "Escape" }]);
    check(!host.querySelector(".node-image-preview") && document.activeElement === localOpener, "canceling preparation did not restore property opener focus");
    releaseBitmap(); await until(() => closedBitmap, "local pending preview leaked late bitmap");
    await nativeClick(".node-image-preview-open");
    window.createImageBitmap = originalBitmap;
    // The second controlled preparation also cancels cleanly when its local host disappears.
    await until(() => host.querySelector(".node-image-preview") !== null, "second local preview did not open");
    flushSync(() => renderer.render(null)); releaseBitmap(); await settle();
    check(!document.querySelector(".node-image-preview"), "local host unmount retained preview");
    scenarios.push("standalone inspector compatibility, cancel during preparation restores focus, local unmount aborts");
    const overflow = document.documentElement.scrollWidth > innerWidth + 1;
    check(!overflow && deviceRequests === 0, "fixture overflowed or contacted a device");
    return { passed: true, appearance, viewport: { width: innerWidth, height: innerHeight }, scenarios, deviceRequests, outputRequests: output.length };
  } finally {
    window.createImageBitmap = originalBitmap; flushSync(() => renderer.unmount()); host.remove(); window.electronApi = originalApi;
    if (originalAppearance === null) document.documentElement.removeAttribute("data-appearance"); else document.documentElement.setAttribute("data-appearance", originalAppearance);
  }
}
Object.assign(window, { verifyImageRound3 });

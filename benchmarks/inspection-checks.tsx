import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import type { InspectionProgress, UiSnapshot } from "../shared/types";
import { makeNode } from "./fixtures";

export async function verifyInspectionBehavior() {
  const previousApi = window.electronApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  let progress: ((value: InspectionProgress) => void) | null = null;
  const requests: Array<{ id: string; serial: string; resolve: (value: UiSnapshot) => void; reject: (error: Error) => void }> = [];
  const cancelled: string[] = [];
  const copied: string[] = [];
  const check = (value: unknown, message: string) => { if (!value) throw new Error(`Inspection: ${message}`); };
  const tick = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (predicate: () => boolean) => {
    const deadline = performance.now() + 4000;
    while (!predicate()) { if (performance.now() > deadline) throw new Error(`Inspection UI timeout: ${host.textContent}`); await tick(); }
  };
  const click = (selector: string) => {
    const button = host.querySelector<HTMLButtonElement>(selector);
    check(button && !button.disabled, `button unavailable: ${selector}`);
    flushSync(() => button!.click());
  };
  const snapshot = (serial: string, nodeCount: number): UiSnapshot => ({ serial, root: makeNode("latest"), nodeCount, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null });
  window.electronApi = {
    runtime: { sandboxed: true, contextIsolated: true },
    probeAdb: async () => ({ adbPath: "fixture", adbVersion: "fixture", error: null, devices: ["a", "b"].map((serial) => ({ serial, state: "device", model: serial, androidVersion: "15", product: null, transportId: null })) }),
    inspectDevice: (serial, id) => new Promise((resolve, reject) => requests.push({ serial, id, resolve, reject })),
    cancelInspection: async (id) => { cancelled.push(id); },
    showLayerMenu: async () => null,
    onInspectionProgress: (callback) => { progress = callback; return () => { progress = null; }; },
    copyText: async (text) => { copied.push(text); },
    loadSnapshots: async () => ({ snapshots: [], error: null }),
    saveSnapshot: async () => ({ snapshots: [], error: null }),
    clearSnapshots: async () => ({ snapshots: [], error: null }),
    exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }),
  };
  const sendProgress = (index: number, stage: string) => flushSync(() => progress?.({ requestId: requests[index].id, stage, elapsedMs: 0 }));
  const stageText = () => host.querySelector('h4[role="status"]')?.textContent;
  try {
    flushSync(() => root.render(<App />));
    await until(() => !host.querySelector<HTMLButtonElement>(".capture-button")!.disabled);
    click(".capture-button");
    check(requests.length === 1, "capture did not start");
    sendProgress(0, "fixture-stage");
    check(stageText() === "fixture-stage", "current progress was not shown");
    click(".workspace-empty-copy .tree-clear");
    check(cancelled.includes(requests[0].id), "cancel was not sent to backend");
    requests[0].resolve(snapshot("a", 11));
    await tick(); await tick();
    check(host.textContent?.includes("已取消采集") && !host.querySelector(".ui-tree-scroll"), "cancelled result returned to the workspace");

    click(".capture-button");
    const select = host.querySelector<HTMLSelectElement>(".device-select")!;
    flushSync(() => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    check(requests.length === 3 && requests[2].serial === "b", "device switch did not start a replacement capture");
    check(cancelled.includes(requests[1].id), "device switch did not cancel old capture");
    sendProgress(2, "new-stage"); sendProgress(1, "stale-stage");
    check(stageText() === "new-stage", "stale progress replaced current progress");
    requests[1].reject(new Error("old request failed"));
    await tick();
    check(stageText() === "new-stage", "stale failure interrupted new capture");
    const measured = snapshot("b", 22);
    measured.root!.text = "很长的页面容器名称".repeat(12);
    measured.root!.contentDesc = "页面描述";
    measured.root!.resourceId = "app:id/root";
    measured.root!.className = "android.widget.FrameLayout";
    measured.root!.bounds = { left: 0, top: 0, right: 63, bottom: 45, raw: "[0,0][63,45]" };
    measured.root!.attributes = { "padding-top": "0", "padding-right": "2", "padding-bottom": "0", "padding-left": "2" };
    const partial = makeNode("latest/partial"), unknown = makeNode("latest/unknown"), styled = makeNode("latest/style");
    partial.text = null; partial.contentDesc = "收藏"; partial.resourceId = "app:id/collect_icon"; partial.className = "android.view.View";
    unknown.text = " \n"; unknown.contentDesc = " "; unknown.resourceId = "app:id/collect_icon"; unknown.className = "android.view.View";
    styled.text = null; styled.contentDesc = null; styled.resourceId = null; styled.className = "android.widget.FrameLayout";
    partial.attributes = { "padding-top": "0", "padding-bottom": "bad", "padding-left": "4.5", "border-width": "1", "border-status": "启用状态未知" };
    unknown.bounds = null;
    unknown.attributes = { "padding-top": " ", "padding-right": "NaN", "padding-bottom": "Infinity" };
    styled.layerImageStatus = "style";
    styled.attributes = { "border-width": "0", "border-status": "已读取" };
    measured.root!.children = [partial, unknown, styled];
    requests[2].resolve(measured);
    await until(() => Boolean(host.querySelector(".snapshot-summary")?.textContent?.startsWith("22 nodes")));

    const panel = host.querySelector<HTMLElement>(".floating-inspector")!;
    const heading = () => panel.querySelector<HTMLHeadingElement>(".inspector-node-heading h4")!;
    const type = () => panel.querySelector<HTMLElement>(".inspector-node-type")!;
    const parent = () => panel.querySelector<HTMLElement>(".inspector-node-parent")!;
    check(heading().textContent === measured.root!.text && heading().title === measured.root!.text, "node heading does not prefer real text or preserve its full title");
    check(type().textContent?.includes("FrameLayout · @id/root") && type().title.includes("android.widget.FrameLayout"), "node type or full class name was lost");
    check(parent().textContent === "父容器 · 无（根节点）", "root node invents a parent");
    const frame = host.querySelector<HTMLElement>(".screenshot-frame")!;
    const handle = host.querySelector<HTMLButtonElement>(".inspector-drag-handle")!;
    const frameBefore = frame.getBoundingClientRect();
    const panelBefore = panel.getBoundingClientRect();
    check(getComputedStyle(panel).position === "absolute" && getComputedStyle(panel).backgroundColor.startsWith("rgba"), "inspector is not a translucent overlay");
    check(frameBefore.height > panelBefore.height, "inspector still reserves canvas height");
    check(!host.querySelector<HTMLDetailsElement>(".inspector-more")!.open, "advanced properties are open by default");
    click(".inspector-collapse");
    check(panel.offsetHeight <= 48 && host.querySelector<HTMLElement>(".inspector-body")!.hidden, "collapse did not leave a small tab");
    check(frame.getBoundingClientRect().height === frameBefore.height, "collapse resized the canvas");
    click(".inspector-collapse");
    flushSync(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    check(Math.abs(panel.getBoundingClientRect().left - panelBefore.left + 10) < 1, "keyboard move failed");
    // Synthetic pointer events cannot acquire a real OS pointer capture.
    handle.setPointerCapture = () => {};
    const point = handle.getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) => flushSync(() => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, clientX: x, clientY: y })));
    pointer("pointerdown", point.left + 10, point.top + 10);
    pointer("pointermove", point.left - 50, point.top + 50);
    pointer("pointerup", point.left - 50, point.top + 50);
    check(panel.getBoundingClientRect().left < panelBefore.left - 50 && panel.getBoundingClientRect().top > panelBefore.top + 20, "pointer drag failed");
    check(!panel.classList.contains("is-dragging") && frame.getBoundingClientRect().height === frameBefore.height, "drag changed camera layout or did not finish");
    const workspace = panel.parentElement!;
    const previousStyle = workspace.style.cssText;
    workspace.style.width = "350px"; workspace.style.height = "260px";
    await tick(); await tick();
    check(panel.offsetLeft >= 12 && panel.offsetLeft + panel.offsetWidth <= workspace.clientWidth - 11, "resize lost the inspector horizontally");
    check(panel.offsetTop >= 12 && panel.offsetTop + panel.offsetHeight <= workspace.clientHeight - 11, "resize lost the inspector vertically");
    workspace.style.cssText = previousStyle;
    flushSync(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    check(!panel.style.left, "Home did not reset the inspector position");
    click(".inspector-copy");
    await until(() => copied.length === 1 && Boolean(host.querySelector('[role="status"]')));
    check(JSON.parse(copied[0]).id === "latest", "copy did not use the selected node");
    flushSync(() => host.querySelector<HTMLElement>(".inspector-more > summary")!.click());
    check(host.querySelector<HTMLDetailsElement>(".inspector-more")!.open && Boolean(host.querySelector(".selector-copy")), "full properties and copy/export were removed");
    const box = () => host.querySelector<HTMLElement>(".box-model-card")!;
    const edges = () => [...box().querySelectorAll(".box-model-edge strong")].map(value => value.textContent).join("/");
    check(box().querySelector(".box-model-size strong")!.textContent === "63 × 45 屏幕 px" && edges() === "0/2/0/2", "box model lost bounds or measured zero padding");
    check(box().querySelector(".box-model-content")!.textContent === "内容区域未采集", "content size was fabricated from screen bounds");
    for (const width of [300, 248]) {
      panel.style.width = `${width}px`; await tick();
      check(panel.querySelector<HTMLElement>(".inspector-body")!.scrollWidth <= panel.clientWidth, "long node name overflows the panel");
      check(heading().scrollWidth > heading().clientWidth && getComputedStyle(heading()).textOverflow === "ellipsis", "long names are not truncated with a full-title tooltip");
      check(heading().getBoundingClientRect().right <= panel.querySelector(".inspector-copy")!.getBoundingClientRect().left, "long node name overlaps the copy button");
      check(box().scrollWidth <= box().clientWidth + 1, "box model overflows a narrow inspector");
      const center = box().querySelector(".box-model-content")!.getBoundingClientRect();
      const edge = (side: string) => box().querySelector(`[data-padding-side="${side}"]`)!.getBoundingClientRect();
      check(edge("top").bottom <= center.top && edge("bottom").top >= center.bottom && edge("left").right <= center.left && edge("right").left >= center.right, "padding values are not on their corresponding sides");
    }
    panel.style.removeProperty("width");
    click('.tree-row[data-tree-id="latest/partial"]');
    check(heading().textContent === "收藏" && type().textContent?.includes("View · @id/collect_icon"), "description did not take priority over the resource name");
    check(parent().textContent === `父容器 · ${measured.root!.text}` && parent().title.includes("#latest"), "parent identity missing or stale");
    check(edges() === "0/—/—/4.5", "partial/invalid padding discarded known sides or invented zeroes");
    check(box().querySelector(".box-model-extra > div:last-child dd")!.textContent === "—", "ambiguous border was presented as measured");
    click('.tree-row[data-tree-id="latest/unknown"]');
    check(heading().textContent === "collect_icon", "resource name did not replace the generic View title for empty text/description");
    check(!box().querySelector(".box-model-diagram") && Boolean(box().querySelector(".box-model-empty")), "unknown padding retained empty nested boxes");
    check(box().querySelector(".box-model-size strong")!.textContent === "— 屏幕 px", "missing bounds were invented");
    click('.tree-row[data-tree-id="latest/style"]');
    check(heading().textContent === "FrameLayout" && type().textContent?.includes("#latest/style"), "unnamed node did not retain type and unique ID");
    check(box().querySelector(".box-model-extra > div:last-child dd")!.textContent === "0px", "confirmed zero-width border was discarded");
    click('.tree-row[data-tree-id="latest"]');
    check(parent().textContent === "父容器 · 无（根节点）", "switching back to root retained the previous parent");
    click(".inspector-close");
    check(panel.hidden && document.activeElement === host.querySelector(".inspector-toggle"), "close did not return focus to the toolbar");
    click(".inspector-toggle");
    check(!panel.hidden && !host.querySelector<HTMLElement>(".inspector-body")!.hidden, "toolbar cannot restore inspector");
    flushSync(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    check(panel.hidden, "Escape did not close inspector");
    click(".inspector-toggle");
    check(frame.getBoundingClientRect().height === frameBefore.height, "restore resized the canvas");

    click(".capture-button");
    click(".toolbar-back-button");
    check(cancelled.includes(requests[3].id), "returning home did not cancel capture");
    requests[3].resolve(snapshot("b", 33));
    await tick(); await tick();
    check(!host.querySelector(".inspection-active"), "late result reopened the inspector");

    click(".capture-button");
    flushSync(() => root.unmount()); mounted = false;
    check(cancelled.includes(requests[4].id) && progress === null, "unmount did not release capture and listener");
    requests[4].resolve(snapshot("b", 44));
    await tick();
    return { checks: ["stage and cancel", "device switch ignores stale progress/failure", "floating inspector: drag, keyboard, resize bounds, collapse, close, restore and copy", "node identity: text/description/resource/type priority, full class, parent/root, long names at 300/248px", "box model: four-side placement at 300/248px, zero/partial/invalid padding, missing bounds and confirmed/ambiguous border", "return home ignores late result", "unmount cancels and unsubscribes"] };
  } finally {
    if (mounted) flushSync(() => root.unmount());
    window.electronApi = previousApi;
    host.remove();
  }
}

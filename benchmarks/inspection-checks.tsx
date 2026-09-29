import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import type { AppMenuAction, AppMenuState, InspectionPreview, InspectionProgress, UiSnapshot } from "../shared/types";
import { makeNode } from "./fixtures";

export async function verifyInspectionBehavior() {
  const previousApi = window.electronApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  let progress: ((value: InspectionProgress) => void) | null = null;
  let preview: ((value: InspectionPreview) => void) | null = null;
  let menuAction: ((value: AppMenuAction) => void) | null = null;
  let menuState: AppMenuState | null = null;
  const requests: Array<{ id: string; serial: string; resolve: (value: UiSnapshot) => void; reject: (error: Error) => void }> = [];
  const cancelled: string[] = [];
  const copied: string[] = [];
  const groupCalls: string[] = [];
  const viewRefreshCalls: string[] = [];
  let failNextViewRefresh = false;
  let holdGroup = false;
  let releaseGroup: ((value: { dataUrl: string; size: { width: number; height: number }; capturedAt: string }) => void) | null = null;
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
    updateAppMenu: async (state) => { menuState = state; },
    onAppMenuAction: (callback) => { menuAction = callback; return () => { menuAction = null; }; },
    probeAdb: async () => ({ adbPath: "fixture", adbVersion: "fixture", error: null, devices: ["a", "b"].map((serial) => ({ serial, state: "device", model: serial, androidVersion: "15", product: null, transportId: null })) }),
    inspectDevice: (serial, id) => new Promise((resolve, reject) => requests.push({ serial, id, resolve, reject })),
    captureQmlGroup: async (_requestId, nodeId) => {
      groupCalls.push(nodeId);
      const image = { dataUrl: new URL("../tests/fixtures/visual-screen.svg", window.location.href).href, size: { width: 360, height: 640 }, capturedAt: new Date().toISOString() };
      return holdGroup ? new Promise<typeof image>((resolve) => { releaseGroup = resolve; }) : image;
    },
    refreshViewNode: async (requestId, nodeId, scope = "node") => {
      viewRefreshCalls.push(`${requestId}:${nodeId}:${scope}`);
      if (failNextViewRefresh) { failNextViewRefresh = false; throw new Error("Debug View 连接提前关闭。"); }
      const parent = { ...makeNode(nodeId), text: scope === "branch" ? "刷新后的父控件" : "刷新后的控件", attributes: { "view-ref": "android.widget.TextView@1", "image-refreshed-at": "2026-01-01T00:00:00.000Z" }, layerImageStatus: "captured" as const, layerImageEmpty: false };
      if (scope === "node") return { nodes: [parent], failures: [] };
      const child = { ...makeNode(`${nodeId}/0`), text: "分支中的新文字", attributes: { "view-ref": "android.widget.TextView@2", "image-refreshed-at": "2026-01-01T00:00:01.000Z" }, layerImageStatus: "captured" as const, layerImageEmpty: false };
      return viewRefreshCalls.length === 2 ? { nodes: [parent, child], failures: [] }
        : { nodes: [parent], failures: [{ id: child.id, message: "控件补图超时" }] };
    },
    cancelInspection: async (id) => { cancelled.push(id); },
    showLayerMenu: async () => null,
    onInspectionProgress: (callback) => { progress = callback; return () => { progress = null; }; },
    onInspectionPreview: (callback) => { preview = callback; return () => { preview = null; }; },
    copyText: async (text) => { copied.push(text); },
    loadSnapshots: async () => ({ snapshots: [], error: null }),
    saveSnapshot: async () => ({ snapshots: [], error: null }),
    clearSnapshots: async () => ({ snapshots: [], error: null }),
    exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }),
  };
  const sendProgress = (index: number, stage: string) => flushSync(() => progress?.({ requestId: requests[index].id, stage, elapsedMs: 0 }));
  const sendPreview = (index: number, phase: InspectionPreview["phase"], value: UiSnapshot) => flushSync(() => preview?.({ requestId: requests[index].id, phase, snapshot: structuredClone(value) }));
  const stageText = () => host.querySelector('h4[role="status"]')?.textContent;
  try {
    flushSync(() => root.render(<App />));
    await until(() => !host.querySelector<HTMLButtonElement>(".capture-button")!.disabled);
    click(".capture-button");
    check(requests.length === 1, "capture did not start");
    sendProgress(0, "fixture-stage");
    check(stageText() === "fixture-stage", "current progress was not shown");
    sendPreview(0, "tree", snapshot("a", 11));
    check(Boolean(host.querySelector(".ui-tree-scroll")), "early tree preview was not shown");
    click(".inspector-heading-meta .tree-clear");
    check(cancelled.includes(requests[0].id), "cancel was not sent to backend");
    check(!host.querySelector(".ui-tree-scroll"), "cancelled preview remained available for saving");
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
    measured.screenshotDataUrl = new URL("../tests/fixtures/visual-screen.svg", window.location.href).href;
    measured.warning = "独立 View 画面抓取失败，缺失画面的控件仅显示边框。Debug View 连接提前关闭。";
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
    partial.attributes = { "inspection-source": "debug-view", "padding-top": "0", "padding-bottom": "bad", "padding-left": "4.5", "border-width": "1", "border-status": "启用状态未知", "image-capture-error": "本次补采达到上限" };
    partial.layerImageStatus = "failed";
    unknown.bounds = null;
    unknown.attributes = { "padding-top": " ", "padding-right": "NaN", "padding-bottom": "Infinity" };
    styled.layerImageStatus = "style";
    styled.attributes = { "inspection-source": "debug-qml", "border-width": "0", "border-status": "已读取" };
    measured.root!.children = [partial, unknown, styled];
    sendPreview(1, "tree", measured);
    check(!host.querySelector(".ui-tree-scroll"), "stale preview replaced the current capture");
    sendPreview(2, "tree", measured);
    check(Boolean(host.querySelector('.tree-row[data-tree-id="latest/partial"]')), "tree was not available before images completed");
    const save = () => [...host.querySelectorAll<HTMLButtonElement>(".snapshot-actions button")].find(button => button.textContent === "保存快照");
    check(Boolean(save()?.disabled), "incomplete snapshot can be saved");
    await until(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.disabled === false);
    click(".view-mode-toggle button:last-child");
    click('.tree-row[data-tree-id="latest/partial"]');
    sendPreview(2, "layers", measured);
    check(host.querySelector('.tree-row[data-tree-id="latest/partial"]')?.getAttribute("aria-selected") === "true", "image update lost tree selection");
    measured.screenshotDataUrl += "?final=1";
    requests[2].resolve(measured);
    await until(() => !host.querySelector(".inspector-heading-meta .tree-clear"));
    check(Boolean(host.querySelector(".snapshot-summary")?.textContent?.startsWith("22 nodes")), "completed tree summary is missing");
    await until(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.disabled === false);
    check(host.querySelector('.tree-row[data-tree-id="latest/partial"]')?.getAttribute("aria-selected") === "true", "final snapshot lost preview selection");
    check(host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.classList.contains("active"), "final screenshot reset 3D mode");
    check(save()?.disabled === false, "completed snapshot stayed disabled");
    click('.tree-row[data-tree-id="latest"]');

    const rail = host.querySelector<HTMLElement>(".scene-toolbar-host")!;
    const preview = host.querySelector<HTMLElement>(".preview-pane")!;
    const checkToolbar = () => {
      const bar = rail.getBoundingClientRect(), pane = preview.getBoundingClientRect();
      const canvas = host.querySelector<HTMLElement>(".screenshot-frame")!.getBoundingClientRect();
      check(rail.parentElement === preview && Math.abs(bar.left - pane.left) < 1 && Math.abs(bar.width - pane.width) < 1, "toolbar is not docked to its own pane");
      check(bar.bottom <= canvas.top + 1 && bar.height >= 48, "toolbar overlaps the canvas or loses its hit targets");
      const banner = host.querySelector(".snapshot-warning")?.getBoundingClientRect();
      check(!banner || banner.bottom <= bar.top, "toolbar overlaps the capture warning");
      for (const control of rail.querySelectorAll<HTMLElement>("button, select, summary")) {
        if (!control.checkVisibility()) continue;
        const bounds = control.getBoundingClientRect();
        check(bounds.left >= bar.left && bounds.right <= bar.right + 1, `narrow toolbar clips ${control.getAttribute("aria-label") || control.textContent}: ${bounds.left}…${bounds.right}, bar ${bar.left}…${bar.right}`);
      }
    };
    click(".view-mode-toggle button:last-child");
    for (const width of [360, 640]) {
      preview.style.width = `${width}px`; await tick(); await tick();
      checkToolbar();
      click(".layer-settings > summary");
      const menu = rail.querySelector(".layer-settings-body")!.getBoundingClientRect();
      check(menu.left >= preview.getBoundingClientRect().left && menu.right <= preview.getBoundingClientRect().right, "camera menu escapes the pane");
      click(".layer-settings > summary");
    }
    preview.style.removeProperty("width"); await tick(); await tick();
    checkToolbar();

    const warning = host.querySelector<HTMLElement>(".snapshot-warning")!;
    const canvasWithWarning = host.querySelector<HTMLElement>(".screenshot-frame")!.getBoundingClientRect().height;
    check(warning.querySelector('[role="status"]')?.textContent === measured.warning, "capture warning was not announced");
    warning.style.width = "240px";
    const dismiss = warning.querySelector<HTMLButtonElement>('button[aria-label="关闭采集提示"]')!;
    check(warning.scrollWidth <= warning.clientWidth && dismiss.getBoundingClientRect().right <= warning.getBoundingClientRect().right, "long warning hides the close button");
    dismiss.focus();
    click(".snapshot-warning-dismiss");
    check(!host.querySelector(".snapshot-warning") && document.activeElement === host.querySelector(".tree-search"), "warning did not close or return keyboard focus");
    check(host.querySelector<HTMLElement>(".screenshot-frame")!.getBoundingClientRect().height > canvasWithWarning, "dismissed warning still occupies canvas space");
    check(Boolean(measured.warning), "dismissing erased the snapshot diagnostic");

    check(!host.querySelector(".tree-pane > .subpanel-heading"), "redundant hierarchy heading remains");
    const splitter = host.querySelector<HTMLElement>(".tree-pane-resizer")!;
    const treePane = host.querySelector<HTMLElement>(".tree-pane")!;
    const resizeKey = (key: string) => flushSync(() => splitter.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    resizeKey("ArrowRight");
    check(treePane.offsetWidth === 316, "sidebar keyboard resize failed");
    splitter.setPointerCapture = () => {};
    const splitPointer = (type: string, x: number) => flushSync(() => splitter.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 9, button: 0, clientX: x })));
    splitPointer("pointerdown", 316); splitPointer("pointermove", 446); splitPointer("pointerup", 446);
    check(treePane.offsetWidth === 446 && splitter.getAttribute("aria-valuenow") === "446", "sidebar pointer resize did not update width/accessibility");
    splitPointer("pointerdown", 446); splitPointer("pointermove", -1000); splitPointer("pointercancel", -1000);
    check(treePane.offsetWidth === 240 && !splitter.parentElement!.classList.contains("is-resizing-tree"), "sidebar minimum/cancel failed");
    splitPointer("pointerdown", 240); splitPointer("pointermove", 5000); window.dispatchEvent(new Event("blur"));
    check(treePane.offsetWidth <= 720 && !splitter.parentElement!.classList.contains("is-resizing-tree"), "sidebar maximum/blur cleanup failed");
    resizeKey("Home");
    check(treePane.offsetWidth === 306, "sidebar reset failed");
    await tick(); await tick();

    const panel = host.querySelector<HTMLElement>(".floating-inspector")!;
    const heading = () => panel.querySelector<HTMLHeadingElement>(".inspector-node-heading h4")!;
    const type = () => panel.querySelector<HTMLElement>(".inspector-node-type")!;
    const parent = () => panel.querySelector<HTMLElement>(".inspector-node-parent")!;
    check(heading().textContent === measured.root!.text && heading().title === measured.root!.text, "node heading does not prefer real text or preserve its full title");
    check(type().textContent?.includes("FrameLayout · @id/root") && type().title.includes("android.widget.FrameLayout"), "node type or full class name was lost");
    check(parent().textContent === "父容器 · 无（根节点）", "root node invents a parent");
    const cards = () => [...panel.querySelectorAll<HTMLDetailsElement>(".inspector-card")];
    check(cards().length === 5 && cards().slice(0, 4).every(card => card.open), "inspector property groups are missing or initially closed");
    check(panel.querySelector(".inspector-type > summary small")?.textContent === "来源未标注", "missing source was labeled as View Debug");
    check(panel.querySelector(".inspector-class-name")?.textContent === "android.widget.FrameLayout", "full class name missing from type card");
    check(!panel.querySelector(".inspector-geometry input"), "read-only geometry looks editable");
    click(".inspector-type > summary");
    check(!cards()[0].open, "type card cannot collapse independently");
    const search = panel.querySelector<HTMLInputElement>('.inspector-search input')!;
    const filter = (value: string) => flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    filter("  BOUNDS  ");
    check(cards().filter(card => !card.hidden).length === 1 && !panel.querySelector<HTMLElement>(".inspector-layout")!.hidden, "search did not filter property names case-insensitively");
    filter("android.widget.FrameLayout");
    check(cards().filter(card => !card.hidden).length === 1 && !cards()[0].hidden, "property value search failed");
    filter("no-property-matches-958");
    check(cards().every(card => card.hidden) && Boolean(panel.querySelector('.inspector-search-empty[role="status"]')), "search has no honest empty state");
    click('.inspector-search button');
    check(!search.value && document.activeElement === search && cards().every(card => !card.hidden) && !cards()[0].open, "clear search lost focus or reset disclosure state");
    filter("padding");
    flushSync(() => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    check(!search.value && !panel.hidden, "Escape in search closed the whole inspector instead of clearing the filter");
    click(".inspector-type > summary");
    const frame = host.querySelector<HTMLElement>(".screenshot-frame")!;
    const handle = host.querySelector<HTMLButtonElement>(".inspector-drag-handle")!;
    const frameBefore = frame.getBoundingClientRect();
    const panelBefore = panel.getBoundingClientRect();
    check(getComputedStyle(panel).position === "absolute" && getComputedStyle(panel).backgroundColor.startsWith("rgba"), "inspector is not a translucent overlay");
    check(panelBefore.top >= frameBefore.top, "property inspector overlaps docked tools");
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
    pointer("pointerdown", point.left, point.top); pointer("pointermove", point.left, -1000); pointer("pointerup", point.left, -1000);
    check(panel.getBoundingClientRect().top >= frame.getBoundingClientRect().top, "drag can cover the docked toolbar");
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
    click(".inspector-padding > summary");
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
    check(!host.querySelector(".snapshot-warning"), "node selection resurrected a dismissed warning");
    check(panel.querySelector(".inspector-type > summary small")?.textContent === "View Debug", "native View source was lost");
    check(panel.querySelector(".inspector-image")?.textContent?.includes("原因：本次补采达到上限"), "selected layer hid its own capture failure reason");
    check(heading().textContent === "收藏" && type().textContent?.includes("View · @id/collect_icon"), "description did not take priority over the resource name");
    check(parent().textContent === `父容器 · ${measured.root!.text}` && parent().title.includes("#latest"), "parent identity missing or stale");
    check(edges() === "0/—/—/4.5", "partial/invalid padding discarded known sides or invented zeroes");
    check(box().querySelector(".box-model-extra > div:last-child dd")!.textContent === "—", "ambiguous border was presented as measured");
    click('.tree-row[data-tree-id="latest/unknown"]');
    check(heading().textContent === "collect_icon", "resource name did not replace the generic View title for empty text/description");
    check(!box().querySelector(".box-model-diagram") && Boolean(box().querySelector(".box-model-empty")), "unknown padding retained empty nested boxes");
    check(box().querySelector(".box-model-size strong")!.textContent === "— 屏幕 px", "missing bounds were invented");
    click('.tree-row[data-tree-id="latest/style"]');
    check(panel.querySelector(".inspector-type > summary small")?.textContent === "QML Debug", "QML source was mislabeled");
    check(panel.querySelector(".inspector-image-state strong")?.textContent === "样式重建" && !panel.querySelector(".inspector-image")!.textContent?.includes("—px"), "style capture or missing units are misleading");
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

    window.electronApi = { ...window.electronApi, runtime: { ...window.electronApi.runtime, nativeMenu: true } };
    click(".refresh-button");
    await until(() => Boolean(host.querySelector(".native-menu")) && !host.querySelector<HTMLButtonElement>(".refresh-button")!.disabled);
    check(!host.querySelector<HTMLElement>(".topbar .inspector-toolbar")!.getClientRects().length, "native menu still has duplicate window controls");
    checkToolbar();
    const sendMenu = (action: AppMenuAction) => flushSync(() => menuAction?.(action));
    sendMenu({ type: "collapse-all" });
    check(host.querySelectorAll(".tree-row").length === 1, "native collapse did not reach the tree");
    sendMenu({ type: "expand-all" });
    check(host.querySelectorAll(".tree-row").length === 4, "native expand did not reach the tree");
    sendMenu({ type: "search" });
    check(document.activeElement === host.querySelector(".tree-search"), "native search did not focus the input");
    sendMenu({ type: "capture" });
    const currentMenu = menuState as AppMenuState | null;
    check(currentMenu?.capturing && currentMenu.selectedSerial === "b", "capture state did not reach native menu");
    sendMenu({ type: "capture" });
    check(requests.length === 4, "native menu allowed a duplicate capture");
    sendMenu({ type: "home" });
    check(cancelled.includes(requests[3].id), "returning home did not cancel capture");
    requests[3].resolve(snapshot("b", 33));
    await tick(); await tick();
    check(!host.querySelector(".inspection-active"), "late result reopened the inspector");

    click(".capture-button");
    requests[4].resolve({ ...snapshot("b", 44), warning: measured.warning });
    await until(() => Boolean(host.querySelector(".snapshot-warning")));
    check(host.querySelector(".snapshot-warning-message")?.textContent === measured.warning, "same warning from a new capture remained dismissed");
    sendMenu({ type: "capture" });
    check(!host.querySelector(".snapshot-warning"), "starting capture retained the old warning");
    requests[5].resolve(snapshot("b", 55));
    await until(() => Boolean(host.querySelector(".snapshot-summary")?.textContent?.startsWith("55 nodes")));
    check(!host.querySelector(".snapshot-warning"), "successful capture retained the old warning");
    sendMenu({ type: "capture" });
    const qml = snapshot("b", 2);
    qml.inspectionSource = "debug-qml";
    qml.screenshotDataUrl = new URL("../tests/fixtures/visual-screen.svg", window.location.href).href;
    qml.root = makeNode("0");
    qml.root.bounds = { left: 0, top: 0, right: 360, bottom: 640, raw: "[0,0][360,640]" };
    qml.root.attributes = { "inspection-source": "debug-qml", "qml-process-id": "123", "qml-window-id": "fixture", "qml-debug-id": "1" };
    const qmlChild = makeNode("0/0", 1);
    qmlChild.attributes = { "inspection-source": "debug-qml", "qml-debug-id": "2" };
    qml.root.children = [qmlChild];
    requests[6].resolve(qml);
    await until(() => Boolean(host.querySelector(".snapshot-summary")?.textContent?.startsWith("2 nodes")));
    click(".view-mode-toggle button:last-child");
    await until(() => Boolean(host.querySelector(".layer-scene")));
    sendMenu({ type: "collapse-all" });
    await until(() => groupCalls.includes("0") && Boolean(host.querySelector(".layer-resource-note")?.textContent?.includes("折叠画面实时采集于")));
    check(host.querySelector(".layer-scene")?.getAttribute("data-layer-root-composite") === "true" && Number(host.querySelector(".layer-scene")?.getAttribute("data-layer-texture-count")) > 0, "folded Qt group did not use its own group texture");
    sendMenu({ type: "expand-all" });
    await until(() => !host.querySelector(".layer-resource-note")?.textContent?.includes("折叠画面实时采集于"));
    check(host.querySelector(".layer-scene")?.getAttribute("data-layer-root-composite") === "false", "expanded Qt parent retained child pixels");
    holdGroup = true;
    sendMenu({ type: "collapse-all" });
    await until(() => Boolean(releaseGroup));
    sendMenu({ type: "capture" });
    releaseGroup!({ dataUrl: new URL("../tests/fixtures/visual-screen.svg", window.location.href).href, size: { width: 360, height: 640 }, capturedAt: new Date().toISOString() });
    await tick();
    check(!host.querySelector(".layer-resource-note")?.textContent?.includes("折叠画面实时采集于"), "late Qt group image entered a replacement capture");
    const native = snapshot("b", 3);
    native.inspectionSource = "debug-view";
    native.warning = "当前控件有采集提示";
    native.screenshotDataUrl = new URL("../tests/fixtures/visual-screen.svg", window.location.href).href;
    native.root = makeNode("0");
    native.root.attributes = { "debug-process-id": "123", "debug-window-name": "fixture" };
    native.root.children = [makeNode("0/0", 0)];
    native.root.children[0].attributes = { "view-ref": "android.widget.TextView@1" };
    native.root.children[0].children = [makeNode("0/0/0", 0)];
    native.root.children[0].children[0].attributes = { "view-ref": "android.widget.TextView@2" };
    requests[7].resolve(native);
    await until(() => Boolean(host.querySelector(".snapshot-summary")?.textContent?.startsWith("3 nodes")));
    click(".snapshot-warning-dismiss");
    click('.tree-row[data-tree-id="0/0"]');
    const refreshButton = host.querySelector<HTMLButtonElement>(".inspector-image-refresh")!;
    refreshButton.click(); refreshButton.click();
    await until(() => host.querySelector(".inspector-image-state strong")?.textContent === "已采集");
    check(viewRefreshCalls.length === 1 && viewRefreshCalls[0] === `${requests[7].id}:0/0:node`, "native refresh did not target only the selected live View");
    check(host.querySelector('.tree-row[data-tree-id="0/0"]')?.getAttribute("aria-selected") === "true" && host.querySelector(".inspector-node-heading h4")?.textContent === "刷新后的控件", "native refresh lost selection or updated the wrong node");
    check(Boolean(host.querySelector('.tree-row[data-tree-id="0/0/0"]')), "single-node refresh dropped a child branch");
    check(!host.querySelector(".snapshot-warning"), "single-node refresh resurrected a dismissed capture warning");
    check(Boolean(host.querySelector('.inspector-image-note[role="status"]')?.textContent?.includes("已刷新")), "native refresh has no completion feedback");
    const sceneBeforeBranch = host.querySelector(".layer-scene");
    click(".inspector-image-refresh:last-of-type");
    await until(() => host.querySelector('.tree-row[data-tree-id="0/0/0"]')?.textContent?.includes("分支中的新文字") === true);
    check(viewRefreshCalls[1] === `${requests[7].id}:0/0:branch`, "branch refresh did not target selected parent");
    check(host.querySelector('.tree-row[data-tree-id="0/0"]')?.getAttribute("aria-selected") === "true" && host.querySelector(".layer-scene") === sceneBeforeBranch, "branch refresh reset selection or camera scene");
    check(!host.querySelector(".snapshot-warning"), "branch refresh resurrected a dismissed warning");
    click(".inspector-image-refresh:last-of-type");
    await until(() => Boolean(host.querySelector('.inspector-image-note[role="status"]')?.textContent?.includes("1 层失败")));
    click('.tree-row[data-tree-id="0/0/0"]');
    check(host.querySelector(".inspector-image-note")?.textContent?.includes("旧画面") || host.textContent?.includes("保留旧画面"), "partial branch failure did not explain retained old image");
    check(host.querySelector(".inspector-node-heading h4")?.textContent === "分支中的新文字", "partial branch failure replaced the old child");
    sendMenu({ type: "capture" });
    const hybrid = { ...native, inspectionSource: "debug-hybrid" as const, root: { ...native.root!, children: [{
      ...native.root!.children[0], attributes: { ...native.root!.children[0].attributes,
        "tree-source": "debug-sdk", "debug-name": "业务面板",
        "sdk-class-hierarchy": "android.view.ViewGroup → android.view.View",
        "sdk-longClickable": "true", "sdk-contextClickable": "false", "sdk-hasOnClickListeners": "false", "sdk-pressed": "false", "sdk-activated": "true",
        "sdk-layout-params-class": "android.widget.FrameLayout$LayoutParams", "sdk-layout-width": "-1", "sdk-layout-height": "-2",
        "sdk-layout-gravity": "85",
        "sdk-marginTop": "0", "sdk-marginRight": "-10", "sdk-marginBottom": "4", "sdk-marginLeft": "2" },
    }] } };
    requests[8].resolve(hybrid);
    await until(() => Boolean(host.querySelector('.tree-row[data-tree-id="0/0"]')));
    click('.tree-row[data-tree-id="0/0"]');
    check(host.querySelector(".inspector-node-heading h4")?.textContent === "业务面板" && host.querySelector('.tree-row[data-tree-id="0/0"]')?.textContent?.includes("业务面板"), "Debug name did not reach inspector and tree");
    check(host.querySelector(".inspector-type > summary small")?.textContent === "SDK + View Debug" && host.querySelector(".inspector-type .inspector-property-list")?.textContent?.includes("Debug App 显式名称"), "hybrid name source was not explained");
    check(host.querySelector(".inspector-class-chain > summary")?.textContent?.includes("2 层") && host.querySelector(".inspector-class-chain")?.textContent?.includes("android.view.View"), "real SDK class ancestry was not shown");
    click(".inspector-interaction > summary");
    check(host.querySelector<HTMLDetailsElement>(".inspector-interaction")?.open && host.querySelector(".inspector-interaction")?.textContent?.includes("可长按是") && host.querySelector(".inspector-interaction")?.textContent?.includes("点击监听器否") && host.querySelector(".inspector-interaction")?.textContent?.includes("否”不代表"), "SDK View flags or listener caveat were not shown");
    check(host.querySelector(".inspector-layout")?.textContent?.includes("match_parent / wrap_content") && host.querySelector(".box-model-extra > div:first-child dd")?.textContent === "0px / -10px / 4px / 2px", "real SDK LayoutParams/margins were not shown");
    click(".inspector-layout-rules > summary");
    check(host.querySelector(".inspector-layout-rules")?.textContent?.includes("右 · 下 (0x55)"), "real FrameLayout gravity was not decoded");
    check(host.querySelectorAll(".inspector-image-refresh").length === 1, "hybrid snapshot should offer only single-node refresh");
    click(".inspector-image-refresh");
    await until(() => viewRefreshCalls.length === 4);
    check(viewRefreshCalls[3] === `${requests[8].id}:0/0:node`, "hybrid refresh did not target the selected live View");
    await until(() => host.querySelector(".inspector-node-heading h4")?.textContent === "刷新后的控件");
    failNextViewRefresh = true;
    click(".inspector-image-refresh");
    await until(() => Boolean(host.querySelector('.inspector-image-note[role="status"]')?.textContent?.includes("连接提前关闭")));
    check(host.querySelector(".inspector-node-heading h4")?.textContent === "刷新后的控件" && host.querySelector(".inspector-image-state strong")?.textContent === "已采集", "disconnected refresh replaced the last valid node or image");
    sendMenu({ type: "capture" });
    flushSync(() => root.unmount()); mounted = false;
    check(cancelled.includes(requests[9].id) && progress === null && menuAction === null, "unmount did not release capture and listeners");
    requests[9].resolve(snapshot("b", 66));
    await tick();
    return { checks: ["stage and cancel", "early tree/image preview preserves selection and 3D mode; incomplete snapshots cannot be saved", "capture warning: dismiss, focus, reclaimed space, long text, retained diagnostic, new capture reset and successful capture clears", "device switch ignores stale progress/failure", "sidebar: no heading, pointer/keyboard width, min/max, reset and cancelled drag", "native menu: capture guard, state sync, search, expand/collapse, home and cleanup", "Qt groups: fold uses live group, expand drops child pixels, and late image cannot enter a new capture", "native View: rapid clicks send one refresh; single and branch refresh preserve selection, scene, children and partial failures", "hybrid View: only single-node refresh is offered and disconnect preserves the old image", "floating inspector: drag, keyboard, resize bounds, collapse, close, restore and copy", "inspector groups: native disclosure, name/value search, empty/clear/Escape, retained collapse state, read-only geometry and honest View/QML/unknown source", "node identity: text/description/resource/type priority, full class, parent/root, long names at 300/248px", "box model: four-side placement at 300/248px, zero/partial/invalid padding, missing bounds and confirmed/ambiguous border", "return home ignores late result", "unmount cancels and unsubscribes"] };
  } finally {
    if (mounted) flushSync(() => root.unmount());
    window.electronApi = previousApi;
    host.remove();
  }
}

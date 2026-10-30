import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import type { AppMenuAction, AppMenuState, ExportSnapshotRequest, InspectionPreview, InspectionProgress, NodeImageOutputRequest, SaveSnapshotRequest, UiSnapshot, ViewRefreshResult } from "../shared/types";
import { parseSnapshotFile, serializeSnapshotFile, type ImportSnapshotFileResult } from "../shared/snapshot-file";
import { changedLayerImages, layerImageBaseline } from "../shared/tree-utils";
import { clipLayerImageToOutlines, composeSubtreeImage } from "../shared/layer-textures";
import { makeNode } from "./fixtures";
import { verifyLayerProvenance } from "./layer-provenance-checks";
import { verifyInspectionFocus } from "./inspection-focus-checks";
import { businessMetadataFixture } from "../tests/fixtures/debug-metadata";
import { INSPECTOR_GROUPS, INSPECTOR_GROUP_STORAGE_KEY, MAX_INSPECTOR_GROUP_PREFERENCE_LENGTH } from "../shared/inspector-groups";
import { verifyInspectorPropertySearch } from "./inspector-search-checks";
import { verifyNodeNavigation } from "./node-navigation-checks";
import { verifyLayoutRelations } from "./layout-relations-checks";
import { verifyLookinMigrationIntegration } from "./lookin-migration-checks";
import { verifyStructuredValues } from "./structured-values-checks";
import { verifyCompactInspector } from "./inspector-compact-checks";
import { verifyTreeSearchSuggestions } from "./tree-search-checks";
import { verifyAppearance } from "./appearance-checks";
import { verifyTreePresentation } from "./tree-presentation-checks";
import { verifyInspectorReference } from "./inspector-reference-checks";
import { verifyInspectorLayout } from "./inspector-layout-checks";
import { verifyTreeRound3 } from "./tree-round3-checks";
import { verifySubtreeClipping } from "./layer-clipping-checks";

async function verifyInspectorGroupPreferences() {
  const previousApi = window.electronApi;
  const storageBefore = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!;
    return [key, localStorage.getItem(key)!] as const;
  });
  const storageSet = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")!;
  const storageGet = Object.getOwnPropertyDescriptor(Storage.prototype, "getItem")!;
  const host = document.createElement("div"); document.body.append(host);
  const reactRoot = createRoot(host);
  const check = (value: unknown, message: string) => { if (!value) throw new Error(`Inspector group preferences: ${message}`); };
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const until = async (predicate: () => boolean, label: string) => {
    const deadline = performance.now() + 4000;
    while (!predicate()) { if (performance.now() > deadline) throw new Error(`Inspector group preferences timeout: ${label}`); await tick(); }
  };
  const click = (selector: string) => {
    const element = host.querySelector<HTMLElement>(selector);
    check(element && !(element instanceof HTMLButtonElement && element.disabled), `control unavailable: ${selector}`);
    flushSync(() => element!.click());
  };
  const fixture: UiSnapshot = {
    serial: "property-groups-fixture", nodeCount: 3, xmlSize: 0, rawXml: null, screenshotDataUrl: null, warning: null, error: null,
    root: { ...makeNode("0"), text: "属性分组根节点", children: [
      { ...makeNode("0/0", 1), text: "属性分组样例", debugMetadata: structuredClone(businessMetadataFixture), attributes: {
        "tree-source": "debug-sdk", "sdk-longClickable": "true", "sdk-hasOnClickListeners": "false", "preference-only-raw": "hidden-original-value",
      } },
      { ...makeNode("0/1", 2), text: "没有业务或交互扩展的节点" },
    ] },
  };
  let captureCount = 0, mountId = 0;
  const exports: ExportSnapshotRequest[] = [], saves: SaveSnapshotRequest[] = [], copies: string[] = [], extraDeviceReads: string[] = [];
  window.electronApi = {
    runtime: { sandboxed: true, contextIsolated: true },
    probeAdb: async () => ({ adbPath: "fixture", adbVersion: "fixture", error: null, devices: [{ serial: fixture.serial, state: "device", model: "fixture", androidVersion: "15", product: null, transportId: null }] }),
    inspectDevice: async () => { captureCount++; return structuredClone(fixture); },
    captureGroup: async () => { extraDeviceReads.push("group"); throw new Error("Unexpected group capture in property preference checks"); },
    refreshViewNode: async () => { extraDeviceReads.push("refresh"); throw new Error("Unexpected node refresh in property preference checks"); },
    readViewStyle: async () => { extraDeviceReads.push("style"); throw new Error("Unexpected live style read in property preference checks"); },
    cancelInspection: async () => {}, showLayerMenu: async () => null,
    onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {},
    copyText: async value => { copies.push(value); },
    loadSnapshots: async () => ({ snapshots: [], error: null }),
    saveSnapshot: async input => { saves.push(input); return { snapshots: [{ id: "group-preferences-saved", savedAt: input.capturedAt, ...input }], error: null }; },
    clearSnapshots: async () => ({ snapshots: [], error: null }),
    exportSnapshot: async input => { exports.push(input); return { canceled: true, filePath: null, error: null }; },
  };
  const card = (id: string) => host.querySelector<HTMLDetailsElement>(`.inspector-${id === "raw" ? "more" : id}`)!;
  const visibleCards = () => [...host.querySelectorAll<HTMLDetailsElement>(".inspector-card")].filter(element => !element.hidden);
  const panel = () => host.querySelector<HTMLElement>(".floating-inspector")!;
  const preferences = () => host.querySelector<HTMLElement>(".preferences-inspector-groups")!;
  const checkbox = (label: string) => host.querySelector<HTMLInputElement>(`[aria-label="显示${label}"]`)!;
  const changeGroup = (label: string, displayed: boolean) => { if (checkbox(label).checked !== displayed) click(`[aria-label="显示${label}"]`); };
  const filter = (value: string) => {
    const search = panel().querySelector<HTMLInputElement>(".inspector-search input")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const openPreferences = () => {
    click('[aria-label="属性显示设置"]');
    const more = document.querySelector<HTMLButtonElement>('body > .inspector-group-popup .inspector-group-more');
    check(more, "group popup has no more-settings entry"); flushSync(() => more!.click());
  };
  const closePreferences = () => click('[aria-label="关闭偏好设置"]');
  const mountAndCapture = async () => {
    flushSync(() => reactRoot.render(<App key={++mountId} />));
    await until(() => Boolean(host.querySelector<HTMLButtonElement>(".capture-button") && !host.querySelector<HTMLButtonElement>(".capture-button")!.disabled), "capture available after mount");
    click(".capture-button");
    await until(() => Boolean(host.querySelector('.tree-row[data-tree-id="0/0"]')) && !host.querySelector(".inspection-progress"), "fixture captured");
    click('.tree-row[data-tree-id="0/0"]');
  };
  const restoreDefaults = () => click('.preferences-inspector-groups .preferences-actions button');
  try {
    localStorage.clear();
    await mountAndCapture();
    check(visibleCards().length === 7 && card("business").querySelectorAll(".inspector-business-group").length === 2, "default groups or registered business groups missing");
    if (card("layout").open) click(".inspector-layout > summary");
    click(".inspector-business .inspector-business-group > summary");
    click(".inspector-business > summary");
    check(!card("layout").open && !card("business").open, "manual disclosure fixture did not fold");
    openPreferences();
    check(INSPECTOR_GROUPS.every(group => checkbox(group.label).checked), "default preference checkboxes incorrect");
    for (const label of ["布局", "业务信息", "原始属性"]) changeGroup(label, false);
    check(card("layout").hidden && card("business").hidden && card("raw").hidden && visibleCards().length === 4, "preferences were not applied immediately to the actual App");
    const stored = JSON.parse(localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY)!);
    check(stored.version === 1 && [...stored.hidden].sort().join(",") === "business,layout,raw", "local setting did not retain selected hidden groups");
    closePreferences();
    filter("bounds");
    check(!card("layout").hidden && card("layout").open, "hidden layout did not appear for a property-name search");
    click(".inspector-search button");
    check(card("layout").hidden && !card("layout").open, "clear search did not restore hidden and manually folded layout");
    filter("SampleCard");
    check(!card("business").hidden && card("business").open && card("business").querySelector<HTMLDetailsElement>(".inspector-business-group")!.open, "hidden business group or subgroup did not appear for a value search");
    flushSync(() => panel().querySelector<HTMLInputElement>(".inspector-search input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    check(card("business").hidden && !card("business").open && !card("business").querySelector<HTMLDetailsElement>(".inspector-business-group")!.open && !panel().hidden, "Escape changed saved visibility or manual business disclosure");
    filter("hidden-original-value");
    check(!card("raw").hidden && card("raw").open && card("raw").textContent?.includes("hidden-original-value"), "hidden original value could not be found");
    filter("");
    check(card("raw").hidden && !card("raw").open && localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY) === JSON.stringify(stored), "search changed persistent settings or original disclosure");

    click(".inspector-copy");
    await until(() => copies.length === 1, "complete node copy");
    const copied = JSON.parse(copies[0]);
    check(JSON.stringify(copied.debugMetadata) === JSON.stringify(businessMetadataFixture) && copied.attributes["preference-only-raw"] === "hidden-original-value", "hidden preferences removed data from complete node copy");
    click('[aria-label="更多工具"]'); click('[data-command="export-snapshot"]');
    await until(() => exports.length === 1, "complete snapshot export");
    const savedNode = parseSnapshotFile(JSON.parse(exports[0].data)).snapshot.root!.children[0];
    check(JSON.stringify(savedNode.debugMetadata) === JSON.stringify(businessMetadataFixture) && savedNode.attributes?.["preference-only-raw"] === "hidden-original-value", "hidden groups were lost from complete snapshot file");
    click('[aria-label="更多工具"]'); click('[data-command="save"]');
    await until(() => saves.length === 1, "complete history save");
    check(JSON.stringify(saves[0].snapshot.root!.children[0].debugMetadata) === JSON.stringify(businessMetadataFixture), "hidden business data was lost from history");
    click('.tree-row[data-tree-id="0/1"]');
    check(card("layout").hidden && card("raw").hidden && !card("business"), "changing node reset preferences or inherited absent business data");
    const capturesBefore = captureCount;
    click(".capture-button");
    await until(() => captureCount === capturesBefore + 1 && Boolean(host.querySelector('.tree-row[data-tree-id="0/0"]')) && !host.querySelector(".inspection-progress"), "new snapshot captured");
    click('.tree-row[data-tree-id="0/0"]');
    check(card("business").hidden && card("layout").hidden && card("raw").hidden, "new snapshot reset display settings");
    await mountAndCapture();
    check(card("business").hidden && card("layout").hidden && card("raw").hidden, "App remount did not load local display settings");

    openPreferences();
    for (const group of INSPECTOR_GROUPS) changeGroup(group.label, false);
    check(visibleCards().length === 0 && host.querySelector('.inspector-groups-empty[role="status"]')?.textContent?.includes("全部隐藏"), "all groups hidden lacked a clear recovery state");
    closePreferences();
    filter("SampleCard");
    check(visibleCards().length === 1 && !card("business").hidden && !host.querySelector(".inspector-groups-empty"), "all-hidden settings prevented searching business data");
    filter("");
    openPreferences(); restoreDefaults();
    check(visibleCards().length === 7 && INSPECTOR_GROUPS.every(group => checkbox(group.label).checked), "restore default did not restore all available groups");
    for (const group of INSPECTOR_GROUPS.filter(group => group.id !== "business" && group.id !== "interaction")) changeGroup(group.label, false);
    closePreferences(); click('.tree-row[data-tree-id="0/1"]');
    check(visibleCards().length === 0 && Boolean(host.querySelector(".inspector-groups-empty")), "absent business/interaction groups were counted as visible groups");
    click('.tree-row[data-tree-id="0/0"]');
    check(visibleCards().length === 2 && !card("business").hidden && !card("interaction").hidden, "real business/interaction groups were removed by display preferences");
    openPreferences(); restoreDefaults(); closePreferences();

    for (const width of [300, 248]) {
      panel().style.width = `${width}px`; await tick();
      const settings = panel().querySelector<HTMLElement>('[aria-label="属性显示设置"]')!;
      check(settings.getBoundingClientRect().width >= 20 && settings.getBoundingClientRect().right <= panel().getBoundingClientRect().right && panel().querySelector<HTMLElement>(".inspector-body")!.scrollWidth <= panel().clientWidth, `group entry overflowed ${width}px inspector`);
      openPreferences();
      const dialog = host.querySelector<HTMLElement>(".preferences-panel")!;
      dialog.style.width = `${width}px`; await tick();
      check(preferences().scrollWidth <= preferences().clientWidth + 1 && [...preferences().querySelectorAll<HTMLElement>("label,button")].every(control => control.getBoundingClientRect().right <= preferences().getBoundingClientRect().right + 1), `group controls overflowed ${width}px preferences`);
      changeGroup("布局", false); changeGroup("布局", true);
      check(!card("layout").hidden, `group checkbox was not usable at ${width}px`);
      closePreferences();
    }
    panel().style.removeProperty("width");
    const persistedDefaults = localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY);
    Object.defineProperty(Storage.prototype, "setItem", { ...storageSet, value: function(key: string, value: string) {
      if (key === INSPECTOR_GROUP_STORAGE_KEY) throw new Error("synthetic storage failure");
      return storageSet.value.call(this, key, value);
    } });
    openPreferences(); changeGroup("布局", false);
    check(card("layout").hidden && preferences().querySelector('[role="status"]')?.textContent?.includes("本机保存失败") && localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY) === persistedDefaults, "save failure was reported as persistent success or discarded current-window settings");
    closePreferences();
    Object.defineProperty(Storage.prototype, "setItem", storageSet);
    await mountAndCapture();
    check(visibleCards().length === 7, "save failure persisted after App remount");

    for (const bad of ["{broken", JSON.stringify({ version: 2, hidden: ["layout"] }), " ".repeat(MAX_INSPECTOR_GROUP_PREFERENCE_LENGTH + 1)]) {
      localStorage.setItem(INSPECTOR_GROUP_STORAGE_KEY, bad);
      await mountAndCapture();
      check(visibleCards().length === 7, "bad/future/oversized local settings did not restore defaults");
      openPreferences(); check(INSPECTOR_GROUPS.every(group => checkbox(group.label).checked), "fallback defaults disagreed with settings controls"); closePreferences();
    }
    Object.defineProperty(Storage.prototype, "getItem", { ...storageGet, value: function(key: string) {
      if (key === INSPECTOR_GROUP_STORAGE_KEY) throw new Error("synthetic storage read failure");
      return storageGet.value.call(this, key);
    } });
    await mountAndCapture();
    check(visibleCards().length === 7, "local storage read failure crashed App or hid available groups");
    check(extraDeviceReads.length === 0, "display preferences triggered an extra group, node or style request");
    return ["seven-group visibility, immediate settings and local remount persistence", "hidden name/value search temporarily reveals groups and subgroups; clear/Escape restore visibility and disclosure", "hidden complete node copy, snapshot file and history retain business groups and raw values", "node/new snapshot changes preserve settings; nonexistent business/interaction do not suppress all-hidden recovery", "all-hidden search, settings recovery and restore defaults", "300/248px controls remain usable", "write failure reports current-window-only state; malformed/future/oversized/read-failure settings fall back to defaults"];
  } finally {
    Object.defineProperty(Storage.prototype, "setItem", storageSet);
    Object.defineProperty(Storage.prototype, "getItem", storageGet);
    flushSync(() => reactRoot.unmount());
    window.electronApi = previousApi;
    localStorage.clear(); for (const [key, value] of storageBefore) localStorage.setItem(key, value);
    host.remove();
  }
}

async function verifyLayerClippingPixels() {
  await verifySubtreeClipping();
  const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` });
  const outline = (id: string, bounds: ReturnType<typeof rect>, radius: number) => ({
    ...makeNode(id), bounds, attributes: { "clip-to-outline": "true", "sdk-outlineLeft": "0", "sdk-outlineTop": "0", "sdk-outlineRight": String(bounds.right - bounds.left), "sdk-outlineBottom": String(bounds.bottom - bounds.top), "sdk-outlineRadius": String(radius) },
  });
  const source = document.createElement("canvas");
  source.width = source.height = 40;
  const sourceContext = source.getContext("2d")!;
  sourceContext.fillStyle = "#ff0000";
  sourceContext.fillRect(0, 0, 40, 40);
  const outer = outline("outer", rect(0, 0, 40, 40), 14);
  const inner = outline("inner", rect(5, 5, 35, 35), 6);
  const child = makeNode("child");
  child.bounds = rect(0, 0, 40, 40);
  child.layerImageDataUrl = "fixture";
  child.layerImageSize = { width: 40, height: 40 };
  const clipped = clipLayerImageToOutlines(child, [inner, outer], source) as HTMLCanvasElement;
  const pixels = (image: HTMLCanvasElement, x: number, y: number) => image.getContext("2d")!.getImageData(x, y, 1, 1).data;
  if (pixels(clipped, 20, 20)[3] !== 255) throw new Error("Rounded ancestor clipping removed visible child pixels");
  if (pixels(clipped, 2, 20)[3] !== 0 || pixels(clipped, 5, 5)[3] !== 0) throw new Error("Nested rounded ancestor clipping leaked child pixels");
  if (clipLayerImageToOutlines(child, [], source) !== source) throw new Error("Unclipped layer image was needlessly copied");

  outer.children = [child];
  outer.layerImageDataUrl = "fixture";
  outer.layerImageSize = { width: 40, height: 40 };
  const collapsed = await composeSubtreeImage(outer, { left: 0, top: 0, width: 40, height: 40 }, async () => source, 10_000);
  const center = pixels(collapsed, 20, 20);
  const corner = pixels(collapsed, 1, 1);
  if (center[0] !== 255 || center[3] !== 255 || corner[3] !== 0) throw new Error(`Collapsed parent composition disagrees with rounded clipping: center=${Array.from(center)} corner=${Array.from(corner)}`);
  // Independent ellipse equation, not a second invocation of production clipping.
  // A non-square pixel scale turns a circular logical corner into an ellipse.
  const wideSource = document.createElement("canvas");
  wideSource.width = 200; wideSource.height = 60;
  const wideContext = wideSource.getContext("2d")!;
  wideContext.fillStyle = "#ff0000"; wideContext.fillRect(0, 0, 200, 60);
  const wideChild = { ...makeNode("wide-child"), bounds: rect(0, 0, 100, 60) };
  const wideParent = outline("wide-parent", rect(0, 0, 100, 60), 20);
  const wideClip = clipLayerImageToOutlines(wideChild, [wideParent], wideSource) as HTMLCanvasElement;
  const widePixels = wideClip.getContext("2d")!.getImageData(0, 0, 200, 60).data;
  let checked = 0;
  for (let y = 0; y < 60; y++) for (let x = 0; x < 200; x++) {
    const dx = Math.max(40 - (x + .5), (x + .5) - 160, 0) / 40;
    const dy = Math.max(20 - (y + .5), (y + .5) - 40, 0) / 20;
    const distance = dx * dx + dy * dy;
    // Ignore the rasterizer's antialiased edge; compare unambiguous pixels only.
    if (distance > .85 && distance < 1.15) continue;
    const expectedAlpha = distance <= .85 ? 255 : 0;
    const actualAlpha = widePixels[(y * 200 + x) * 4 + 3];
    if (actualAlpha !== expectedAlpha) throw new Error(`Nonuniform rounded clipping mismatch at ${x},${y}: alpha=${actualAlpha}, expected=${expectedAlpha}`);
    checked++;
  }
  if (checked < 10_000) throw new Error("Rounded clipping oracle checked too few pixels");
  wideSource.width = wideSource.height = wideClip.width = wideClip.height = 0;
  source.width = source.height = clipped.width = clipped.height = collapsed.width = collapsed.height = 0;
}

export async function verifyInspectionBehavior() {
  const treeRound3 = await verifyTreeRound3();
  const treePresentation = await verifyTreePresentation();
  const inspectorReference = await verifyInspectorReference();
  const inspectorLayout = await verifyInspectorLayout();
  const appearance = await verifyAppearance();
  const compactInspector = await verifyCompactInspector();
  const treeSearchSuggestions = await verifyTreeSearchSuggestions();
  const layoutRelations = await verifyLayoutRelations();
  const structuredValues = await verifyStructuredValues();
  const lookinMigration = await verifyLookinMigrationIntegration();
  const nodeNavigation = await verifyNodeNavigation();
  const propertySearch = await verifyInspectorPropertySearch();
  const groupPreferences = await verifyInspectorGroupPreferences();
  const focus = await verifyInspectionFocus();
  await verifyLayerProvenance();
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
  const previewImages = new Map<number, ReturnType<typeof layerImageBaseline>>();
  const groupCalls: string[] = [];
  const fileImports: Array<{ resolve: (value: ImportSnapshotFileResult) => void; reject: (error: Error) => void }> = [];
  const fileExports: ExportSnapshotRequest[] = [];
  const imageOutputs: NodeImageOutputRequest[] = [];
  const groupBitmap = document.createElement("canvas"); groupBitmap.width = 360; groupBitmap.height = 640;
  groupBitmap.getContext("2d")!.fillRect(0, 0, 360, 640); const groupPng = groupBitmap.toDataURL("image/png"); groupBitmap.width = groupBitmap.height = 0;
  const ownBitmap = document.createElement("canvas"); ownBitmap.width = 360; ownBitmap.height = 48;
  ownBitmap.getContext("2d")!.fillRect(0, 0, 360, 48);
  const ownPng = ownBitmap.toDataURL("image/png"); ownBitmap.width = ownBitmap.height = 0;
  let latestSave: SaveSnapshotRequest | null = null;
  let styleCalls = 0;
  const viewRefreshCalls: string[] = [];
  let failNextViewRefresh = false;
  let holdViewRefresh = false;
  const heldRefreshes: Array<(result: ViewRefreshResult) => void> = [];
  let holdGroup = false;
  let releaseGroup: ((value: { dataUrl: string; size: { width: number; height: number }; capturedAt: string }) => void) | null = null;
  const check = (value: unknown, message: string) => { if (!value) throw new Error(`Inspection: ${message}`); };
  const tick = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (predicate: () => boolean, label = "") => {
    const deadline = performance.now() + 4000;
    while (!predicate()) { if (performance.now() > deadline) throw new Error(`Inspection UI timeout ${label}: ${host.textContent}`); await tick(); }
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
    captureGroup: async (_requestId, nodeId) => {
      groupCalls.push(nodeId);
      const image = { dataUrl: groupPng, size: { width: 360, height: 640 }, capturedAt: new Date().toISOString() };
      return holdGroup ? new Promise<typeof image>((resolve) => { releaseGroup = resolve; }) : image;
    },
    refreshViewNode: async (requestId, nodeId, scope = "node") => {
      viewRefreshCalls.push(`${requestId}:${nodeId}:${scope}`);
      if (holdViewRefresh) return new Promise<ViewRefreshResult>(resolve => heldRefreshes.push(resolve));
      if (failNextViewRefresh) { failNextViewRefresh = false; throw new Error("Debug View 连接提前关闭。"); }
      const parent = { ...makeNode(nodeId), text: scope === "branch" ? "刷新后的父控件" : "刷新后的控件", attributes: { "view-ref": "android.widget.TextView@1", "image-refreshed-at": "2026-01-01T00:00:00.000Z" }, layerImageStatus: "captured" as const, layerImageEmpty: false, layerImageDataUrl: ownPng, layerImageSize: { width: 360, height: 48 } };
      if (scope === "node") return { nodes: [parent], failures: [] };
      const child = { ...makeNode(`${nodeId}/0`), text: "分支中的新文字", attributes: { "view-ref": "android.widget.TextView@2", "image-refreshed-at": "2026-01-01T00:00:01.000Z" }, layerImageStatus: "captured" as const, layerImageEmpty: false, layerImageDataUrl: ownPng, layerImageSize: { width: 360, height: 48 } };
      if (viewRefreshCalls.length === 4) return { nodes: [], failures: [], branch: { ...parent, children: [
        { ...makeNode(`${nodeId}/0`), text: "混合分支新增层", attributes: { "view-ref": "android.widget.TextView@3" } },
        { ...child, id: `${nodeId}/1`, index: 1 },
      ] } };
      return viewRefreshCalls.length === 2 ? { nodes: [], failures: [], branch: { ...parent, children: [child] } }
        : { nodes: [], failures: [{ id: child.id, message: "控件补图超时" }], branch: { ...parent, children: [{ ...child, attributes: { ...child.attributes, "image-refresh-error": "控件补图超时；已保留旧画面。" } }] } };
    },
    readViewStyle: async () => { styleCalls++; return { ref: "android.widget.TextView@1", capturedAtMillis: Date.UTC(2026, 0, 1), backgroundType: "android.graphics.drawable.ColorDrawable", backgroundColor: "#800C3468", textColor: "#00203040", textSizePx: 16 }; },
    cancelInspection: async (id) => { cancelled.push(id); },
    showLayerMenu: async () => null,
    onInspectionProgress: (callback) => { progress = callback; return () => { progress = null; }; },
    onInspectionPreview: (callback) => { preview = callback; return () => { preview = null; }; },
    copyText: async (text) => { copied.push(text); },
    loadSnapshots: async () => ({ snapshots: [], error: null }),
    saveSnapshot: async (input) => { latestSave = input; return { snapshots: [{ id: "history-feedback", savedAt: input.capturedAt, ...input }], error: null }; },
    clearSnapshots: async () => ({ snapshots: [], error: null }),
    exportSnapshot: async input => { fileExports.push(input); return { canceled: true, filePath: null, error: null }; },
    outputNodeImage: async input => { imageOutputs.push(input); return { canceled: false, filePath: input.action === "save" ? "/test/control.png" : null, error: null }; },
    importSnapshotFile: () => new Promise((resolve, reject) => fileImports.push({ resolve, reject })),
  };
  const sendProgress = (index: number, stage: string) => flushSync(() => progress?.({ requestId: requests[index].id, stage, elapsedMs: 0 }));
  const sendPreview = (index: number, phase: InspectionPreview["phase"], value: UiSnapshot) => flushSync(() => {
    if (phase === "tree") {
      const snapshot = structuredClone(value);
      previewImages.set(index, layerImageBaseline(snapshot.root!));
      preview?.({ requestId: requests[index].id, phase, snapshot });
    } else {
      preview?.({ requestId: requests[index].id, phase, updates: changedLayerImages(value.root!, previewImages.get(index)!)! });
    }
  });
  const stageText = () => host.querySelector('h4[role="status"]')?.textContent;
  try {
    await verifyLayerClippingPixels();
    flushSync(() => root.render(<App />));
    await until(() => Boolean(host.querySelector<HTMLButtonElement>(".capture-button") && !host.querySelector<HTMLButtonElement>(".capture-button")!.disabled));
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
    partial.layerImageStatus = "captured";
    partial.layerImageEmpty = false;
    partial.layerImageDataUrl = new URL("../tests/fixtures/visual-screen.svg", window.location.href).href;
    partial.layerImageSize = { width: 63, height: 45 };
    partial.attributes["image-source"] = "独立采集";
    sendPreview(2, "layers", measured);
    check(host.querySelector('.tree-row[data-tree-id="latest/partial"]')?.getAttribute("aria-selected") === "true", "image update lost tree selection");
    check(host.querySelector('.inspector-image-state')?.getAttribute("data-state") === "captured", "image-only preview did not update the selected node");
    check([...host.querySelectorAll('.inspector-image-note')].some(note => note.textContent?.includes("来源：独立采集")), "image-only preview lost source metadata");
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
      const header = host.querySelector<HTMLElement>(".inspection-header")!;
      check(rail.parentElement === header && !preview.contains(rail), "scene controls are not in the shared header");
      check(bar.bottom <= canvas.top + 1 && bar.height >= 32 && header.getBoundingClientRect().bottom <= pane.top + 1, "header tools overlap the canvas or lose hit targets");
      const banner = host.querySelector(".snapshot-warning")?.getBoundingClientRect();
      check(!banner || bar.bottom <= banner.top, "toolbar overlaps the capture warning");
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
      const menu = document.querySelector("body > .layer-settings-body")!.getBoundingClientRect();
      check(menu.left >= 0 && menu.right <= innerWidth && menu.top >= rail.parentElement!.getBoundingClientRect().bottom, "camera menu escapes the window or covers its toolbar");
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
    check(cards().length === 5 && cards().every(card => card.open === card.classList.contains("inspector-image")), "inspector groups did not use the compact default disclosures");
    check(panel.querySelector(".inspector-type > summary small")?.textContent === "来源未标注", "missing source was labeled as View Debug");
    check(panel.querySelector<HTMLElement>(".inspector-class-name")?.title === "android.widget.FrameLayout" && panel.querySelector(".inspector-identity")?.textContent?.includes("android.widget.FrameLayout"), "full class name missing from type card");
    check(!panel.querySelector(".inspector-geometry input"), "read-only geometry looks editable");
    click(".inspector-type > summary");
    check(cards()[0].open, "type card cannot expand independently");
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
    check(cards().filter(card => !card.hidden).length === 2 && !cards()[0].hidden && !panel.querySelector<HTMLElement>(".inspector-more")!.hidden
      && [...panel.querySelectorAll(".inspector-search-result strong")].some(label => label.textContent === "UiSelector"), "property value search failed to include the exact type and real locator fields");
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
    check(panel.classList.contains("is-docked") && Math.abs(panel.getBoundingClientRect().right - preview.getBoundingClientRect().right + 8) < 1, "inspector is not anchored to the canvas right edge");
    check(getComputedStyle(panel).borderTopWidth === "0px" && getComputedStyle(panel).boxShadow === "none", "docked cards still have an outer floating-window frame");
    const dockedFrame = frame.getBoundingClientRect();
    click(".inspector-detach");
    check(!panel.classList.contains("is-docked") && frame.getBoundingClientRect().width === dockedFrame.width && frame.getBoundingClientRect().height === dockedFrame.height, "detaching properties changed the canvas layout");
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
    check(Math.abs(panel.parentElement!.clientWidth - panel.offsetLeft - panel.offsetWidth - 16) < 2, "Home did not reset the inspector position");
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
    check(panel.querySelector(".inspector-image-state strong")?.textContent === "画面未提供"
      && panel.querySelector(".node-presentation-status")?.textContent?.includes("记录为样式重建")
      && !panel.querySelector(".inspector-image")!.textContent?.includes("—px"), "missing style image or units are misleading");
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
    click(".inspector-detach");
    check(panel.classList.contains("is-docked") && !panel.style.left && !panel.style.right && !panel.style.getPropertyValue("--inspector-top"), "re-docking kept stale floating coordinates");

    window.electronApi = { ...window.electronApi, runtime: { ...window.electronApi.runtime, nativeMenu: true } };
    click(".refresh-button");
    await until(() => Boolean(host.querySelector(".native-menu")) && !host.querySelector<HTMLButtonElement>(".refresh-button")!.disabled);
    check(Boolean(host.querySelector<HTMLElement>(".inspection-header")!.getClientRects().length) && !host.querySelector(".topbar .inspector-toolbar"), "native menu hid the workbench header or retained the old large header");
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
    qmlChild.children = [{ ...makeNode("0/0/0", 2), attributes: { "inspection-source": "debug-qml", "qml-debug-id": "3" } }];
    qml.root.children = [qmlChild];
    qml.nodeCount = 3;
    requests[6].resolve(qml);
    await until(() => Boolean(host.querySelector(".snapshot-summary")?.textContent?.startsWith("3 nodes")
      && host.querySelector('.tree-row[data-tree-id="0/0/0"]')
      && host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.disabled === false), "new Qt tree and screenshot ready");
    click(".view-mode-toggle button:last-child");
    await until(() => Boolean(host.querySelector(".layer-scene")));
    sendMenu({ type: "collapse-all" });
    await until(() => groupCalls.includes("0") && Boolean(host.querySelector(".layer-resource-note")?.textContent?.includes("折叠画面实时采集于")));
    check(host.querySelector(".layer-scene")?.getAttribute("data-layer-root-composite") === "true" && Number(host.querySelector(".layer-scene")?.getAttribute("data-layer-texture-count")) > 0, "folded Qt group did not use its own group texture");
    const groupsBeforeSave = groupCalls.length;
    click('.tree-row[data-tree-id="0"]');
    flushSync(() => { const scope = host.querySelector<HTMLSelectElement>('[aria-label="控件图片范围"]')!; scope.value = "branch"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
    check(host.querySelector(".node-image-output-source")?.getAttribute("data-image-source") === "group", "live group cache did not reach image output panel");
    click(".node-image-output-buttons button:first-child");
    await until(() => document.querySelector("body > .node-image-action-feedback .node-image-output-status")?.textContent?.includes("已保存") === true, "cached native PNG output");
    check(imageOutputs.at(-1)?.dataUrl === groupPng && imageOutputs.at(-1)?.action === "save" && groupCalls.length === groupsBeforeSave,
      "cached native PNG output used wrong pixels or requested another group");
    sendMenu({ type: "save" });
    await until(() => Boolean(latestSave?.snapshot.layerGroupImages?.some(group => group.nodeId === "0")), "live native group was not saved");
    check(groupCalls.length === groupsBeforeSave, "saving fetched an extra native group");
    sendMenu({ type: "expand-all" });
    await until(() => !host.querySelector(".layer-resource-note")?.textContent?.includes("折叠画面实时采集于"));
    check(host.querySelector(".layer-scene")?.getAttribute("data-layer-root-composite") === "false", "expanded Qt parent retained child pixels");
    sendMenu({ type: "collapse-all" });
    await until(() => Boolean(host.querySelector(".layer-resource-note")?.textContent?.includes("折叠画面实时采集于")));
    check(groupCalls.length === groupsBeforeSave, "repeated Qt root fold missed the capture-scoped cache");
    sendMenu({ type: "expand-all" });
    holdGroup = true;
    click('.tree-row[data-tree-id="0/0"]');
    sendMenu({ type: "collapse-selected" });
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
    await until(() => host.querySelector('.tree-row[data-tree-id="0/0/0"]')?.textContent?.includes("分支中的新文字") === true, "first branch");
    check(viewRefreshCalls[1] === `${requests[7].id}:0/0:branch`, "branch refresh did not target selected parent");
    check(host.querySelector('.tree-row[data-tree-id="0/0"]')?.getAttribute("aria-selected") === "true" && host.querySelector(".layer-scene") === sceneBeforeBranch, "branch refresh reset selection or camera scene");
    check(!host.querySelector(".snapshot-warning"), "branch refresh resurrected a dismissed warning");
    click(".inspector-image-refresh:last-of-type");
    await until(() => Boolean(host.querySelector('.inspector-image-note[role="status"]')?.textContent?.includes("1 层补图失败")), "second branch");
    click('.tree-row[data-tree-id="0/0/0"]');
    check(host.querySelector(".inspector-image-note")?.textContent?.includes("旧画面") || host.textContent?.includes("保留旧画面"), "partial branch failure did not explain retained old image");
    check(host.querySelector(".inspector-node-heading h4")?.textContent === "分支中的新文字", "partial branch failure replaced the old child");
    sendMenu({ type: "capture" });
    const hybrid = { ...native, inspectionSource: "debug-hybrid" as const, root: { ...native.root!, attributes: { ...native.root!.attributes, "tree-source": "debug-sdk", "sdk-style-version": "1" }, children: [{
      ...native.root!.children[0], debugMetadata: structuredClone(businessMetadataFixture), attributes: { ...native.root!.children[0].attributes,
        "tree-source": "debug-sdk", "debug-name": "业务面板",
        "sdk-class-hierarchy": "android.view.ViewGroup → android.view.View",
        "sdk-longClickable": "true", "sdk-contextClickable": "false", "sdk-hasOnClickListeners": "false", "sdk-pressed": "false", "sdk-activated": "true",
        "sdk-layout-params-class": "android.widget.FrameLayout$LayoutParams", "sdk-layout-width": "-1", "sdk-layout-height": "-2",
        "sdk-layout-gravity": "85",
        "sdk-marginTop": "0", "sdk-marginRight": "-10", "sdk-marginBottom": "4", "sdk-marginLeft": "2" },
    }] } };
    requests[8].resolve(hybrid);
    await until(() => Boolean(host.querySelector('.tree-row[data-tree-id="0/0"]')), "hybrid capture");
    click('.tree-row[data-tree-id="0/0"]');
    check(host.querySelector(".inspector-node-heading h4")?.textContent === "业务面板" && host.querySelector('.tree-row[data-tree-id="0/0"]')?.textContent?.includes("业务面板"), "Debug name did not reach inspector and tree");
    check(host.querySelector(".inspector-type > summary small")?.textContent === "SDK + View Debug" && host.querySelector(".inspector-identity .inspector-property-list")?.textContent?.includes("Debug App 显式名称"), "hybrid name source was not explained");
    check(host.querySelector(".inspector-class-chain > summary")?.textContent?.includes("2 层") && host.querySelector(".inspector-class-chain")?.textContent?.includes("android.view.View"), "real SDK class ancestry was not shown");
    const business = () => host.querySelector<HTMLDetailsElement>(".inspector-business")!;
    const businessPanel = host.querySelector<HTMLElement>(".floating-inspector")!;
    const businessSearch = businessPanel.querySelector<HTMLInputElement>(".inspector-search input")!;
    const filterBusiness = (value: string) => flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(businessSearch, value);
      businessSearch.dispatchEvent(new Event("input", { bubbles: true }));
    });
    check(business()?.open && business().querySelectorAll(".inspector-business-group").length === 2
      && business().textContent?.includes("Debug SDK · 显式登记") && business().textContent?.includes("只读"), "registered business groups or source were missing");
    check(!business().querySelector("input,textarea,select"), "read-only business info offered an editor");
    check(business().querySelector('[data-debug-field="loading"] dd span')?.textContent === "false"
      && business().querySelector('[data-debug-field="retryCount"] dd span')?.textContent === "0"
      && business().querySelector('[data-debug-field="error"] dd span')?.textContent === "（空字符串）", "business values lost zero, false or the empty string");
    const copiesBeforeBusiness = copied.length;
    for (const key of ["loading", "retryCount", "error"]) click(`.inspector-business [data-debug-field="${key}"] button`);
    await until(() => copied.length === copiesBeforeBusiness + 3, "business value copy");
    check(copied.slice(-3).join("|") === "false|0|", "business copy did not preserve original primitive values");
    click(".inspector-business > summary");
    check(!business().open, "business card did not retain manual disclosure state");
    for (const query of ["SampleCard", "retryCount", "布尔值", "空字符串"]) {
      filterBusiness(query);
      check(!business().hidden && business().open && [...business().querySelectorAll<HTMLDetailsElement>(".inspector-business-group")].some(group => !group.hidden && group.open), "business search failed for " + query);
    }
    filterBusiness("");
    check(!business().open, "clearing business search changed manual collapse state");
    click(".inspector-business > summary");
    for (const width of [300, 248]) {
      businessPanel.style.width = `${width}px`; await tick();
      check(business().scrollWidth <= business().clientWidth + 1, "business metadata overflowed a narrow inspector");
      const detail = business().querySelector('[data-debug-field="detail"] dd')!;
      check(detail.querySelector("span")!.getBoundingClientRect().right <= detail.querySelector("button")!.getBoundingClientRect().left, "long business value overlapped its copy button");
    }
    businessPanel.style.removeProperty("width");
    click('.tree-row[data-tree-id="0"]');
    check(!host.querySelector(".inspector-business"), "another node inherited the previous business values");
    click('.tree-row[data-tree-id="0/0"]');
    click(".inspector-interaction > summary");
    check(host.querySelector<HTMLDetailsElement>(".inspector-interaction")?.open && host.querySelector(".inspector-interaction")?.textContent?.includes("可长按是") && host.querySelector(".inspector-interaction")?.textContent?.includes("点击监听器否") && host.querySelector(".inspector-interaction")?.textContent?.includes("否”不代表"), "SDK View flags or listener caveat were not shown");
    check(host.querySelector(".inspector-layout")?.textContent?.includes("match_parent / wrap_content") && host.querySelector(".box-model-extra > div:first-child dd")?.textContent === "0px / -10px / 4px / 2px", "real SDK LayoutParams/margins were not shown");
    click(".inspector-layout-rules > summary");
    check(host.querySelector(".inspector-layout-rules")?.textContent?.includes("右 · 下 (0x55)"), "real FrameLayout gravity was not decoded");
    check(host.querySelectorAll(".inspector-image-refresh").length === 2, "hybrid snapshot should offer branch refresh");
    click(".inspector-style-read");
    await until(() => Boolean(host.querySelector(".inspector-image")?.textContent?.includes("#800C3468")), "selected View style");
    const expectedBackgroundColor = document.createElement("span");
    expectedBackgroundColor.style.backgroundColor = `rgba(12, 52, 104, ${128 / 255})`;
    check(host.querySelector<HTMLElement>('[data-color-label="背景源色"] .inspector-color-swatch > span')?.style.backgroundColor === expectedBackgroundColor.style.backgroundColor
      && host.querySelector('[data-color-label="背景源色"]')?.textContent?.includes("#0C346880"), "Android ARGB swatch used CSS alpha order");
    check(host.querySelector<HTMLElement>('[data-color-label="当前文字色"] .inspector-color-swatch > span')?.style.backgroundColor === "rgba(32, 48, 64, 0)"
      && host.querySelector('[data-color-label="当前文字色"]')?.textContent?.includes("#20304000"), "transparent text color lost source RGB");
    click('[aria-label="复制背景源色原值"]'); await until(() => copied.at(-1) === "#800C3468", "raw ARGB copy");
    click('[aria-label="复制背景源色 Hex"]'); await until(() => copied.at(-1) === "#0C346880", "CSS hex copy");
    click('[aria-label="复制背景源色 RGBA"]'); await until(() => copied.at(-1) === `rgba(12, 52, 104, ${128 / 255})`, "precise RGBA copy");
    click(".inspector-image-refresh:last-of-type");
    await until(() => host.querySelector('.tree-row[data-tree-id="0/0/0"]')?.textContent?.includes("混合分支新增层") === true, "hybrid branch");
    check(!host.querySelector(".inspector-business"), "live refresh retained removed business registrations");
    check(!host.querySelector(".inspector-color-swatch"), "live refresh retained stale color readings");
    check(viewRefreshCalls[3] === `${requests[8].id}:0/0:branch` && host.querySelector('.tree-row[data-tree-id="0/0/1"]')?.textContent?.includes("分支中的新文字"), "hybrid branch did not add and reorder controls");
    click(".inspector-image-refresh");
    await until(() => viewRefreshCalls.length === 5);
    check(viewRefreshCalls[4] === `${requests[8].id}:0/0:node`, "hybrid refresh did not target the selected live View");
    await until(() => host.querySelector(".inspector-node-heading h4")?.textContent === "刷新后的控件");
    failNextViewRefresh = true;
    click(".inspector-image-refresh");
    await until(() => Boolean(host.querySelector('.inspector-image-note[role="status"]')?.textContent?.includes("连接提前关闭")));
    check(host.querySelector(".inspector-node-heading h4")?.textContent === "刷新后的控件" && host.querySelector(".inspector-image-state strong")?.textContent === "已采集", "disconnected refresh replaced the last valid node or image");
    holdGroup = false;
    click(".view-mode-toggle button:last-child");
    await until(() => Boolean(host.querySelector(".layer-scene")), "hybrid 3D scene missing");
    const groupsBeforeFold = groupCalls.length;
    sendMenu({ type: "collapse-all" });
    await until(() => host.querySelector(".layer-scene")?.getAttribute("data-layer-root-composite") === "true", "hybrid root did not fold");
    await until(() => groupCalls.length > groupsBeforeFold && groupCalls.includes("0"), "hybrid group request missing");
    await until(() => Boolean(host.querySelector(".layer-resource-note")?.textContent?.includes("折叠画面实时采集于")), "hybrid group image missing");
    const groupsBeforeRefresh = groupCalls.length;
    holdGroup = true;
    click(".inspector-image-refresh");
    await until(() => viewRefreshCalls.length === 7, "folded node refresh missing");
    await until(() => groupCalls.length > groupsBeforeRefresh, "folded group was not recaptured after child refresh");
    check(host.querySelectorAll(".tree-row").length === 1
      && host.querySelector(".layer-scene")?.getAttribute("data-layer-root-composite") === "true",
      "refreshing a hidden child reopened the folded parent");
    check(!host.querySelector(".layer-resource-note")?.textContent?.includes("折叠画面实时采集于"), "stale group remained visible while its child was refreshed");
    holdGroup = false;
    releaseGroup!({ dataUrl: new URL("../tests/fixtures/visual-screen.svg", window.location.href).href, size: { width: 360, height: 640 }, capturedAt: new Date().toISOString() });
    await until(() => Boolean(host.querySelector(".layer-resource-note")?.textContent?.includes("折叠画面实时采集于")), "refreshed group did not return");
    sendMenu({ type: "expand-all" });
    await until(() => !host.querySelector(".layer-resource-note")?.textContent?.includes("折叠画面实时采集于"));
    holdViewRefresh = true;
    click(".inspector-image-refresh");
    await until(() => heldRefreshes.length === 1, "old refresh held");
    sendMenu({ type: "capture" });
    check(cancelled.includes(requests[8].id), "new capture did not cancel the old live refresh");
    requests[9].resolve(hybrid);
    await until(() => Boolean(host.querySelector('.tree-row[data-tree-id="0/0"]')) && !host.querySelector(".inspection-progress"), "replacement capture");
    click('.tree-row[data-tree-id="0/0"]');
    click(".inspector-image-refresh");
    await until(() => heldRefreshes.length === 2, "fresh refresh held");
    heldRefreshes[0]({ nodes: [{ ...hybrid.root!.children[0], text: "迟到旧文字" }], failures: [] });
    await tick(); await tick();
    check(host.querySelector<HTMLButtonElement>(".inspector-image-refresh")?.disabled && !host.textContent?.includes("迟到旧文字"), "old finally cleared fresh busy state or replaced the new tree");
    heldRefreshes[1]({ nodes: [{ ...hybrid.root!.children[0], text: "新的刷新结果", attributes: { ...hybrid.root!.children[0].attributes, "debug-name": "新的刷新结果" } }], failures: [] });
    await until(() => host.querySelector(".inspector-node-heading h4")?.textContent === "新的刷新结果", "fresh result");
    click(".inspector-image-refresh");
    await until(() => heldRefreshes.length === 3, "home refresh held");
    sendMenu({ type: "home" });
    check(cancelled.includes(requests[9].id), "home did not cancel live refresh");
    heldRefreshes[2]({ nodes: [{ ...hybrid.root!.children[0], text: "首页迟到文字" }], failures: [] });
    await tick(); await tick();
    check(!host.querySelector(".layer-scene") && !host.querySelector(".floating-inspector") && !host.textContent?.includes("首页迟到文字"), "late refresh restored the old workbench after home");
    holdViewRefresh = false;
    sendMenu({ type: "capture" });
    const failureIndex = requests.length - 1;
    const startupError = "前台 App 在 18 秒内未准备好控件树和焦点窗口：控件树读取超过剩余就绪预算";
    requests[failureIndex].resolve({ ...snapshot("b", 0), root: null, error: startupError,
      captureReadiness: { budgetMs: 18000, elapsedMs: 18000, phase: "tree", firstFocusedWindowMs: 14000,
        focus: { component: "sample/.Main", activityRecordId: "abc", windowId: "def" }, treeReadCount: 1,
        treeReads: [{ startedMs: 14000, endedMs: 18000 }], rejection: startupError } });
    await until(() => stageText() === "控件树读取超时", "startup failure feedback");
    check(host.textContent?.includes("首次确认窗口 14.00 秒") && host.textContent?.includes("最近读树 4.00 秒"), "readiness times missing");
    check(host.querySelector(".capture-failure-history")?.textContent?.includes(startupError), "failure record missing");
    await (window as unknown as { captureFeedbackCheckpoint?: () => Promise<void> }).captureFeedbackCheckpoint?.();
    const beforeRetry = requests.length;
    await tick(); await tick();
    check(requests.length === beforeRetry, "failure triggered an automatic request");
    click(".capture-retry");
    check(requests.length === beforeRetry + 1 && !host.querySelector(".capture-retry"), "manual retry did not issue exactly one request");
    requests.at(-1)!.resolve({ ...snapshot("b", 67), screenshotDataUrl: new URL("../tests/fixtures/visual-screen.svg", window.location.href).href });
    await until(() => host.querySelector(".snapshot-summary")?.textContent?.startsWith("67 nodes") === true, "recovery after startup failure");
    check(!host.querySelector(".capture-failure-feedback") && host.querySelector(".capture-failure-history")?.textContent?.includes(startupError), "success hid or erased failure history");
    sendMenu({ type: "save" });
    await until(() => host.querySelector(".snapshot-history-item")?.textContent?.includes("67 nodes") === true, "saved recovery snapshot");
    click(".snapshot-history-item");
    check(!host.querySelector(".capture-failure-feedback") && host.querySelector(".capture-failure-history")?.textContent?.includes(startupError), "history switch restored error or erased failure record");
    await until(() => Boolean(host.querySelector(".canvas-operation-status small")), "history screenshot decoded");
    check(host.querySelector<HTMLElement>(".canvas-operation-status small")?.title.includes((latestSave as SaveSnapshotRequest | null)?.capturedAt ?? "missing capture time"), "history view lost its actual capture time");
    sendMenu({ type: "capture" });
    const helperRoot = makeNode("0"), helperInput = makeNode("0/0");
    helperRoot.children = [helperInput]; helperRoot.attributes = { "inspection-source": "accessibility-helper" };
    helperInput.text = null; helperInput.contentDesc = null; helperInput.resourceId = "example:id/account_input";
    helperInput.attributes = { "inspection-source": "accessibility-helper", hint: "Account name", error: "Account is required", "state-description": "Paused" };
    requests.at(-1)!.resolve({ ...snapshot("b", 2), root: helperRoot, inspectionSource: "accessibility-helper", captureMode: "fast" });
    await until(() => host.querySelector(".snapshot-summary")?.textContent?.includes("无障碍 Helper") === true, "Helper source");
    click('.tree-row[data-tree-id="0/0"]');
    check(host.querySelector(".inspector-type > summary small")?.textContent === "无障碍 Helper", "Helper node source missing");
    check(!host.querySelector(".layer-scene") && !host.querySelector(".inspector-image-refresh"), "Helper semantic snapshot offered independent layer controls");
    const identity = host.querySelector<HTMLElement>(".inspector-identity")!;
    check(!host.querySelector(".inspector-summary-text") && ![...identity.querySelectorAll("dt")].some(row => row.textContent === "文本"), "Helper hint was relabeled as captured text");
    check(identity.textContent?.includes("Account name") && identity.textContent.includes("Account is required") && identity.textContent.includes("Paused"), "Helper semantics missing");
    click('button[aria-label="复制提示"]');
    await until(() => copied.includes("Account name"), "Helper semantic copy");
    const helperSearch = host.querySelector<HTMLInputElement>('.inspector-search input')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(helperSearch, "Paused");
      helperSearch.dispatchEvent(new Event("input", { bubbles: true }));
    });
    check(!host.querySelector<HTMLDetailsElement>(".inspector-type")?.hidden && host.querySelector<HTMLDetailsElement>(".inspector-identity")?.open, "semantic search did not reveal its group");
    sendMenu({ type: "capture" });
    requests.at(-1)!.resolve({ ...snapshot("b", 1), inspectionSource: "uiautomator", captureMode: "fast", hierarchyDumpMode: "full" });
    await until(() => host.querySelector(".snapshot-summary")?.textContent?.includes("完整 hierarchy") === true, "return from Helper");
    check(!host.textContent?.includes("Account name") && !host.textContent?.includes("Paused") && !host.querySelector('.tree-row[data-tree-id="0/0"]'), "source switch retained old Helper selection or semantics");
    sendMenu({ type: "capture" });
    const cancelledIndex = requests.length - 1;
    click(".inspector-state-pane .tree-clear");
    check(stageText() === "采集已取消" && !host.querySelector(".capture-failure-timing"), "cancel reused old diagnostic timing");
    requests[cancelledIndex].resolve({ ...snapshot("b", 99), error: "迟到的失败" });
    await tick(); await tick();
    check(stageText() === "采集已取消" && !host.textContent?.includes("迟到的失败"), "cancelled result changed feedback/history");

    sendMenu({ type: "home" });
    const imageCanvas = document.createElement("canvas"); imageCanvas.width = 360; imageCanvas.height = 640;
    imageCanvas.getContext("2d")!.fillRect(0, 0, 360, 640);
    const png = imageCanvas.toDataURL("image/png");
    const portable: UiSnapshot = { ...qml, serial: "offline-file", root: { ...qml.root!, children: [
      { ...qml.root!.children[0], children: [], text: "离线文件节点", debugMetadata: structuredClone(businessMetadataFixture) },
      { ...makeNode("0/1"), text: "业务信息达到额度", debugMetadata: { version: 1, source: "debug-sdk-explicit", status: "omitted-budget", groups: [] } },
    ] }, nodeCount: 3,
      screenshotDataUrl: png, rawXml: "<hierarchy/>", xmlSize: 12, captureTimings: { tree: 4 },
      layerGroupImages: [{ nodeId: "0", image: { dataUrl: png, size: { width: 360, height: 640 }, capturedAt: "2026-10-11T00:00:00.000Z" } }] };
    const imported = (value = portable): ImportSnapshotFileResult => ({ canceled: false, filePath: "/tmp/offline-snapshot.json", data: parseSnapshotFile(JSON.parse(serializeSnapshotFile(value))), error: null });
    const deviceCallsBeforeFile = requests.length, groupCallsBeforeFile = groupCalls.length, styleCallsBeforeFile = styleCalls;
    click('[data-command="open-snapshot"]');
    sendMenu({ type: "open-snapshot" });
    check(fileImports.length === 1 && (menuState as AppMenuState | null)?.openingSnapshot, "pending file selection allowed another import");
    fileImports[0].resolve(imported());
    await until(() => host.textContent?.includes("正在查看离线快照") === true, "offline file import");
    await until(() => Boolean(host.querySelector(".canvas-operation-status small")), "offline screenshot decoded");
    check(host.querySelector(".canvas-operation-status small")?.textContent === "采集时间未记录", "offline import treated file export time as capture time");
    check(requests.length === deviceCallsBeforeFile && groupCalls.length === groupCallsBeforeFile && styleCalls === styleCallsBeforeFile, "opening a file made a device request");
    check(!host.querySelector(".inspector-image-refresh") && !host.querySelector(".inspector-style-read"), "offline file offered live View reads");
    click('.tree-row[data-tree-id="0/0"]');
    check(host.querySelector(".inspector-node-heading h4")?.textContent === "离线文件节点", "offline tree selection did not reach properties");
    check(host.querySelector(".inspector-business")?.textContent?.includes("SampleCard"), "offline file lost registered business values");
    click('.tree-row[data-tree-id="0/1"]');
    check(host.querySelector(".inspector-business")?.textContent?.includes("未保存具体值") && !host.querySelector("[data-debug-field]"), "budget omission invented or inherited business values");
    click('.tree-row[data-tree-id="0/0"]');
    await until(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.disabled === false, "offline screenshot decode");
    click(".view-mode-toggle button:last-child");
    sendMenu({ type: "collapse-all" });
    await until(() => host.querySelector(".layer-scene")?.getAttribute("data-layer-root-composite") === "true", "saved native group missing");
    check(host.querySelector(".layer-resource-note")?.textContent?.includes("已保存"), "saved group was described as a live capture");
    sendMenu({ type: "expand-all" }); sendMenu({ type: "collapse-all" });
    await until(() => host.querySelector(".layer-scene")?.getAttribute("data-layer-root-composite") === "true", "saved group lost after expanding");
    check(groupCalls.length === groupCallsBeforeFile, "offline folding tried to recapture a group");
    click('.tree-row[data-tree-id="0"]');
    flushSync(() => { const scope = host.querySelector<HTMLSelectElement>('[aria-label="控件图片范围"]')!; scope.value = "branch"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
    click(".node-image-copy");
    await until(() => document.querySelector("body > .node-image-action-feedback .node-image-output-status")?.textContent?.includes("已复制图片") === true, "offline native group copy");
    check(imageOutputs.at(-1)?.action === "copy" && imageOutputs.at(-1)?.dataUrl === png && imageOutputs.at(-1)?.defaultFileName.includes("native-group"), "offline copy changed saved group or hid its provenance");
    check(requests.length === deviceCallsBeforeFile && groupCalls.length === groupCallsBeforeFile && styleCalls === styleCallsBeforeFile, "offline image output requested device data");
    sendMenu({ type: "expand-all" }); click('.tree-row[data-tree-id="0/0"]'); sendMenu({ type: "collapse-all" });
    flushSync(() => { const scope = host.querySelector<HTMLSelectElement>('[aria-label="控件图片范围"]')!; scope.value = "own"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
    check(host.querySelector<HTMLButtonElement>(".node-image-output-buttons button:first-child")?.disabled && host.querySelector(".node-image-output-source")?.getAttribute("data-image-source") === "unavailable", "missing offline own bitmap became actionable");
    sendMenu({ type: "save" });
    await until(() => latestSave?.snapshot.serial === "offline-file", "offline snapshot save");
    check((latestSave as SaveSnapshotRequest | null)?.snapshot.layerGroupImages?.[0].image.dataUrl === png, "saved history lost the imported group pixels");
    sendMenu({ type: "export-snapshot" });
    await until(() => fileExports.some(file => file.format === "snapshot"), "complete snapshot export");
    check(JSON.stringify(parseSnapshotFile(JSON.parse(fileExports.at(-1)!.data)).snapshot) === JSON.stringify(portable), "complete export changed snapshot metadata or pixels");
    check(requests.length === deviceCallsBeforeFile && groupCalls.length === groupCallsBeforeFile, "saving/exporting an offline file requested device data");
    sendMenu({ type: "open-snapshot" });
    fileImports.at(-1)!.resolve({ canceled: false, filePath: null, data: null, error: "快照文件版本不受支持" });
    await until(() => Boolean(host.querySelector('.snapshot-file-status[role="alert"]')), "invalid file feedback");
    check(host.querySelector(".inspector-node-heading h4")?.textContent === "离线文件节点" && host.querySelector(".layer-scene")?.getAttribute("data-layer-root-composite") === "true", "invalid file replaced the current tree or its folded image");
    const importsBeforeCancel = fileImports.length;
    click('[data-command="open-snapshot"]');
    check(fileImports.length === importsBeforeCancel + 1, "cancel scenario did not start a fresh file import");
    const cancelImport = fileImports.at(-1)!;
    await tick();
    cancelImport.resolve({ canceled: true, filePath: null, data: null, error: null });
    await until(() => !menuState?.openingSnapshot && !host.querySelector(".snapshot-file-status"), "cancelled file import");
    check(!host.querySelector(".snapshot-file-status") && host.querySelector(".inspector-node-heading h4")?.textContent === "离线文件节点" && host.querySelector(".layer-scene")?.getAttribute("data-layer-root-composite") === "true", "cancel lost the tree or retained a stale wait");
    click('[data-command="open-snapshot"]');
    sendMenu({ type: "home" });
    fileImports.at(-1)!.resolve(imported({ ...portable, serial: "late-file" }));
    await tick();
    await until(() => !menuState?.openingSnapshot, "late file import");
    check(!host.querySelector(".app-shell.inspection-active") && !host.querySelector(".snapshot-file-status"), "late file restored the workspace after returning home");
    click('[data-command="open-snapshot"]');
    sendMenu({ type: "capture" });
    const unmountIndex = requests.length - 1;
    flushSync(() => root.unmount()); mounted = false;
    check(cancelled.includes(requests[unmountIndex].id) && progress === null && menuAction === null, "unmount did not release capture and listeners");
    requests[unmountIndex].resolve(snapshot("b", 66));
    fileImports.at(-1)!.resolve(imported());
    await tick();
    return { focus, treeRound3, treePresentation, inspectorReference, inspectorLayout, appearance, compactInspector, treeSearchSuggestions, groupPreferences, propertySearch, nodeNavigation, layoutRelations, structuredValues, lookinMigration, checks: ["control PNG output: live cached native group updates properties; offline copy preserves saved pixels; missing own image disabled; no extra device/group/style reads", "folded image provenance: pending local pixels, live group success, null fallback, single request and expanded DDMS own", "rounded child textures inherit known ancestor outlines; folded composite matches pixel mask", "stage and cancel", "early tree/image preview preserves selection and 3D mode; incomplete snapshots cannot be saved", "capture warning: dismiss, focus, reclaimed space, long text, retained diagnostic, new capture reset and successful capture clears", "device switch ignores stale progress/failure", "sidebar: no heading, pointer/keyboard width, min/max, reset and cancelled drag", "native menu: capture guard, state sync, search, expand/collapse, home and cleanup", "Qt groups: fold uses live group, expand drops child pixels, and late image cannot enter a new capture", "native View: rapid clicks send one refresh; single and branch refresh preserve selection, scene, children and partial failures", "hybrid View: folded group recaptures after child refresh without showing stale pixels", "floating inspector: drag, keyboard, resize bounds, collapse, close, restore and copy", "inspector groups: native disclosure, name/value search, empty/clear/Escape, retained collapse state, read-only geometry and honest View/QML/unknown source", "node identity: text/description/resource/type priority, full class, parent/root, long names at 300/248px", "SDK business info: typed groups, source, zero/false/empty copy, search/disclosure, 300/248px, cleared refresh, offline persistence and budget omission", "box model: four-side placement at 300/248px, zero/partial/invalid padding, missing bounds and confirmed/ambiguous border", "Helper: separate text/hint/error/state, source, read-only layers, semantic copy/search and switching clears selection", "return home ignores late result", "unmount cancels and unsubscribes"] };
  } finally {
    if (mounted) flushSync(() => root.unmount());
    window.electronApi = previousApi;
    host.remove();
  }
}

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { parseSnapshotFile, serializeSnapshotFile } from "../shared/snapshot-file";
import type { LayerMenuAction, UiNode, UiSnapshot } from "../shared/types";
import { TREE_COLLAPSE_STORAGE_KEY } from "../shared/tree-collapse";
import { CONTEXT_HINT_STORAGE_KEY } from "../shared/context-hints";
import { makeNode } from "./fixtures";

/** The actual App must connect independent modules without losing navigation or field identity. */
export async function verifyLookinMigrationIntegration({ quickSelect = false }: { quickSelect?: boolean } = {}) {
  const oldApi = window.electronApi;
  const oldScroll = { x: window.scrollX, y: window.scrollY };
  const storage = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!; return [key, localStorage.getItem(key)!] as const;
  });
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;z-index:100;"; document.body.append(host);
  const renderer = createRoot(host);
  const copies: string[] = [], reads: string[] = [], checks: string[] = [];
  let captures = 0, nextLayerAction: LayerMenuAction = null;
  const act = (fn: () => void) => flushSync(fn);
  function check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(`Lookin migration integration: ${message}`);
  }
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const checkpoint = async (name: string) => {
    const capture = (window as typeof window & { lookinMigrationVisualCheckpoint?: (name: string) => Promise<void> }).lookinMigrationVisualCheckpoint;
    if (capture) await capture(name);
  };
  const until = async (fn: () => boolean, label: string) => {
    const deadline = performance.now() + 5000;
    while (!fn()) {
      check(performance.now() < deadline, `timeout: ${label}; ${JSON.stringify({
        scene: host.querySelector<HTMLElement>(".layer-scene")?.dataset,
        canvas: host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")?.dataset,
      })}`);
      await tick();
    }
  };
  const source: UiNode = { ...makeNode("layout-source", 1), className: "com.example.PriceLabel", text: "布局与业务样例", contentDesc: null,
    resourceId: "com.example.benchmark:id/source", attributes: {
      "sdk-class-hierarchy": "com.example.PriceLabel → android.widget.TextView → android.view.View",
      "sdk-layout-rules": JSON.stringify({ type: "RelativeLayout", rules: {
        below: "com.example.benchmark:id/anchor_a", above: "com.example.benchmark:id/anchor_b",
      } }),
    }, debugMetadata: { version: 2, source: "debug-sdk-explicit", status: "captured", groups: [{
      key: "runtime", label: "运行状态", fields: [{ key: "details", label: "详情", type: "tree", value: [{
        key: "flags", label: "开关与计数", type: "null", value: null, children: [
          { key: "enabled", label: "已启用", type: "boolean", value: false, children: [] },
          { key: "count", label: "计数", type: "number", value: 0, children: [] },
          { key: "text", label: "完整文字", type: "string", value: "  保留空格  ", children: [] },
        ],
      }] }],
    }] } };
  const first = { ...makeNode("anchor-a", 2), text: "目标甲", contentDesc: null, resourceId: "com.example.benchmark:id/anchor_a" };
  const second = { ...makeNode("anchor-b", 3), text: "目标乙", contentDesc: null, resourceId: "com.example.benchmark:id/anchor_b" };
  const root = { ...makeNode("layout-parent"), className: "android.widget.RelativeLayout", text: "样例父容器", children: [source, first, second] };
  const paint = (node: UiNode, top: number, height: number, color: string) => {
    const canvas = document.createElement("canvas"); canvas.width = 360; canvas.height = height;
    canvas.getContext("2d")!.fillStyle = color; canvas.getContext("2d")!.fillRect(0, 0, 360, height);
    node.bounds = { left: 0, top, right: 360, bottom: top + height, raw: `[0,${top}][360,${top + height}]` };
    node.layerImageDataUrl = canvas.toDataURL("image/png"); node.layerImageSize = { width: 360, height };
    canvas.width = canvas.height = 0;
  };
  paint(root, 0, 240, "#18222f"); paint(source, 40, 50, "#d79655");
  paint(first, 105, 40, "#305d48"); paint(second, 160, 50, "#345c86");
  const deepNodes = Array.from({ length: 5 }, (_, index) => ({ ...makeNode(`deep-${index}`, index),
    text: index === 4 ? "深层目标" : `路径 ${index + 1}`, contentDesc: null, className: "android.widget.FrameLayout",
    attributes: { "inspection-source": "debug-view" }, children: [] as UiNode[] }));
  deepNodes.forEach((item, index) => {
    paint(item, 215, 20, "#3d4c61");
    if (index < deepNodes.length - 1) item.children = [deepNodes[index + 1]];
  });
  const empty: UiNode = { ...makeNode("status-empty", 4), text: "自身空画面", layerImageStatus: "captured", layerImageEmpty: true,
    attributes: { "inspection-source": "debug-view" } };
  const failed: UiNode = { ...makeNode("status-failed", 5), text: "采集失败样例", layerImageStatus: "failed",
    attributes: { "inspection-source": "debug-view", "image-capture-error": "synthetic capture failure" } };
  const invisible: UiNode = { ...makeNode("status-invisible", 6), text: "设备不可见样例", visibleToUser: false,
    attributes: { "inspection-source": "debug-view" } };
  root.children.push(deepNodes[0], empty, failed, invisible);
  const fixture: UiSnapshot = { serial: "lookin-migration-fixture", root, nodeCount: 12, xmlSize: 0, rawXml: null,
    screenshotDataUrl: root.layerImageDataUrl!, warning: null, error: null, captureMode: "deep", inspectionSource: "debug-view" };
  window.electronApi = {
    runtime: { sandboxed: true, contextIsolated: true },
    probeAdb: async () => ({ adbPath: "fixture", adbVersion: "fixture", error: null,
      devices: [{ serial: fixture.serial, state: "device", model: "fixture", androidVersion: "15", product: null, transportId: null }] }),
    inspectDevice: async () => { captures++; return structuredClone(fixture); },
    onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {}, cancelInspection: async () => {},
    showLayerMenu: async () => { const action = nextLayerAction; nextLayerAction = null; return action; },
    captureGroup: async () => { reads.push("group"); throw new Error("Unexpected group read"); },
    readViewStyle: async () => { reads.push("style"); throw new Error("Unexpected style read"); },
    refreshViewNode: async () => { reads.push("refresh"); throw new Error("Unexpected refresh"); },
    copyText: async value => { copies.push(value); },
    loadSnapshots: async () => ({ snapshots: [], error: null }), saveSnapshot: async () => ({ snapshots: [], error: null }),
    clearSnapshots: async () => ({ snapshots: [], error: null }),
    exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }),
  };
  const panel = () => host.querySelector<HTMLElement>(".floating-inspector")!;
  const selected = () => host.querySelector<HTMLElement>('.tree-row[aria-selected="true"]')?.dataset.treeId;
  const click = (selector: string) => {
    const control = host.querySelector<HTMLElement>(selector);
    check(control && !(control instanceof HTMLButtonElement && control.disabled), `missing control: ${selector}`);
    act(() => control.click());
  };
  const search = (value: string, selector = ".inspector-search input") => {
    const input = host.querySelector<HTMLInputElement>(selector)!;
    check(input, `search input unavailable: ${selector}`);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const openAncestors = (element: Element) => {
    const details: HTMLDetailsElement[] = [];
    for (let parent = element.parentElement; parent && parent !== panel(); parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) details.unshift(parent);
    for (const item of details) if (!item.open) act(() => item.querySelector<HTMLElement>(":scope > summary")!.click());
  };
  const layerAction = async (id: string, action: LayerMenuAction) => {
    const row = host.querySelector<HTMLElement>(`[data-tree-id="${id}"]`);
    check(row, `layer action row missing: ${id}`); nextLayerAction = action;
    act(() => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await tick();
  };
  try {
    localStorage.clear();
    act(() => renderer.render(<App />));
    await until(() => Boolean(host.querySelector<HTMLButtonElement>(".capture-button") && !host.querySelector<HTMLButtonElement>(".capture-button")!.disabled), "App ready");
    click(".capture-button");
    await until(() => Boolean(host.querySelector('[data-tree-id="layout-source"]')), "capture");
    check(host.querySelector('[data-tree-id="layout-source"]')?.getAttribute("data-tree-kind") === "text"
      && host.querySelector('[data-tree-id="layout-source"]')?.getAttribute("title")?.includes("com.example.PriceLabel"),
    "inherited type icon changed or hid the real custom class");
    checks.push("actual App: inherited Android icon keeps the real custom class and display name");
    click('[data-tree-id="layout-source"]');
    const collapseSetting = localStorage.getItem(TREE_COLLAPSE_STORAGE_KEY);
    click('[data-expansion-preset="4"]');
    check(host.querySelector('[data-tree-id="deep-2"]') && !host.querySelector('[data-tree-id="deep-3"]'), "four-level preset used the wrong root depth");
    click('[data-expansion-preset="2"]');
    check(host.querySelector('[data-tree-id="deep-0"]') && !host.querySelector('[data-tree-id="deep-1"]'), "two-level preset did not fold deeper nodes");
    click('[data-expansion-preset="all"]'); click('[data-tree-id="deep-4"]');
    click('[data-expansion-preset="2"]');
    check(selected() === "deep-4" && host.querySelector('[data-tree-id="deep-4"]'), "preset concealed the selected deep path");
    search("深层目标", ".tree-search");
    check([...host.querySelectorAll<HTMLButtonElement>('[data-expansion-preset]')].every(button => button.disabled), "filter left presets enabled");
    search("", ".tree-search");
    check(localStorage.getItem(TREE_COLLAPSE_STORAGE_KEY) === collapseSetting, "one-off expansion changed the default preference");
    checks.push("actual App: expansion presets retain deep selection, disable under filtering and preserve defaults");
    click('[data-tree-id="layout-source"]');
    const rowsBeforeFocus = [...host.querySelectorAll<HTMLElement>(".tree-row")].map(row => row.dataset.treeId);
    await layerAction("deep-0", "focus-branch");
    await until(() => Boolean(host.querySelector('[data-context-hint="layer-focus"][data-context-hint-visible="true"]')), "related focus hint");
    check(!host.querySelector(".context-hint")?.contains(document.activeElement), "hint stole keyboard focus");
    await checkpoint("context-hint");
    const dismissFocusHint = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => host.querySelector(".screenshot-frame")!.dispatchEvent(dismissFocusHint));
    check(dismissFocusHint.defaultPrevented && host.querySelector(".tree-focus-bar")
      && host.querySelector(".layer-webgl-canvas") && !host.querySelector(".context-hint"), "Escape also exited focus or 3D");
    click('[aria-label="设置属性分组"]');
    click(".preferences-context-hints .preferences-actions button");
    click(".preferences-panel .entry-dialog-close");
    await tick(); check(!host.querySelector(".context-hint"), "reset replayed a hint without a new related action");
    click(".tree-focus-exit"); await layerAction("deep-0", "focus-branch");
    await until(() => Boolean(host.querySelector('[data-context-hint="layer-focus"][data-context-hint-visible="true"]')), "reset related hint");
    click(".tree-focus-exit"); await tick();
    check(!host.querySelector(".context-hint") && !JSON.parse(localStorage.getItem(CONTEXT_HINT_STORAGE_KEY)!).acknowledged.length,
      "operation exit kept a stale hint or falsely acknowledged it");
    await layerAction("deep-0", "focus-branch"); await tick(); await tick();
    check(!host.querySelector(".context-hint"), "automatic clearing reset the session display budget");
    checks.push("actual App: contextual hint stays in flow, Escape preserves focus/3D, preference reset waits for another related action; operation exit withdraws without acknowledgement or budget reset");
    click('[data-expansion-preset="2"]');
    check(host.querySelector('[data-tree-id="deep-1"]') && !host.querySelector('[data-tree-id="deep-2"]')
      && !host.querySelector('[data-tree-id="layout-source"]'), "focused preset used the full snapshot root");
    click(".tree-focus-exit");
    check(selected() === source.id && JSON.stringify([...host.querySelectorAll<HTMLElement>(".tree-row")].map(row => row.dataset.treeId)) === JSON.stringify(rowsBeforeFocus), "focus exit lost the original expansion or selection");
    checks.push("actual App: focused expansion is relative and exit restores original selection and disclosure");
    for (const [id, code] of [["status-empty", "empty"], ["status-failed", "failed"], ["status-invisible", "device-hidden"]]) {
      check(host.querySelector(`[data-tree-id="${id}"] [data-node-status="${code}"]`), `missing tree status: ${code}`);
      click(`[data-tree-id="${id}"]`);
      check(panel().querySelector(`.node-presentation-status [data-node-status="${code}"]`), `inspector disagrees with tree: ${code}`);
    }
    check(panel().textContent?.includes("设备报告此控件不可见"), "device invisibility was mislabeled");
    await layerAction("deep-0", "hide");
    click('[data-tree-id="deep-0"]');
    check(host.querySelector('[data-tree-id="deep-0"] [data-node-status="user-hidden"]')
      && panel().querySelector('[data-node-status="user-hidden"]')
      && !host.querySelector('[data-tree-id="deep-1"] [data-node-status="user-hidden"]'), "manual plane hide spread to a child or lost the inspector fact");
    search("已隐藏");
    await until(() => Boolean(panel().querySelector(".inspector-search-result")), "hidden status search");
    search(""); await layerAction("deep-0", "restore");
    check(!host.querySelector('[data-node-status="user-hidden"]'), "restore retained a stale hidden status");
    click('[data-tree-id="status-failed"]'); await checkpoint("node-status");
    checks.push("actual App: tree and searchable inspector distinguish empty, failed, invisible and manual single-plane hide");
    click('[data-tree-id="layout-source"]');
    search("目标甲");
    const layoutResult = [...panel().querySelectorAll<HTMLButtonElement>(".inspector-search-result")]
      .find(control => control.querySelector("strong")?.textContent === "位于目标下方");
    check(layoutResult, "displayed layout target name was lost from the App search index");
    act(() => layoutResult.click());
    await until(() => panel().querySelector<HTMLElement>(".inspector-property-highlight")?.dataset.layoutRule === "below", "layout result location");
    search("");
    for (const [rule, target] of [["below", "anchor-a"], ["above", "anchor-b"]]) {
      click('[data-tree-id="layout-source"]');
      const link = panel().querySelector<HTMLElement>(`[data-layout-rule="${rule}"] .inspector-layout-target`);
      check(link, `relation ${rule} is not connected`); openAncestors(link);
      search("布局与业务样例", ".tree-search");
      act(() => link.click()); await tick();
      check(selected() === target && host.querySelector<HTMLInputElement>(".tree-search")!.value === "", `wrong relation target: ${rule}`);
    }
    checks.push("actual App: distinct layout targets navigate through shared handler and clear filters");

    click('[data-tree-id="layout-source"]');
    const branch = panel().querySelector<HTMLDetailsElement>('[data-debug-path="runtime/details/flags"]');
    check(branch, "structured SDK fields are not connected");
    openAncestors(branch); if (branch.open) act(() => branch.querySelector<HTMLElement>(":scope > summary")!.click());
    check(!branch.open, "normal tree state could not be folded");
    search("runtime/details/flags/enabled");
    await until(() => branch.open && Boolean(panel().querySelector(".inspector-search-results")), "path search");
    check(!panel().querySelector<HTMLDetailsElement>(".inspector-business-group")!.hidden, "full path search hid the containing business group");
    const leaf = panel().querySelector<HTMLElement>('[data-debug-path="runtime/details/flags/enabled"]');
    check(leaf?.dataset.inspectorValue === "false", "false leaf was lost or coerced");
    act(() => branch.querySelector<HTMLElement>(":scope > summary")!.click());
    check(!branch.open, "search disclosure could not be temporarily folded");
    const leafResult = [...panel().querySelectorAll<HTMLButtonElement>(".inspector-search-result")]
      .find(control => control.dataset.searchResult === leaf.dataset.inspectorProperty);
    check(leafResult, "concrete business leaf result missing");
    act(() => leafResult.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await until(() => branch.open && leaf.classList.contains("inspector-property-highlight"), "exact business leaf location");
    check(selected() === source.id, "property result changed the selected node");
    search(""); await tick(); check(!branch.open, "clearing search lost normal folded state");
    checks.push("actual App: full business path search reveals field and restores normal disclosure state");

    for (const width of [300, 248]) {
      panel().style.width = `${width}px`; await tick();
      check(panel().querySelector<HTMLElement>(".inspector-body")!.scrollWidth <= panel().clientWidth + 1, `business tree overflows ${width}px inspector`);
    }
    panel().style.removeProperty("width");
    click('[aria-label="复制运行状态·详情"]'); await tick();
    check(JSON.stringify(JSON.parse(copies.at(-1)!)) === JSON.stringify(source.debugMetadata!.groups[0].fields[0].value), "tree copy lost typed nested values");
    checks.push("actual App: typed full-tree copy and 300/248px inspector bounds");

    const serialized = serializeSnapshotFile(fixture, "2026-10-11T00:00:00.000Z");
    check(JSON.parse(serialized).version === 2, "v2 business data used the legacy file format");
    const reopened = parseSnapshotFile(JSON.parse(serialized)).snapshot;
    check(JSON.stringify(reopened.root?.children[0].debugMetadata) === JSON.stringify(source.debugMetadata), "file round trip changed business data");
    checks.push("new snapshot format retains structured types on reopen");
    await checkpoint("inspector");

    click('[data-tree-id="layout-source"]');
    const previewControl = panel().querySelector<HTMLButtonElement>(".node-image-preview-open");
    check(previewControl && !previewControl.disabled, "cached preview incorrectly required output IPC");
    openAncestors(previewControl);
    act(() => previewControl.focus({ preventScroll: true }));
    click(".node-image-preview-open");
    await until(() => Boolean(host.querySelector<HTMLImageElement>(".node-image-preview-image")?.naturalWidth), "cached own preview");
    const previewImage = host.querySelector<HTMLImageElement>(".node-image-preview-image")!;
    check(previewImage.naturalWidth === 360 && previewImage.naturalHeight === 50
      && previewImage.src === source.layerImageDataUrl
      && host.querySelector('.node-image-preview [data-image-source="own"]'), "preview changed original pixels or image source");
    click(".node-image-preview-pixels");
    check(host.querySelector('.node-image-preview-content[data-preview-mode="pixels"][data-preview-zoom="1"]'), "100% did not use original pixel size");
    click('[aria-label="放大预览图片"]');
    check(Number(host.querySelector<HTMLElement>(".node-image-preview-content")?.dataset.previewZoom) > 1, "preview zoom did not update");
    click(".node-image-preview-fit");
    await tick(); await checkpoint("image-preview");
    click('.node-image-preview [aria-label="关闭控件图片预览"]');
    await tick();
    check(!host.querySelector(".node-image-preview") && document.activeElement === previewControl,
      "closing the preview did not release it or restore the trigger focus");
    checks.push("actual App: cached image preview works without output IPC, preserves own pixels/dimensions, fit/100%/zoom and restores focus");

    if (quickSelect) {
      // Leave room for the existing quick-selection tool in a narrow window;
      // restore the inspector before testing its measurement replacement.
      const collapsedForSpace = window.innerWidth < 800;
      if (collapsedForSpace) click(".inspector-collapse");
      const modes = host.querySelectorAll<HTMLButtonElement>(".view-mode-toggle button");
      check(modes.length === 2, "preview toolbar unavailable"); act(() => modes[1].click());
      await layerAction(root.id, "expand");
      click(".layer-settings summary");
      const invisibleOption = host.querySelector<HTMLInputElement>('[aria-label="显示不可见控件边界"]')!;
      check(invisibleOption && !invisibleOption.checked && !host.querySelector('[data-layer-node-id="status-invisible"]'), "invisible boundaries were enabled by default");
      act(() => invisibleOption.click());
      await until(() => host.querySelector<HTMLElement>('[data-layer-node-id="status-invisible"]')?.dataset.layerDeviceInvisible === "true", "invisible boundary");
      check(host.querySelector<HTMLElement>('[data-layer-node-id="status-invisible"]')?.dataset.layerTexture === "false", "invisible boundary fabricated a screenshot");
      click('[data-tree-id="status-invisible"]');
      await checkpoint("inspection-invisible-settings");
      click(".layer-settings summary");
      await checkpoint("inspection-invisible");
      click(".layer-settings summary");
      act(() => invisibleOption.click());
      await until(() => !host.querySelector('[data-layer-node-id="status-invisible"]'), "invisible boundary off");
      check(selected() === invisible.id, "turning off boundaries changed the tree selection");
      click(".layer-settings summary");
      checks.push("actual App: opt-in invisible boundaries and property inspection; no fabricated images or selection changes");
      click(".tree-collapse-all");
      await until(() => {
        const canvas = host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas");
      return canvas?.dataset.layerRenderer === "webgl" && Number(host.querySelector<HTMLElement>(".layer-scene")?.dataset.layerCompositeCount) > 0
        && Number(canvas.dataset.layerTextureCount) > 0 && canvas.dataset.layerAnimationProgress === "1" && canvas.dataset.layerTexturePendingCount === "0";
      }, "actual App folded composite");
      await tick(); await tick();
      check(!host.querySelector(".context-hint"), "another hint appeared in the same session");
      const checkQuickPanel = () => {
        const dialog = host.querySelector<HTMLElement>(".quick-select-panel")!;
        const bounds = dialog.getBoundingClientRect(), inspectorBounds = panel().getBoundingClientRect();
        const frame = host.querySelector<HTMLElement>(".screenshot-frame")!;
        const frameBounds = frame.getBoundingClientRect();
        const left = frameBounds.left + frame.clientLeft + Number(frame.dataset.viewportLeft);
        const top = frameBounds.top + frame.clientTop + Number(frame.dataset.viewportTop);
        check(bounds.width > 0 && bounds.height > 0 && bounds.left >= left - 1 && bounds.top >= top - 1
          && bounds.right <= left + Number(frame.dataset.viewportWidth) + 1
          && bounds.bottom <= top + Number(frame.dataset.viewportHeight) + 1, "quick selection leaves the available canvas viewport");
        check(bounds.right <= inspectorBounds.left || bounds.left >= inspectorBounds.right
          || bounds.bottom <= inspectorBounds.top || bounds.top >= inspectorBounds.bottom, "quick selection overlaps the property inspector");
        const close = dialog.querySelector<HTMLButtonElement>(".quick-select-close")!;
        const closeBounds = close.getBoundingClientRect();
        check(close.contains(document.elementFromPoint(closeBounds.left + closeBounds.width / 2, closeBounds.top + closeBounds.height / 2)), "quick selection close control is obscured");
      };
      const canvas = host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
      const rect = canvas.getBoundingClientRect();
      for (let y = 10; y < rect.height; y += 15) {
        if (host.querySelector('[data-quick-select-id="layout-source"]')) break;
        for (let x = 10; x < rect.width; x += 15) {
          const clientX = rect.left + x, clientY = rect.top + y;
          if (host.querySelector(".quick-select-panel")?.contains(document.elementFromPoint(clientX, clientY))) continue;
          act(() => {
            for (const type of ["pointerdown", "pointerup"]) canvas.dispatchEvent(new PointerEvent(type, {
              bubbles: true, pointerId: 88, button: 0, clientX, clientY, pointerType: "mouse", isPrimary: true,
              ...(/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
            }));
          });
          if (host.querySelector('[data-quick-select-id="layout-source"]')) break;
        }
      }
      const candidate = host.querySelector<HTMLButtonElement>('[data-quick-select-id="layout-source"]');
      check(candidate, "actual App did not offer the folded source candidate");
      await tick(); checkQuickPanel();
      const candidateBounds = candidate.getBoundingClientRect();
      check(candidate.contains(document.elementFromPoint(candidateBounds.left + candidateBounds.width / 2, candidateBounds.top + candidateBounds.height / 2)), "quick selection candidate is obscured");
      await checkpoint("quick-select");
      search("目标甲", ".tree-search"); act(() => candidate.click()); await tick();
      check(selected() === source.id && host.querySelector<HTMLInputElement>(".tree-search")!.value === ""
        && !host.querySelector(".quick-select-panel"), "quick confirmation did not navigate, reveal and clear temporary/filter state");
      checks.push("actual App: modifier click directly opens unobscured folded-plane candidates; confirmation reveals ancestors and clears filter/tool state");
      if (collapsedForSpace) click(".inspector-collapse");
      click('[data-tree-id="anchor-a"]');
      await until(() => {
        const canvas = host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas");
        return canvas?.dataset.layerAnimationProgress === "1" && canvas.dataset.layerTexturePendingCount === "0";
      }, "measurement card settled scene");
      const cardFrame = host.querySelector<HTMLElement>(".screenshot-frame")!;
      const cardCanvas = host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
      const canvasBounds = cardCanvas.getBoundingClientRect();
      let foundTarget = false;
      if (collapsedForSpace) {
        act(() => host.querySelector<HTMLElement>('[data-tree-id="anchor-b"]')!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
        await tick();
        foundTarget = host.querySelector<HTMLElement>(".layer-scene")?.dataset.layerHoveredId === second.id;
      }
      for (let y = 12; y < canvasBounds.height && !foundTarget; y += 20) for (let x = 12; x < canvasBounds.width; x += 20) {
        act(() => cardFrame.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, isPrimary: true, pointerType: "mouse",
          pointerId: 89, button: 0, clientX: canvasBounds.left + x, clientY: canvasBounds.top + y })));
        await tick();
        if (host.querySelector<HTMLElement>(".layer-hover-label")?.dataset.nodeId === second.id) { foundTarget = true; break; }
      }
      check(foundTarget, "App could not hover the second measurement endpoint");
      check(!host.querySelector(".layer-measurement, .layer-measurement-status, .measurement-card"), "ordinary App hover displayed automatic measurements");
      click(".pin-layer-measurement");
      await until(() => host.querySelector<HTMLElement>(".measurement-card")?.dataset.measurementMode === "live", "live measurement");
      check(host.querySelector<HTMLElement>(".measurement-card")?.dataset.measurementAnchor === first.id
        && !host.querySelector(".layer-measurement-status"), "live measurement changed selection or pinned implicitly");
      const hoverRow = (id: string) => act(() => host.querySelector<HTMLElement>(`[data-tree-id="${id}"]`)!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      hoverRow(second.id);
      await until(() => host.querySelector<HTMLElement>(".measurement-card")?.dataset.measurementTarget === second.id, "tree hover result");
      await until(() => host.querySelectorAll(".measurement-card image").length === 2, "saved A/B pictures");
      check(selected() === first.id && getComputedStyle(panel()).visibility === "hidden", "tree hover selected B or retained the attribute panel");
      await checkpoint("measurement-live");
      click('[data-measurement-pick="target"]'); await tick();
      await checkpoint("measurement-picking");
      click('[data-tree-id="anchor-b"]');
      await until(() => host.querySelector<HTMLElement>(".measurement-card")?.dataset.measurementTarget === second.id
        && !host.querySelector<HTMLElement>(".measurement-card")?.dataset.measurementPicking, "2D card");
      click('[data-measurement-pick="target"]'); await tick();
      await checkpoint("measurement-reselect");
      click('[data-tree-id="layout-source"]');
      await until(() => host.querySelector<HTMLElement>(".measurement-card")?.dataset.measurementTarget === source.id
        && !host.querySelector<HTMLElement>(".measurement-card")?.dataset.measurementPicking, "reselect B");
      check(host.querySelector<HTMLElement>(".measurement-card")?.dataset.measurementAnchor === first.id
        && host.querySelector<HTMLElement>(".measurement-card")?.dataset.measurementTarget === source.id, "tree reselect B did not retain A");
      click('[data-measurement-pick="target"]'); await tick();
      click('[data-tree-id="anchor-b"]');
      await until(() => host.querySelector<HTMLElement>(".measurement-card")?.dataset.measurementTarget === second.id
        && !host.querySelector<HTMLElement>(".measurement-card")?.dataset.measurementPicking, "restore B");
      checks.push("actual App: selected A and tree-hover B display saved pictures without selecting B; explicit reselect retains A and performs no device read");
      check(!host.querySelector(".context-hint"), "pinned measurement exceeded the session hint budget");
      const card = host.querySelector<HTMLElement>(".measurement-card")!;
      check(card.dataset.measurementAnchor === first.id && card.dataset.measurementTarget === second.id
        && card.querySelector(".measurement-card-values")?.textContent?.replace(/\s/g, "") === "垂直15px", `App card used scene gaps instead of original bounds: ${JSON.stringify({ endpoints: [card.dataset.measurementAnchor, card.dataset.measurementTarget], values: card.querySelector(".measurement-card-values")?.textContent })}`);
      await until(() => Number(cardFrame.dataset.viewportWidth) < cardFrame.clientWidth, "canvas did not reserve measurement panel space");
      check(getComputedStyle(panel()).visibility === "hidden", "measurement result did not replace the inspector");
      const cardBounds = card.getBoundingClientRect(), frameBounds = cardFrame.getBoundingClientRect();
      check(cardBounds.left >= frameBounds.left && cardBounds.right <= frameBounds.right + 1
        && cardBounds.top >= frameBounds.top && cardBounds.bottom <= frameBounds.bottom + 1,
        `measurement panel left the window: ${JSON.stringify({ card: cardBounds.toJSON(), frame: frameBounds.toJSON(), size: [cardFrame.clientWidth, cardFrame.clientHeight], style: card.getAttribute("style") })}`);
      const clear = card.querySelector<HTMLButtonElement>("button")!, clearBounds = clear.getBoundingClientRect();
      check(clear.contains(document.elementFromPoint(clearBounds.left + clearBounds.width / 2, clearBounds.top + clearBounds.height / 2)), "card clear button is obscured");
      await checkpoint("measurement-card");
      const pinnedPreviewControl = panel().querySelector<HTMLButtonElement>(".node-image-preview-open")!;
      openAncestors(pinnedPreviewControl); click(".node-image-preview-open");
      await until(() => Boolean(host.querySelector<HTMLImageElement>(".node-image-preview-image")?.naturalWidth), "pinned pair image preview");
      await checkpoint("image-preview-pinned");
      // Synthetic DOM keys do not perform the native dialog cancel action. The
      // real-window checkpoint sends a native Escape; other runs exercise both
      // the scene key guard and the dialog's explicit cancel callback here.
      const imageDialog = host.querySelector<HTMLDialogElement>(".node-image-preview");
      if (imageDialog) {
        act(() => imageDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
        check(host.querySelector(".measurement-card") && host.querySelector(".layer-webgl-canvas"), "dialog Escape changed the pinned pair or 3D");
        act(() => imageDialog.dispatchEvent(new Event("cancel", { cancelable: true })));
      }
      await tick();
      check(!host.querySelector(".node-image-preview") && host.querySelector(".measurement-card")
        && host.querySelector(".layer-webgl-canvas"), "preview cancellation changed the underlying scene");
      checks.push("actual App: image dialog Escape/cancel preserves the pinned measurement and 3D scene");
      const modifierCanvas = host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!, modifierBounds = modifierCanvas.getBoundingClientRect();
      act(() => {
        for (const type of ["pointerdown", "pointerup"]) modifierCanvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true, pointerId: 99, button: 0, isPrimary: true,
          clientX: modifierBounds.left + Number(modifierCanvas.dataset.layerProbeX), clientY: modifierBounds.top + Number(modifierCanvas.dataset.layerProbeY),
          ...(/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
        }));
      }); await tick();
      check(host.querySelector(".quick-select-panel") && !host.querySelector(".measurement-card"), "quick selection overlaps the fixed measurement card");
      check(getComputedStyle(panel()).visibility === "hidden", "modifier selection restored the inspector over an active measurement");
      click(".quick-select-close"); await tick();
      check(host.querySelector(".measurement-card"), "closing quick selection lost the fixed measurement");
      click(".measurement-card button"); await tick();
      check(!host.querySelector(".measurement-card") && host.querySelector(".layer-webgl-canvas"), "clear did not release the card while preserving 3D");
      check(getComputedStyle(panel()).visibility === "visible", "ending measurement did not restore the inspector");
      checks.push("actual App: measurement replaces and restores inspector, reserves canvas space, yields to quick selection and retains original distances");
    }

    click('[data-tree-id="anchor-a"]');
    check(!panel().querySelector('[data-debug-path]') && !panel().querySelector('[data-layout-rule]'), "changing node kept foreign metadata or layout links");
    if (quickSelect) await until(() => {
      const canvas = host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas");
      return canvas?.dataset.layerTexturePendingCount === "0" && canvas.dataset.layerAnimationProgress === "1";
    }, "settled App navigation textures");
    check(captures === 1 && !reads.length, "read-only navigation/search requested fresh device data");
    checks.push("node switch clears both additions; navigation/search/copy perform zero extra device reads");
    return { checks };
  } finally {
    act(() => renderer.unmount()); host.remove(); window.electronApi = oldApi;
    localStorage.clear(); for (const [key, value] of storage) localStorage.setItem(key, value);
    window.scrollTo(oldScroll.x, oldScroll.y);
  }
}

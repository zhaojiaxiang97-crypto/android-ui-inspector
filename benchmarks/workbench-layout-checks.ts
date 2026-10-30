// Source UI checks only. All data and interactions stay in the local fixture.
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector); assert(result, `Missing ${selector}`); return result;
}
function rect(selector: string) {
  const { left, top, width, height, right, bottom } = element(selector).getBoundingClientRect();
  return { left, top, width, height, right, bottom };
}
function reachable(control: HTMLElement) {
  const bounds = control.getBoundingClientRect();
  assert(bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.right <= innerWidth + 1
    && bounds.top >= 0 && bounds.bottom <= innerHeight + 1, `Control outside viewport: ${control.getAttribute("aria-label") || control.textContent}`);
  const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
  assert(hit && control.contains(hit), `Control covered: ${control.getAttribute("aria-label") || control.textContent}`);
}

export async function verifyWorkbenchLayout(act: (action: () => void) => void) {
  async function click(selector: string) {
    const control = element<HTMLButtonElement>(selector); reachable(control);
    act(() => control.click()); await tick(); await tick();
  }
  const header = rect(".inspection-header"), pane = rect(".preview-pane"), canvas = rect(".screenshot-frame");
  assert(header.height >= 48 && header.bottom <= pane.top + 1, "Workbench tools overlap the canvas");
  assert(element(".scene-toolbar-host").parentElement === element(".inspection-header"), "Scene tools are still inside the canvas");
  assert(!document.querySelector(".tree-pane > .subpanel-heading"), "Redundant tree title remains");
  const toolbar = rect(".preview-pane > .screenshot-view-toolbar");
  assert(!document.querySelector(".inspection-header .screenshot-view-toolbar"), "Canvas controls still crowd the device header");
  assert(toolbar.top >= pane.top && canvas.top >= toolbar.bottom && canvas.width === pane.width
    && canvas.bottom <= pane.bottom && canvas.height > pane.height - toolbar.height - 60,
    "Canvas toolbar overlaps or leaves unused workspace");
  assert(rect(".tree-tools").top >= rect(".ui-tree").bottom - 1 && rect(".tree-tools").bottom <= innerHeight,
    "Tree search does not stay in the footer");
  for (const control of document.querySelectorAll<HTMLElement>(
    ".workbench-device-tools button, .workbench-device-tools select, .view-mode-toggle button, .zoom-controls button, .zoom-continuous-toggle, .workbench-utilities > summary, .scene-toolbar-host > .snapshot-drawer > summary, .inspector-toggle")) reachable(control);

  await click(".zoom-continuous-toggle");
  reachable(element(".zoom-preset-select")); reachable(element(".zoom-continuous-popup input")); reachable(element(".zoom-reset"));
  await click(".zoom-continuous-toggle");
  await click(".inspector-groups-open");
  reachable(element('[aria-label="属性颜色格式"]')); reachable(element('.inspector-group-popup-options input'));
  await click(".inspector-group-popup-close");
  assert(document.activeElement === element(".inspector-groups-open"), "Display settings did not restore focus");

  await click(".tree-filter-details > summary");
  const filter = rect(".tree-filter-row");
  assert(filter.bottom <= rect(".tree-search").top && filter.left >= 0 && filter.right <= rect(".tree-pane").right + 1,
    "Footer filters open outside the tree or below the window");
  reachable(element(".tree-filter-row input"));
  await click(".tree-filter-details > summary");

  const splitter = element(".tree-pane-resizer"), initial = Number(splitter.getAttribute("aria-valuenow"));
  act(() => splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  await tick(); await tick();
  assert(Number(splitter.getAttribute("aria-valuenow")) === initial - 10, "Tree divider does not resize with the keyboard");
  act(() => splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  await tick(); await tick();
  assert(Number(splitter.getAttribute("aria-valuenow")) === initial, "Tree divider reset escaped responsive limits");

  await click(".workbench-utilities > summary");
  const menu = rect(".workbench-utilities-body");
  assert(menu.top >= header.bottom && menu.right <= innerWidth && menu.left >= 0 && menu.bottom <= innerHeight,
    "More tools menu clips or covers the header");
  reachable(element(".workbench-utilities-body > button"));
  await click(".workbench-utilities .debug-drawer > summary");
  const debugMenu = rect(".debug-drawer .snapshot-drawer-body");
  assert(debugMenu.width > 0 && debugMenu.left >= 0 && debugMenu.right <= innerWidth && debugMenu.bottom <= innerHeight,
    "Automatic debugging options are not reachable from More tools");
  await click(".workbench-utilities .debug-drawer > summary");
  act(() => element(".workbench-utilities").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await tick(); await tick();
  assert(!element<HTMLDetailsElement>(".workbench-utilities").open
    && document.activeElement === element(".workbench-utilities > summary"), "Escape does not close More tools and return focus");

  const before = rect(".screenshot-frame");
  await click(".inspector-close");
  assert(element(".floating-inspector").hidden, "Close did not hide docked properties");
  assert(rect(".screenshot-frame").width === before.width && rect(".screenshot-frame").height === before.height,
    "Closing properties resized the canvas");
  await click(".inspector-toggle");
  const inspector = rect(".floating-inspector");
  assert(element(".floating-inspector").classList.contains("is-docked") && Math.abs(inspector.right - rect(".preview-pane").right + 8) < 1,
    "Properties did not return to the canvas right edge");
  assert(getComputedStyle(element(".floating-inspector")).boxShadow === "none", "Docked properties retain the floating window frame");

  await click(".view-mode-toggle button:last-child");
  const deadline = performance.now() + 5000;
  while (!document.querySelector('.layer-webgl-canvas[data-layer-renderer="webgl"]')) {
    assert(performance.now() < deadline, "3D canvas did not mount"); await tick();
  }
  await click(".layer-settings > summary");
  const cameraMenu = rect(".layer-settings-body");
  assert(cameraMenu.top >= header.bottom && cameraMenu.left >= 0 && cameraMenu.right <= innerWidth && cameraMenu.bottom <= innerHeight,
    "Camera settings clip or cover the workbench tools");
  reachable(element(".layer-settings-body input"));
  await click(".layer-settings > summary");
  assert(document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
    "Workbench overflows the window");
  return { header: rect(".inspection-header"), canvas: rect(".screenshot-frame"), inspector: rect(".floating-inspector"),
    tree: rect(".tree-pane"), responsiveDivider: Number(splitter.getAttribute("aria-valuenow")),
    scenarios: ["compact header", "tree footer filters", "keyboard divider", "More tools + Escape", "property close/reopen", "3D camera menu"], fixtureOnly: true };
}

export async function verifyWorkbenchTree(act: (action: () => void) => void) {
  async function settle() { await tick(); await tick(); }
  async function click(selector: string) {
    const control = element(selector); reachable(control); act(() => control.click()); await settle();
  }
  async function query(value: string) {
    const field = element<HTMLInputElement>(".tree-search"); reachable(field);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    act(() => field.dispatchEvent(new Event("input", { bubbles: true }))); await settle();
  }
  async function key(selector: string, key: string) {
    const control = element(selector); control.focus({ preventScroll: true });
    act(() => control.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))); await settle();
  }
  const rows = () => [...document.querySelectorAll<HTMLElement>(".tree-row")].map(row => row.dataset.treeId);
  const planes = () => {
    const scene = element(".layer-scene");
    const ids = [...document.querySelectorAll<HTMLElement>(".layer-plane")].map(plane => plane.dataset.layerNodeId);
    // The root is a separate backdrop, not a child record/button. Once folded
    // it becomes the scene's single composite plane; expanded children exclude it.
    if (scene.dataset.layerRootComposite === "true") ids.push(scene.dataset.layerParentId);
    return ids.sort();
  };
  const expandedPlanes = '["0/0","0/0/0","0/1"]';
  await click(".tree-collapse-all");
  assert(JSON.stringify(rows()) === '["0"]' && JSON.stringify(planes()) === '["0"]', "Tree and scene did not collapse together");
  await query("TITLE");
  assert(JSON.stringify(rows()) === '["0","0/0","0/0/0"]' && element(".tree-hint[role=status]").textContent === "1 匹配",
    "Search lost ancestor paths or counted them as matches");
  const matched = element('.tree-row[data-tree-id="0/0/0"]');
  assert(matched.dataset.searchMatch === "true" && matched.querySelector(".tree-match-detail mark")?.textContent === "title"
    && element('.tree-row[data-tree-id="0"]').dataset.searchMatch === "false", "Resource match is not visible or ancestors look like matches");
  assert(JSON.stringify(planes()) === '["0"]', "Searching expanded the real scene");
  await click('.tree-row[data-tree-id="0/0/0"]');
  assert(element(".inspector-node-heading h4").textContent === "本地设置标题" && element(".floating-inspector").dataset.nodeId === "0/0/0",
    "Search result and properties have different identities");
  await key(".tree-search", "ArrowDown");
  assert(document.activeElement === element(".tree-search") && element(".tree-search").hasAttribute("aria-activedescendant")
    && element('.tree-row.selected').dataset.treeId === "0/0/0", "Down did not preselect a suggestion or changed the selected node");
  await key('[role="tree"]', "ArrowLeft");
  assert(element('.tree-row.selected').dataset.treeId === "0/0" && element(".inspector-relation .inspector-inline-values > div:first-child dd").textContent === "1",
    "Filtered Left did not select the complete parent node");
  await key('[role="tree"]', "ArrowRight");
  assert(element('.tree-row.selected').dataset.treeId === "0/0/0", "Filtered Right did not enter the child");
  assert(JSON.stringify(planes()) === '["0"]', "Filtered navigation changed real expansion");
  await key(".tree-search", "Escape");
  assert(element<HTMLInputElement>(".tree-search").value === "TITLE" && !document.querySelector('[aria-label="树搜索建议"]'), "first Escape did not close suggestions before clearing the query");
  // Keep focus on the already focused input so its focus handler does not reopen suggestions.
  act(() => element(".tree-search").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))); await settle();
  assert(element<HTMLInputElement>(".tree-search").value === "" && JSON.stringify(rows()) === '["0"]'
    && element(".floating-inspector").dataset.nodeId === "0/0/0" && JSON.stringify(planes()) === '["0"]',
    "Clearing search reopened real branches or lost selection");
  await click(".tree-locate");
  assert(rows().length === 4 && JSON.stringify(planes()) === expandedPlanes && element('.tree-row.selected').dataset.treeId === "0/0/0",
    "Explicit locate did not restore the selected path in tree and scene");
  await click(".tree-filter-details > summary");
  await click(".tree-filter-row input");
  assert(rows().length === 1 && element(".tree-hint[role=status]").textContent === "1 匹配" && JSON.stringify(planes()) === expandedPlanes,
    "Interactive filter changed scene state or counted paths");
  await click(".tree-filter-row input");
  await click(".tree-filter-details > summary");
  await query("missing-local-node");
  assert(rows().length === 0 && !element('[role="tree"]').hasAttribute("aria-activedescendant"), "Empty search left a dangling active row");
  await key(".tree-search", "ArrowDown"); await key('[role="tree"]', "Escape");
  assert(rows().length === 4 && JSON.stringify(planes()) === expandedPlanes, "Escape failed in an empty filtered tree");
  await query("title");
  const tree = element<HTMLElement>(".ui-tree-scroll");
  assert(tree.scrollWidth <= tree.clientWidth && document.documentElement.scrollWidth <= innerWidth, "Search layout overflows the window");
  return { treeWidth: tree.clientWidth, rows: rows(), matches: document.querySelectorAll('[data-search-match="true"]').length,
    sceneLayers: planes().length, scenarios: ["search paths versus real expansion", "visible ID match and count", "property identity",
      "suggestion preselection and Left/Right tree navigation", "layered Escape restore and explicit locate", "interactive filter", "empty tree Escape"], fixtureOnly: true };
}

export async function verifyWorkbenchFocus(act: (action: () => void) => void) {
  const settle = async () => { await tick(); await tick(); };
  const click = async (selector: string) => {
    const control = element(selector); reachable(control); act(() => control.click()); await settle();
  };
  const rows = () => [...document.querySelectorAll<HTMLElement>(".tree-row")].map(row => row.dataset.treeId);
  const planes = () => [...document.querySelectorAll<HTMLElement>(".layer-plane")].map(plane => plane.dataset.layerNodeId).sort();
  const query = element<HTMLInputElement>(".tree-search");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(query, "");
  act(() => query.dispatchEvent(new Event("input", { bubbles: true }))); await settle();
  await click(".tree-expand-all");
  await click(".tree-interaction-settings > summary");
  const preference = element<HTMLSelectElement>('[aria-label="双击行为"]'); reachable(preference);
  assert(preference.value === "toggle", "Default double-click behavior is not expand/collapse");
  const choose = async (value: string) => { act(() => { preference.value = value; preference.dispatchEvent(new Event("change", { bubbles: true })); }); await settle(); };
  await click(".tree-interaction-settings > summary");
  const double = async (id: string) => {
    const row = element(`.tree-row[data-tree-id="${id}"]`); reachable(row);
    for (const detail of [1, 2]) { act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }))); await settle(); }
    act(() => row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }))); await settle();
  };
  await double("0/0");
  assert(rows().length === 3 && JSON.stringify(planes()) === '["0/0","0/1"]', "Double-click did not collapse tree and scene once");
  await double("0/0");
  assert(rows().length === 4 && planes().length === 3, "Double-click did not reopen the parent once");
  await click(".tree-interaction-settings > summary"); await choose("focus-branch"); await click(".tree-interaction-settings > summary");
  const beforeRows = JSON.stringify(rows()), beforePlanes = JSON.stringify(planes());
  const beforeSelection = element('.tree-row.selected').dataset.treeId;
  await double("0/0");
  assert(JSON.stringify(rows()) === '["0/0","0/0/0"]' && JSON.stringify(planes()) === '["0/0","0/0/0"]', "Branch focus retained siblings or removed descendants");
  assert(element(".layer-scene").dataset.layerFocusKind === "branch" && element(".tree-focus-bar").textContent?.includes("聚焦分支"), "Focus has no clear mode or exit");
  reachable(element(".tree-focus-exit")); reachable(element(".exit-layer-focus"));
  await click('.tree-row[data-tree-id="0/0/0"]');
  await click(".tree-focus-exit");
  assert(JSON.stringify(rows()) === beforeRows && JSON.stringify(planes()) === beforePlanes
    && element('.tree-row.selected').dataset.treeId === beforeSelection, "Exit focus did not restore expansion or selection");
  await double("0/0"); await double("0/0");
  assert(rows().length === 2 && planes().length === 2, "Repeated focus toggled or duplicated the branch");
  await double("0/0/0");
  assert(JSON.stringify(rows()) === '["0/0/0"]' && planes().length === 1, "Nested leaf focus is not isolated");
  await click(".exit-layer-focus");
  assert(JSON.stringify(rows()) === beforeRows && JSON.stringify(planes()) === beforePlanes, "Nested focus overwrote original overview");
  await click(".tree-interaction-settings > summary"); await choose("expand"); await click(".tree-interaction-settings > summary");
  await double("0/0");
  assert(rows().length === 4 && !document.querySelector(".tree-focus-bar"), "Compatibility double-click collapsed or focused the parent");
  await click(".tree-interaction-settings > summary"); await choose("toggle"); await click(".tree-interaction-settings > summary");
  const readout = element(".zoom-readout").textContent;
  await click('[aria-label="放大截图"]');
  const savedZoom = element(".zoom-readout").textContent;
  act(() => element(".screenshot-frame").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))); await settle();
  const camera = () => {
    const data = element(".screenshot-frame").dataset;
    assert(data.cameraPaintAzimuth && data.cameraPaintElevation && data.cameraPaintRoll, "Painted camera angles are missing");
    return `${data.cameraPaintAzimuth}/${data.cameraPaintElevation}/${data.cameraPaintRoll}`;
  };
  const savedCamera = camera();
  await click(".tree-interaction-settings > summary"); await choose("focus-branch"); await click(".tree-interaction-settings > summary");
  await double("0/0");
  assert(element(".zoom-readout").textContent === "100%", "Focus did not fit its target");
  act(() => element(".screenshot-frame").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }))); await settle();
  await click(".exit-layer-focus");
  assert(element(".zoom-readout").textContent === savedZoom && savedZoom !== readout && camera() === savedCamera, "Exit focus lost the overview zoom/camera");
  await click(".zoom-fit");
  await click(".view-mode-toggle button:first-child"); await double("0/0");
  assert(element(".screenshot-frame").classList.contains("layers3d-active"), "Tree focus did not enter the 3D scene");
  await click(".exit-layer-focus");
  assert(!element(".screenshot-frame").classList.contains("layers3d-active"), "Exit focus lost the original 2D view");
  await click(".view-mode-toggle button:last-child");
  await double("0/0");
  await click(".tree-interaction-settings > summary"); await choose("toggle"); await click(".tree-interaction-settings > summary");
  assert(document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight, "Focus controls overflow the window");
  return { scenarios: ["default toggle once", "shared tree/scene expansion", "branch includes descendants", "clear mode and reachable exits",
    "selection/expansion restoration", "repeat and nested leaf focus", "legacy expand preference", "zoom/camera/2D restoration"], rows: rows(), sceneLayers: planes(), fixtureOnly: true };
}

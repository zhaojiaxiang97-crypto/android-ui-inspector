import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { makeNode } from "./fixtures";
import type { UiNode, UiSnapshot } from "../shared/types";
import { flattenNodes, filterTree } from "../shared/tree-utils";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import { ScreenshotPreview } from "../src/components/ScreenshotPreview";
import { UiTree } from "../src/components/UiTree";
import { DEFAULT_LAYER_APPEARANCE, LAYER_APPEARANCE_STORAGE_KEY } from "../src/features/layers/appearance";
import { DEFAULT_TREE_COLLAPSE, TREE_COLLAPSE_STORAGE_KEY } from "../shared/tree-collapse";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(`Visible expansion: ${message}`); }
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 6000;
  while (!predicate()) { check(performance.now() < deadline, message); await tick(); }
}

export async function verifyVisibleExpansion() {
  const oldApi = window.electronApi, keys = ["android-ui-inspector.double-click", LAYER_APPEARANCE_STORAGE_KEY, TREE_COLLAPSE_STORAGE_KEY];
  const preferences = keys.map(key => localStorage.getItem(key));
  const host = document.createElement("div"); host.style.width = "900px"; document.body.append(host);
  const mounted = createRoot(host), bitmap = document.createElement("canvas"); bitmap.width = 120; bitmap.height = 180;
  const context = bitmap.getContext("2d")!; context.fillStyle = "#3679b5"; context.fillRect(0, 0, 120, 180);
  const image = bitmap.toDataURL();
  const nodes = ["0", "0/0", "0/0/0", "0/0/0/0", "0/0/0/0/0"].map(id => ({ ...makeNode(id),
    bounds: { left: 0, top: 0, right: 120, bottom: 180, raw: "[0,0][120,180]" } }));
  const [root, first, second, painted, leaf] = nodes;
  nodes.slice(0, -1).forEach((node, index) => { node.children = [nodes[index + 1]]; });
  root.layerImageEmpty = true; first.layerImageEmpty = true; second.attributes = { "skip-draw": "true" };
  painted.layerImageDataUrl = image; painted.layerImageStatus = "captured"; painted.layerImageEmpty = false;
  leaf.layerImageDataUrl = image; leaf.layerImageStatus = "captured"; leaf.layerImageEmpty = false;
  const snapshot = (tree: UiNode): UiSnapshot => ({ serial: "expansion-fixture", root: tree, nodeCount: flattenNodes(tree).size,
    xmlSize: 0, rawXml: null, screenshotDataUrl: image, warning: null, error: null, captureMode: "deep" });
  window.electronApi = { ...oldApi, onInspectionPreview: () => () => {}, onInspectionProgress: () => () => {} };
  let workspace!: ReturnType<typeof useInspectionWorkspace>, standaloneTree = false, disabled = false;
  function Harness() {
    workspace = useInspectionWorkspace();
    const current = workspace.snapshot;
    if (!current?.root) return null;
    const filter = { query: workspace.treeQuery, interactiveOnly: workspace.interactiveOnly, identifiedOnly: workspace.identifiedOnly };
    return <>
      <UiTree root={current.root} filteredRoot={filterTree(current.root, filter)} filter={filter} filterActive={Boolean(filter.query)} filterKey={filter.query}
        selectedId={workspace.selectedNode?.id ?? null} expanded={workspace.treeExpandedIds} onExpandedChange={workspace.handleExpandedChange}
        expansionDisabled={disabled} doubleClickAction={workspace.doubleClickAction} onDoubleClick={standaloneTree ? undefined : workspace.handleNodeDoubleClick}
        onSelect={workspace.setSelectedNode} onClearFilter={workspace.clearTreeFilter} />
      <ScreenshotPreview src={image} root={current.root} selectedNode={workspace.selectedNode} expandedNodeIds={workspace.treeExpandedIds}
        hiddenNodeIds={workspace.hiddenNodeIds} layerFocus={workspace.layerFocus} sessionKey={workspace.treeSession}
        doubleClickAction={workspace.doubleClickAction} onDoubleClick={workspace.handleNodeDoubleClick} onSelect={workspace.setSelectedNode}
        onLayerAction={workspace.handleLayerAction} onOpenLayerMenu={(node, mode) => void workspace.openLayerMenu(node, undefined, mode)} />
    </>;
  }
  const act = (action: () => void) => flushSync(action);
  const render = () => act(() => mounted.render(<Harness />));
  const folded = () => act(() => workspace.setTreeExpandedIds(new Set()));
  const expanded = () => JSON.stringify([...workspace.treeExpandedIds].sort());
  const row = (node: UiNode) => host.querySelector<HTMLElement>(`[data-tree-id="${node.id}"]`)!;
  const doubleRow = (node: UiNode) => act(() => row(node).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })));
  const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
  const settled = () => canvas()?.dataset.layerRenderer === "webgl" && canvas()?.dataset.layerAnimationProgress === "1" && canvas()?.dataset.layerTexturePendingCount === "0";
  try {
    localStorage.setItem(keys[0], "toggle"); localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, JSON.stringify(DEFAULT_LAYER_APPEARANCE));
    localStorage.setItem(TREE_COLLAPSE_STORAGE_KEY, JSON.stringify(DEFAULT_TREE_COLLAPSE));
    render(); act(() => workspace.showSnapshot(snapshot(root))); folded();
    doubleRow(root);
    check(expanded() === JSON.stringify([root.id, first.id, second.id]), "tree double-click did not cross both empty wrappers or opened painted internals");
    check(row(painted) && !row(leaf), "tree did not expose exactly the first painted frontier");
    doubleRow(root); check(workspace.treeExpandedIds.size === 0, "toggle did not collapse the complete opened path");
    act(() => row(root).querySelector<HTMLElement>(".tree-chevron")!.click());
    check(expanded() === '["0"]' && !row(second), "chevron stopped being a single-level operation");
    folded(); act(() => workspace.handleLayerAction("expand", root));
    check(expanded() === '["0"]', "explicit menu expansion changed to recursive expansion");
    folded(); act(() => workspace.setTreeQuery("synthetic-target")); const filtered = expanded();
    act(() => workspace.handleNodeDoubleClick(root)); check(expanded() === filtered, "filtered tree persisted a temporary expansion");
    act(() => workspace.clearTreeFilter());
    act(() => workspace.setDoubleClickAction("focus-branch")); act(() => workspace.handleNodeDoubleClick(root));
    check(workspace.layerFocus?.node === root && workspace.treeExpandedIds.size === 0, "focus preference unexpectedly expanded the branch");
    act(() => workspace.handleLayerAction("exit-focus")); act(() => workspace.setDoubleClickAction("expand"));
    doubleRow(root); const open = expanded(); doubleRow(root); act(() => workspace.handleNodeDoubleClick(leaf));
    check(expanded() === open, "expand-only repeated click or leaf click changed the frontier");

    act(() => workspace.setDoubleClickAction("toggle")); folded();
    await until(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.disabled === false, "3D mode unavailable");
    act(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")!.click());
    await until(() => settled() && Boolean(canvas().dataset.layerProbeX), "folded canvas did not become pickable");
    const frame = host.querySelector<HTMLElement>(".screenshot-frame")!, rect = canvas().getBoundingClientRect();
    const point = { clientX: rect.left + Number(canvas().dataset.layerProbeX), clientY: rect.top + Number(canvas().dataset.layerProbeY) };
    const capture = frame.setPointerCapture; frame.setPointerCapture = () => {};
    try {
      for (let tap = 0; tap < 2; tap++) for (const type of ["pointerdown", "pointerup"]) act(() => frame.dispatchEvent(new PointerEvent(type, {
        bubbles: true, isPrimary: true, pointerType: "mouse", pointerId: 73, button: 0, ...point,
      })));
      act(() => frame.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2, ...point })));
    } finally { frame.setPointerCapture = capture; }
    check(expanded() === JSON.stringify([root.id, first.id, second.id]), "real canvas double-click did not use the same content frontier");
    await until(settled, "multi-level expansion did not finish animating");
    const planes = [...host.querySelectorAll<HTMLElement>(".layer-plane")].map(plane => plane.dataset.layerNodeId);
    check(JSON.stringify(planes) === JSON.stringify([painted.id]), "expansion exposed empty planes or skipped visible folded content");
    check(workspace.selectedNode === root, "automatic expansion changed the user's selected node");

    folded(); standaloneTree = true; render(); doubleRow(root);
    check(expanded() === JSON.stringify([root.id, first.id, second.id]), "standalone tree has different double-click behavior");
    doubleRow(root); disabled = true; render(); doubleRow(root);
    check(workspace.treeExpandedIds.size === 0, "disabled standalone tree expanded");
    disabled = false; standaloneTree = false; render();
    const stale = workspace.handleNodeDoubleClick;
    act(() => workspace.showSnapshot(snapshot(structuredClone(root)))); folded(); act(() => stale(root));
    check(workspace.treeExpandedIds.size === 0, "old double-click expanded a replacement snapshot");

    const cards = [0, 1].map(index => {
      const bounds = { left: 0, top: index * 90, right: 120, bottom: index * 90 + 80, raw: "fixture" };
      const content = { ...makeNode(`card-${index}-content`), bounds, layerImageDataUrl: image, layerImageSize: { width: 120, height: 180 },
        children: [{ ...makeNode(`card-${index}-label`), bounds }] };
      const wrapper = { ...makeNode(`card-${index}-wrapper`), bounds, layerImageEmpty: true, children: [content] };
      return { ...makeNode(`card-${index}`), bounds, layerImageEmpty: true, children: [wrapper] };
    });
    const list = { ...makeNode("list"), bounds: root.bounds, className: "androidx.recyclerview.widget.RecyclerView", layerImageEmpty: true, children: cards };
    const cardRoot = { ...root, id: "cards-root", children: [list] };
    act(() => workspace.showSnapshot(snapshot(cardRoot)));
    check(row(cards[0]) && row(cards[1]) && !row(cards[0].children[0]), "default list view did not keep cards whole");
    await until(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")?.disabled === false, "card view did not load");
    act(() => host.querySelector<HTMLButtonElement>(".view-mode-toggle button:last-child")!.click());
    await until(() => settled() && host.querySelectorAll(".layer-plane").length === 2, "folded card composites did not render");
    const cardPlanes = [...host.querySelectorAll<HTMLElement>(".layer-plane")];
    check(cardPlanes[0].dataset.layerZ === cardPlanes[1].dataset.layerZ, "disjoint whole cards acquired different depths");
    const cardRect = canvas().getBoundingClientRect(), cardPoint = {
      clientX: cardRect.left + Number(canvas().dataset.layerProbeX), clientY: cardRect.top + Number(canvas().dataset.layerProbeY),
    };
    const cardFrame = host.querySelector<HTMLElement>(".screenshot-frame")!, cardCapture = cardFrame.setPointerCapture;
    cardFrame.setPointerCapture = () => {};
    try {
      for (let tap = 0; tap < 2; tap++) for (const type of ["pointerdown", "pointerup"]) act(() => cardFrame.dispatchEvent(new PointerEvent(type, {
        bubbles: true, isPrimary: true, pointerType: "mouse", pointerId: 74, button: 0, ...cardPoint,
      })));
      act(() => cardFrame.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2, ...cardPoint })));
    } finally { cardFrame.setPointerCapture = cardCapture; }
    const openedCard = cards.find(card => workspace.treeExpandedIds.has(card.id));
    check(openedCard && cards.filter(card => workspace.treeExpandedIds.has(card.id)).length === 1, "canvas double-click did not open exactly one card");
    check(row(openedCard.children[0].children[0]) && !row(openedCard.children[0].children[0].children[0]), "card did not skip empty wrappers and stop at painted content");
    const otherCard = cards.find(card => card !== openedCard)!;
    check(!row(otherCard.children[0]), "opening one card exposed another card's contents");
    doubleRow(openedCard); doubleRow(otherCard);
    check(!workspace.treeExpandedIds.has(openedCard.id) && workspace.treeExpandedIds.has(otherCard.id), "tree and canvas disagree about individual card expansion");
    await until(settled, "card expansion did not finish animating");
    return ["double-click: real tree and WebGL canvas cross empty wrappers, stop at visible content, preserve selection and finish animation",
      "double-click: single-level arrows/menu, toggle/expand/focus, filtering, disabled tree and stale snapshot guards",
      "components: whole list cards share depth; real canvas/tree open one card through empty wrappers and retain neighboring cards"];
  } finally {
    act(() => mounted.unmount()); host.remove(); window.electronApi = oldApi;
    keys.forEach((key, index) => { const value = preferences[index]; if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); });
  }
}

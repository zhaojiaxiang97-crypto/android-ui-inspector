import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { UiTreeNode } from "../src/components/UiTreeNode";
import { UiTree } from "../src/components/UiTree";
import { TREE_ROW_HEIGHT, treeWindow } from "../shared/visible-tree";
import { verifyVirtualTreeBehavior } from "./virtual-tree-checks";
import { flattenNodes, nodeDisplayLabel } from "../shared/tree-utils";
import { createTree, type TreeShape } from "./fixtures";
import { statistics } from "./statistics";
import { LegacyTreeNode } from "./LegacyTreeNode";
import type { UiNode } from "../shared/types";
import "../src/App.css";

type RenderCase = { nodes: number; shape: TreeShape; variant: "legacy" | "optimized" | "virtual" };
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function createHost() {
  const host = document.createElement("div");
  host.className = "tree-scroll";
  host.setAttribute("role", "tree");
  host.style.width = "600px";
  document.body.append(host);
  return host;
}

function selectedLabel(host: HTMLElement) {
  const selected = host.querySelectorAll('[aria-selected="true"]');
  check(selected.length === 1, `Expected one selected row, got ${selected.length}`);
  return selected[0].querySelector(".tree-label")?.textContent;
}

async function runTreeRenderCase(input: RenderCase) {
  const Tree = input.variant === "legacy" ? LegacyTreeNode : UiTreeNode;
  const node = createTree(input.nodes, input.shape);
  const nodes = [...flattenNodes(node).values()];
  check(nodes.length === input.nodes, "Incorrect fixture size");
  const leaves = nodes.filter((entry) => entry.children.length === 0);
  const targets = [leaves[0], leaves[leaves.length - 1]];
  const onSelect = () => {};
  const host = createHost();
  if (input.variant === "virtual") { host.className = "benchmark-host"; host.removeAttribute("role"); }
  const reactRoot = createRoot(host);
  let selected = targets[0];
  const draw = () => {
    flushSync(() => reactRoot.render(input.variant === "virtual"
      ? <UiTree root={node} filteredRoot={node} selectedId={selected.id} expanded={new Set()} filterActive filterKey="all" onExpandedChange={() => {}} onSelect={onSelect} onClearFilter={onSelect} />
      : <Tree node={node} depth={0} selectedId={selected.id} forceExpand onSelect={onSelect} />));
    // Force style/layout inside the measured interval. Paint is not included.
    void host.offsetHeight;
  };
  const timed = (operation: () => void) => {
    const start = performance.now();
    operation();
    return performance.now() - start;
  };
  const mount: number[] = [];
  const selection: number[] = [];
  const unrelatedUpdate: number[] = [];
  try {
    for (let trial = 0; trial < 4; trial += 1) {
      flushSync(() => reactRoot.render(null));
      await yieldToBrowser();
      const elapsed = timed(draw);
      if (trial > 0) mount.push(elapsed);
    }
    const renderedRows = host.querySelectorAll(".tree-row").length;
    if (input.variant === "virtual") {
      const viewport = host.querySelector<HTMLElement>(".ui-tree-scroll")!;
      check(Number(viewport.dataset.rowCount) === input.nodes, "Incorrect logical row count");
      check(renderedRows <= Math.ceil(viewport.clientHeight / TREE_ROW_HEIGHT) + 17, "Virtual DOM row count exceeded viewport bound");
    } else check(renderedRows === input.nodes, "Not all nodes were mounted");
    for (let trial = 0; trial < 11; trial += 1) {
      selected = targets[(trial + 1) % 2];
      const elapsed = timed(draw);
      if (trial > 1) selection.push(elapsed);
      check(selectedLabel(host) === nodeDisplayLabel(selected), "Selection did not update correctly");
      await yieldToBrowser();
    }
    for (let trial = 0; trial < 9; trial += 1) unrelatedUpdate.push(timed(draw));
    const scroll: number[] = [];
    if (input.variant === "virtual") {
      const viewport = host.querySelector<HTMLElement>(".ui-tree-scroll")!;
      for (let trial = 0; trial < 11; trial += 1) {
        const began = performance.now();
        await new Promise<void>((resolve, reject) => {
          let expectedStart = -1;
          const complete = () => {
            if (Number(viewport.dataset.windowStart) !== expectedStart) return;
            observer.disconnect();
            clearTimeout(timeout);
            void host.offsetHeight;
            resolve();
          };
          const observer = new MutationObserver(complete);
          const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Virtual scroll did not commit its new window")); }, 3000);
          observer.observe(viewport, { attributes: true });
          flushSync(() => {
            viewport.scrollTop = trial % 2 ? viewport.scrollHeight / 2 : 0;
            expectedStart = treeWindow(input.nodes, viewport.scrollTop, viewport.clientHeight).start;
            viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
          });
          complete();
        });
        const elapsed = performance.now() - began;
        if (trial > 1) scroll.push(elapsed);
      }
    }
    return { ...input, renderedRows, mount: statistics(mount), selection: statistics(selection), unrelatedUpdate: statistics(unrelatedUpdate), scroll: scroll.length ? statistics(scroll) : null };
  } finally {
    flushSync(() => reactRoot.unmount());
    host.remove();
    await yieldToBrowser();
  }
}

function verifyTreeBehavior() {
  // Label getters count evaluated rows for the memo regression check only.
  // Timing fixtures above use ordinary properties with no instrumentation.
  const node = createTree(256);
  const nodes = [...flattenNodes(node).values()];
  const leaves = nodes.filter((entry) => entry.children.length === 0);
  const first = leaves[0];
  const last = leaves[leaves.length - 1];
  let labelReads = 0;
  for (const entry of nodes) {
    const text = entry.text;
    Object.defineProperty(entry, "text", { enumerable: true, get: () => { labelReads += 1; return text; } });
  }
  const host = createHost();
  const reactRoot = createRoot(host);
  const onSelect = () => {};
  let legacyLabelReads = 0;
  let optimizedLabelReads = 0;
  try {
    for (const Tree of [LegacyTreeNode, UiTreeNode]) {
      const draw = (selectedId: string) => flushSync(() => reactRoot.render(<Tree node={node} depth={0} selectedId={selectedId} forceExpand onSelect={onSelect} />));
      draw(first.id);
      labelReads = 0;
      draw(last.id);
      const reads = labelReads;
      check(selectedLabel(host) === nodeDisplayLabel(last), "Selected state is stale");
      if (Tree === LegacyTreeNode) {
        legacyLabelReads = reads;
        check(reads === nodes.length, "Legacy fixture no longer reproduces the old full-tree update");
      } else {
        optimizedLabelReads = reads;
        check(reads <= first.id.split("/").length + last.id.split("/").length, "Unrelated branches rerendered");
        check(reads > 0, "Changed selection was not rendered");
      }
      labelReads = 0;
      draw(last.id);
      check(labelReads === 0, "Unchanged props invalidated the tree");
      flushSync(() => reactRoot.render(null));
    }

    const tree = createTree(21);
    let clicked: UiNode | null = null;
    let oldCallbackCalls = 0;
    const oldCallback = () => { oldCallbackCalls += 1; };
    const newCallback = (value: UiNode) => { clicked = value; };
    const draw = (value: UiNode, callback: (node: UiNode) => void = oldCallback) => flushSync(() => reactRoot.render(<UiTreeNode node={value} depth={0} selectedId={value.id} forceExpand={false} onSelect={callback} />));
    draw(tree);
    check(host.querySelectorAll(".tree-row").length === 5, "Default expansion changed");
    const childChevron = host.querySelectorAll(".tree-chevron")[1];
    flushSync(() => childChevron.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    check(host.querySelectorAll(".tree-row").length === 9, "Expand click failed");
    check(oldCallbackCalls === 0, "Expand click also selected the row");
    draw(tree, newCallback);
    check(host.querySelectorAll(".tree-row").length === 9, "Expansion state was lost on rerender");
    flushSync(() => (host.querySelectorAll(".tree-row")[2] as HTMLButtonElement).click());
    check(clicked === tree.children[0].children[0] && oldCallbackCalls === 0, "Callback changed but memo kept the stale callback");
    const replacement = { ...tree, children: tree.children.map((child, index) => index === 1 ? { ...child, text: "Updated branch label" } : child) };
    draw(replacement, newCallback);
    check(host.textContent?.includes("Updated branch label"), "Snapshot replacement was skipped by memo");

    // Clear the former selection in an independent branch, including 1 vs 10.
    const wide = createTree(13, "wide");
    for (const id of ["0/1", "0/10", "0/1"]) {
      flushSync(() => reactRoot.render(<UiTreeNode node={wide} depth={0} selectedId={id} forceExpand onSelect={onSelect} />));
      check(selectedLabel(host) === nodeDisplayLabel(flattenNodes(wide).get(id)!), "Sibling selection boundary is incorrect");
    }
    return { checks: ["selection", "memo skips unchanged branches", "memo skips unchanged props", "expand preserves state", "expand does not select", "callback replacement", "snapshot replacement", "sibling ID boundaries"], legacyLabelReads, optimizedLabelReads, instrumentedNodes: nodes.length };
  } finally {
    flushSync(() => reactRoot.unmount());
    host.remove();
  }
}

Object.assign(window, { runTreeRenderCase, verifyTreeBehavior, verifyVirtualTreeBehavior });

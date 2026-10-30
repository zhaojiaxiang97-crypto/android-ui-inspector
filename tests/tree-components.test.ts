import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { componentBoundaryIds } from "../shared/tree-components";
import { DEFAULT_TREE_COLLAPSE, initialTreeExpansion, reconcileTreeExpansion, treeExpansionForPreset, treeExpansionToContent } from "../shared/tree-collapse";
import { visibleTreeRows } from "../shared/visible-tree";
import type { UiNode } from "../shared/types";

function fixture(className = "androidx.recyclerview.widget.RecyclerView") {
  const cards: UiNode[] = ["first", "second"].map(id => ({ ...makeNode(id), layerImageEmpty: true, children: [
    { ...makeNode(`${id}-wrapper`), layerImageEmpty: true, children: [
      { ...makeNode(`${id}-photo`), layerImageDataUrl: "pixels", children: [makeNode(`${id}-caption`)] },
    ] },
  ] }));
  const list: UiNode = { ...makeNode("list"), className, layerImageEmpty: true, children: cards };
  return { root: { ...makeNode("root"), children: [list] }, list, cards };
}

test("default list overview shows whole cards and double-click opens only the requested card", () => {
  const { root, list, cards } = fixture(), before = JSON.stringify(root);
  const initial = initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE);
  assert.deepEqual([...initial], [root.id, list.id]);
  assert.deepEqual(visibleTreeRows(root, initial).map(row => row.node.id), [root.id, list.id, ...cards.map(card => card.id)]);
  const next = treeExpansionToContent(cards[0], initial);
  assert.deepEqual(next, new Set([root.id, list.id, cards[0].id, cards[0].children[0].id]));
  assert(!next.has(cards[1].id));
  assert(!next.has(cards[0].children[0].children[0].id), "stop at the first painted branch");
  assert.deepEqual(treeExpansionToContent(list, new Set()), new Set([list.id]), "opening an empty list must stop at its cards");
  assert.equal(JSON.stringify(root), before);
});

test("validated SDK inheritance recognizes custom lists while names, invalid chains and QML do not", () => {
  const { root, list, cards } = fixture("example.Feed");
  const chain = `${list.className} → androidx.recyclerview.widget.RecyclerView → android.view.ViewGroup → android.view.View`;
  list.attributes = { "sdk-class-hierarchy": chain };
  assert.deepEqual(componentBoundaryIds(root), new Set(cards.map(card => card.id)));
  for (const invalid of [chain.replace("example.Feed", "example.Other"), chain.slice(0, -" → android.view.View".length), `${chain} → android.view.View`]) {
    list.attributes = { "sdk-class-hierarchy": invalid };
    assert.equal(componentBoundaryIds(root).size, 0);
  }
  list.attributes = { "sdk-class-hierarchy": chain, "inspection-source": "debug-qml" };
  assert.equal(componentBoundaryIds(root).size, 0);
  list.className = "example.UnknownRecyclerView"; list.attributes = {};
  assert.equal(componentBoundaryIds(root).size, 0);
  assert(initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE).has(cards[0].id));
});

test("standard card containers outside a list fold, while legacy and disabled preferences retain full expansion", () => {
  const { root, list } = fixture("android.widget.FrameLayout");
  list.children[0].className = "com.google.android.material.card.MaterialCardView";
  assert.deepEqual(componentBoundaryIds(root), new Set([list.children[0].id]));
  assert(!initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE).has(list.children[0].id));
  for (const components of [undefined, false]) assert(initialTreeExpansion(root, { ...DEFAULT_TREE_COLLAPSE, components }).has(list.children[0].id));
});

test("manual opens survive refresh and component presets retain the selected path", () => {
  const { root, cards } = fixture();
  const opened = treeExpansionToContent(cards[0], initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE));
  const refreshed = structuredClone(root), list = refreshed.children[0];
  const added = structuredClone(cards[1]); added.id = "new-card"; added.children = [makeNode("new-child")]; list.children.push(added);
  const reconciled = reconcileTreeExpansion(root, refreshed, opened, DEFAULT_TREE_COLLAPSE);
  assert(reconciled.has(cards[0].id)); assert(!reconciled.has(cards[1].id)); assert(!reconciled.has(added.id));
  const caption = cards[1].children[0].children[0].children[0];
  const preset = treeExpansionForPreset(root, "components", opened, caption.id);
  assert(visibleTreeRows(root, preset).some(row => row.node.id === caption.id));
  assert(!preset.has(cards[0].id));
  assert(treeExpansionForPreset(root, "all", preset).has(cards[0].children[0].children[0].id));
});

function largePaintedTree() {
  const paint = (id: string): UiNode => ({ ...makeNode(id), layerImageDataUrl: "pixels", layerImageStatus: "captured" });
  const root = paint("window"), panel = paint("panel"), card = paint("card"), child = paint("child");
  const wrapper = { ...makeNode("wrapper"), layerImageEmpty: true, children: [card] };
  root.children = [panel, ...Array.from({ length: 301 }, (_, i) => makeNode(`other-${i}`))];
  panel.children = [wrapper]; card.children = [child]; child.children = [makeNode("leaf")];
  return { root, panel, wrapper, card, child };
}

test("complex component overview stops at painted panels, skipping empty wrappers and keeping the full source", () => {
  const { root, panel, wrapper, card, child } = largePaintedTree(), before = JSON.stringify(root);
  const expanded = initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE);
  assert(expanded.has(root.id) && expanded.has(panel.id) && expanded.has(wrapper.id));
  assert(!expanded.has(card.id) && !expanded.has(child.id));
  assert(!visibleTreeRows(root, expanded).some(row => row.node.id === child.id));
  assert.equal(JSON.stringify(root), before);
  const opened = treeExpansionToContent(card, expanded);
  assert(opened.has(card.id) && !opened.has(child.id));
  assert(reconcileTreeExpansion(root, structuredClone(root), opened, DEFAULT_TREE_COLLAPSE).has(card.id));
  assert(treeExpansionForPreset(root, "all", expanded).has(child.id));
  assert(visibleTreeRows(root, treeExpansionForPreset(root, "components", expanded, child.id)).some(row => row.node.id === child.id));
});

test("overview only applies to complex automatic component views, not small trees or explicit depth/legacy rules", () => {
  const { root, card } = largePaintedTree();
  for (const preference of [
    { ...DEFAULT_TREE_COLLAPSE, components: false }, { ...DEFAULT_TREE_COLLAPSE, components: undefined },
    { ...DEFAULT_TREE_COLLAPSE, depth: 20 },
  ]) assert(initialTreeExpansion(root, preference).has(card.id));
  root.children = root.children.slice(0, 1);
  assert(initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE).has(card.id));
});

test("missing or failed captures do not consume a painted overview level", () => {
  const { root, panel, card } = largePaintedTree();
  delete panel.layerImageDataUrl; panel.layerImageStatus = "failed";
  assert(initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE).has(card.id));
});

test("navigation bars fold by exact Android type or validated inheritance, never by a guessed name", () => {
  const bar = { ...makeNode("bar"), className: "example.Navigation", children: [makeNode("icon")] };
  const root = { ...makeNode("root"), children: [bar] };
  bar.attributes = { "sdk-class-hierarchy": "example.Navigation → com.google.android.material.tabs.TabLayout → android.view.ViewGroup → android.view.View" };
  assert(!initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE).has(bar.id));
  assert(treeExpansionToContent(bar, new Set()).has(bar.id));
  bar.className = "example.FakeToolbar"; bar.attributes = {};
  assert(initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE).has(bar.id));
});

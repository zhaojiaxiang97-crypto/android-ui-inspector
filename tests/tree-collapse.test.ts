import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { DEFAULT_TREE_COLLAPSE, initialTreeExpansion, parseTreeCollapsePreference, reconcileTreeExpansion, type TreeCollapsePreference } from "../shared/tree-collapse";
import { collapseTreeBranch, expandAncestors, indexTree, visibleTreeRows } from "../shared/visible-tree";
import { filterTree } from "../shared/tree-utils";

const rules = (classes: string[] = [], depth: number | null = null): TreeCollapsePreference => ({ version: 1, depth, classes });
function fixture() {
  const root = makeNode("0"), svg = makeNode("0/0"), group = makeNode("0/0/0"), leaf = makeNode("0/0/0/0"), react = makeNode("0/1"), text = makeNode("0/1/0");
  svg.className = "com.horcrux.svg.SvgView"; react.className = "com.facebook.react.views.view.ReactViewGroup"; leaf.text = "folded-target";
  root.children = [svg, react]; svg.children = [group]; group.children = [leaf]; react.children = [text];
  return { root, svg, group, leaf, react };
}
const rows = (root: ReturnType<typeof makeNode>, expanded: ReadonlySet<string>) => visibleTreeRows(root, expanded).map(row => row.node.id);

test("collapse preferences reject corrupt versions, invalid depth and executable patterns", () => {
  for (const value of [null, [], {}, { ...rules(), version: 2 }, ...[0, -1, 201, 2.5, "3", NaN, Infinity].map(depth => ({ ...rules(), depth })),
    ...["", " SvgView ", "Svg*", "SvgView\nView", "<script>", "a".repeat(201)].map(name => rules([name])), rules(Array.from({ length: 33 }, (_, i) => `Class${i}`))])
    assert.equal(parseTreeCollapsePreference(value), null);
  assert.deepEqual(parseTreeCollapsePreference(rules(["SvgView", "com.horcrux.svg.SvgView", "SvgView", "Outer$Inner", "示例控件"], 200)),
    rules(["SvgView", "com.horcrux.svg.SvgView", "Outer$Inner", "示例控件"], 200));
});

test("the default retains the complete tree, and exact type folding leaves React containers open", () => {
  const { root, svg, group, react } = fixture(), original = JSON.stringify(root);
  assert.equal(rows(root, initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE)).length, 6);
  const folded = initialTreeExpansion(root, rules(["SvgView"]));
  assert.deepEqual(rows(root, folded), [root.id, svg.id, react.id, `${react.id}/0`]);
  assert(!folded.has(group.id));
  assert.equal(JSON.stringify(root), original);
  svg.className = "another.SvgView";
  assert.equal(rows(root, initialTreeExpansion(root, rules(["com.horcrux.svg.SvgView"]))).length, 6);
  assert.equal(rows(root, initialTreeExpansion(root, rules(["SvgView"]))).length, 4);
  assert.equal(rows(root, initialTreeExpansion(root, rules(["svgview"]))).length, 6);
});

test("depth counts the root as one, and a folded branch reopens only one level", () => {
  const { root, svg, group } = fixture();
  assert.deepEqual(rows(root, initialTreeExpansion(root, rules([], 1))), [root.id]);
  const folded = initialTreeExpansion(root, rules([], 2));
  assert.deepEqual(rows(root, folded), [root.id, svg.id, "0/1"]);
  folded.add(svg.id);
  assert.deepEqual(rows(root, folded), [root.id, svg.id, group.id, "0/1"]);
  assert(!folded.has(group.id));
});

test("search temporarily exposes original paths; explicit locate only reopens the selected path", () => {
  const { root, svg, group, leaf } = fixture(), expanded = initialTreeExpansion(root, rules(["SvgView"]));
  const filtered = filterTree(root, { query: "folded-target", interactiveOnly: false, identifiedOnly: false });
  assert.deepEqual(visibleTreeRows(filtered, expanded, true).map(row => row.node.id), [root.id, svg.id, group.id, leaf.id]);
  assert.deepEqual(rows(root, expanded), ["0", "0/0", "0/1", "0/1/0"]);
  const located = expandAncestors(indexTree(root), expanded, leaf.id);
  assert(rows(root, located).includes(leaf.id));
  assert(!expanded.has(svg.id));
});

test("final merges retain manual opens and closes while applying rules to newly arriving branches", () => {
  const { root, svg, group, react } = fixture(), preference = rules(["SvgView"]);
  const expanded = initialTreeExpansion(root, preference); expanded.add(svg.id); expanded.add(group.id);
  const manual = collapseTreeBranch(expanded, react.id);
  const next = structuredClone(root), newlyArrived = makeNode("0/2"), newlyFolded = makeNode("0/3"), hiddenChild = makeNode("0/1/1");
  newlyArrived.children = [makeNode("0/2/0")]; newlyFolded.className = svg.className; newlyFolded.children = [makeNode("0/3/0")];
  hiddenChild.children = [makeNode("0/1/1/0")]; next.children[1].children.push(hiddenChild); next.children.push(newlyArrived, newlyFolded);
  const final = reconcileTreeExpansion(root, next, manual, preference);
  assert(final.has(svg.id) && final.has(group.id) && final.has(newlyArrived.id));
  assert(!final.has(react.id) && !final.has(hiddenChild.id) && !final.has(newlyFolded.id));
  final.add(react.id);
  assert(rows(next, final).includes(hiddenChild.id) && !rows(next, final).includes("0/1/1/0"));
});

test("branch refresh follows View identity instead of reopening a new view at an old position", () => {
  const { root, svg } = fixture(); svg.attributes = { "view-ref": "Svg@original" };
  const expanded = initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE), manual = collapseTreeBranch(expanded, svg.id);
  const after = structuredClone(root), newSvg = makeNode("0/0");
  newSvg.className = svg.className; newSvg.attributes = { "view-ref": "Svg@new" }; newSvg.children = [makeNode("0/0/0")];
  const moved = after.children[0]; moved.id = "0/2"; moved.children[0].id = "0/2/0"; moved.children[0].children[0].id = "0/2/0/0";
  after.children = [newSvg, after.children[1], moved];
  const current = reconcileTreeExpansion(root, after, manual, DEFAULT_TREE_COLLAPSE);
  assert(current.has(newSvg.id)); assert(!current.has(moved.id));
  assert(rows(after, current).includes("0/0/0") && !rows(after, current).includes("0/2/0"));
});

test("a former leaf gaining children uses initial rules without changing known branch choices", () => {
  const { root, svg } = fixture(), expanded = initialTreeExpansion(root, rules([], 2)); expanded.add(svg.id);
  const after = structuredClone(root), leaf = after.children[1].children[0]; leaf.children = [makeNode(`${leaf.id}/0`)];
  const next = reconcileTreeExpansion(root, after, expanded, rules([], 2));
  assert(next.has(svg.id)); assert(!next.has(leaf.id));
});

test("initial folding remains iterative on a deeply nested tree", () => {
  const root = makeNode("deep-0"); let parent = root;
  for (let index = 1; index < 20_000; index++) { const child = makeNode(`deep-${index}`); parent.children = [child]; parent = child; }
  const expanded = initialTreeExpansion(root, rules([], 8));
  assert.equal(visibleTreeRows(root, expanded).length, 8);
  assert.equal(indexTree(root).size, 20_000);
});

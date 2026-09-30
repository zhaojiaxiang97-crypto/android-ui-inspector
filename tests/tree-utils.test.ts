import assert from "node:assert/strict";
import { test } from "node:test";
import { createTree, makeNode } from "../benchmarks/fixtures";
import { changedLayerImages, filterTree, flattenNodes, layerImageBaseline, mergeLayerImages, nodeDisplayLabel, remapViewNodeIds, replaceTreeBranch, selectionInBranch, treeNodeKind, type TreeFilter } from "../shared/tree-utils";

const noFilter: TreeFilter = { query: "", interactiveOnly: false, identifiedOnly: false };

test("tree icons describe control types independently of labels, clickability and expansion", () => {
  const node = { ...makeNode("0"), text: "播放视频", resourceId: "app:id/video_background_view", clickable: true, scrollable: false };
  const cases = [
    ["HomeActivity", "activity"], ["PhoneWindow$DecorView", "window"], ["ViewStubCompat", "stub"],
    ["LinearLayout", "linear"], ["IsolationFrameLayout", "frame"], ["ConstraintLayout", "constraint"],
    ["RelativeLayout", "constraint"], ["KwaiSlidingPaneLayout", "drawer"], ["DrawerLayout", "drawer"],
    ["ViewPager", "pager"], ["ViewPager2", "pager"], ["RecyclerView", "list"], ["GridView", "grid"],
    ["NestedScrollView", "scroll"], ["TextInputEditText", "input"], ["AppCompatImageButton", "button"],
    ["MaterialButton", "button"], ["MaterialCheckBox", "checkbox"], ["RadioButton", "radio"],
    ["SwitchCompat", "switch"], ["MaterialSwitch", "switch"], ["AppCompatSeekBar", "slider"],
    ["ProgressBar", "progress"], ["CircularProgressIndicator", "progress"],
    ["WebView", "web"], ["PlayerView", "video"], ["GLSurfaceView", "surface"], ["TextureView", "surface"],
    ["AppCompatImageView", "image"], ["SimpleDraweeView", "image"], ["MaterialTextView", "text"],
    ["ViewGroup", "container"], ["CoordinatorLayout", "container"], ["View", "leaf"],
    ["QQuickImage", "image"], ["QQuickText", "text"], ["QQuickTextField_QMLTYPE_42", "input"],
    ["Button_QMLTYPE_7", "button"], ["QQuickColumn", "linear"], ["QQuickItem", "container"],
  ];
  for (const [name, expected] of cases) {
    node.className = `example.${name}`;
    assert.equal(treeNodeKind(node), expected, name);
    assert.equal(treeNodeKind({ ...node, clickable: false, visibleToUser: false, enabled: false }), expected, `state changed ${name}'s type`);
  }
  node.className = "example.CustomWidget";
  assert.equal(treeNodeKind(node), "leaf", "a video label or clickable flag must not invent a video/button type");
  assert.equal(treeNodeKind({ ...node, scrollable: true }), "scroll");
  assert.equal(treeNodeKind({ ...node, children: [makeNode("0/0")] }), "container");
  assert.equal(treeNodeKind({ ...node, className: "android.widget.FrameLayout", children: [] }), "frame", "an empty layout is still a layout");
  assert.equal(treeNodeKind({ ...node, className: null }), "leaf");
});

test("fixture sizes and flattened preorder are deterministic", () => {
  for (const size of [1, 1_000, 25_000]) {
    for (const shape of ["balanced", "wide"] as const) {
      assert.equal(flattenNodes(createTree(size, shape)).size, size);
    }
  }
  assert.deepEqual([...flattenNodes(createTree(7)).keys()], ["0", "0/0", "0/0/0", "0/0/1", "0/1", "0/2", "0/3"]);
});

test("branch replacement keeps siblings and remaps moved View identities, not reused paths", () => {
  const root = createTree(7);
  const branch = root.children[0];
  branch.attributes = { "view-ref": "example.View@parent" };
  branch.children[0].attributes = { "view-ref": "example.View@first" };
  branch.children[1].attributes = { "view-ref": "example.View@second" };
  const fresh = { ...branch, children: [
    { ...branch.children[1], id: `${branch.id}/0`, index: 0 },
    { ...makeNode(`${branch.id}/1`), index: 1, attributes: { "view-ref": "example.View@added" } },
  ] };
  const updated = replaceTreeBranch(root, branch.id, fresh);
  const ids = remapViewNodeIds(root, updated);
  assert.equal(updated.children[1], root.children[1]);
  assert.equal(ids.get(branch.children[1].id), fresh.children[0].id);
  assert.equal(ids.has(branch.children[0].id), false);
  assert.equal(ids.get(root.children[1].id), root.children[1].id);
  assert.throws(() => replaceTreeBranch(root, branch.id, { ...fresh, attributes: { "view-ref": "example.View@wrong" } }), /对象已变化/);
});

test("layer previews send only changed images and preserve untouched branches", () => {
  const source = createTree(9), displayed = structuredClone(source), baseline = layerImageBaseline(source);
  const child = source.children[0];
  child.layerImageDataUrl = `data:image/png;base64,${"a".repeat(1024)}`;
  child.layerImageSize = { width: 10, height: 20 };
  child.layerImageStatus = "captured";
  child.attributes = { "image-source": "own" };
  const first = changedLayerImages(source, baseline)!;
  assert.deepEqual(first.map(update => update.id), [child.id]);
  const shown = mergeLayerImages(displayed, first);
  assert.equal(shown.children[0].layerImageDataUrl, child.layerImageDataUrl);
  assert.equal(shown.children[0].attributes?.["image-source"], "own");
  assert.equal(shown.children[1], displayed.children[1]);
  assert.equal(displayed.children[0].layerImageStatus, undefined);
  assert.deepEqual(changedLayerImages(source, baseline), []);

  delete child.layerImageDataUrl;
  delete child.layerImageSize;
  child.layerImageStatus = "failed";
  delete child.attributes["image-source"];
  child.attributes["image-capture-error"] = "timeout";
  const cleared = mergeLayerImages(shown, changedLayerImages(source, baseline)!);
  assert.equal(cleared.children[0].layerImageDataUrl, undefined);
  assert.equal(cleared.children[0].attributes?.["image-source"], undefined);
  assert.equal(cleared.children[0].attributes?.["image-capture-error"], "timeout");
  source.children.push(makeNode("0/new"));
  assert.equal(changedLayerImages(source, baseline), null, "a changed tree needs a full preview");
});

test("no filter and all-matching filters preserve node references", () => {
  const root = createTree(100);
  assert.equal(filterTree(root, noFilter), root);
  assert.equal(filterTree(root, { ...noFilter, query: "  ANDROID.  " }), root);
});

test("sparse search keeps ancestors, sibling order and original tree", () => {
  const root = createTree(10);
  const before = JSON.stringify(root);
  const first = root.children[0].children[0];
  const second = root.children[1].children[0];
  first.text = "unique match";
  second.contentDesc = "unique match";
  const expectedOriginal = JSON.stringify(root);
  const filtered = filterTree(root, { ...noFilter, query: "UNIQUE MATCH" });
  assert.ok(filtered);
  assert.deepEqual([...flattenNodes(filtered).keys()], ["0", "0/0", first.id, "0/1", second.id]);
  assert.equal(filtered.children[0].children[0], first);
  assert.equal(JSON.stringify(root), expectedOriginal);
  assert.notEqual(before, expectedOriginal);
});

test("parent matches do not automatically retain unrelated descendants", () => {
  const root = createTree(6);
  root.text = "only-parent";
  assert.deepEqual(filterTree(root, { ...noFilter, query: "only-parent" })?.children, []);
  assert.equal(filterTree(root, { ...noFilter, query: "no-such-node" }), null);
});

test("query, interactive and identified filters combine on the same node", () => {
  const root = makeNode("0");
  root.text = null;
  root.resourceId = null;
  root.contentDesc = null;
  root.clickable = root.focusable = root.scrollable = false;
  const child = makeNode("0/0", 1);
  child.text = "wanted";
  root.children.push(child);
  assert.equal(filterTree(root, { query: "wanted", interactiveOnly: true, identifiedOnly: true }), null);
  child.scrollable = true;
  assert.equal(filterTree(root, { query: "wanted", interactiveOnly: true, identifiedOnly: true }), root);
  child.text = null;
  assert.equal(filterTree(root, { ...noFilter, identifiedOnly: true }), null);
});

test("explicit Debug name wins without replacing real text, class or resource ID", () => {
  const node = makeNode("0");
  node.text = "原文本";
  node.resourceId = "app:id/real_id";
  node.attributes = { "debug-name": "业务名称" };
  assert.equal(nodeDisplayLabel(node), "业务名称");
  assert.equal(filterTree(node, { ...noFilter, query: "业务名称" }), node);
  node.text = null;
  node.resourceId = null;
  node.contentDesc = null;
  assert.equal(filterTree(node, { ...noFilter, identifiedOnly: true }), node);
  delete node.attributes["debug-name"];
  assert.equal(nodeDisplayLabel(node), "ViewGroup");
});

test("deep input is traversed without recursive stack overflow", () => {
  const root = makeNode("deep-0");
  let parent = root;
  for (let index = 1; index < 20_000; index += 1) {
    const child = makeNode(`deep-${index}`, index);
    parent.children.push(child);
    parent = child;
  }
  parent.text = "deepest-match";
  assert.equal(flattenNodes(root).size, 20_000);
  assert.equal(filterTree(root, { ...noFilter, query: "deepest-match" }), root);
  assert.equal(filterTree(root, { ...noFilter, query: "no-such-node" }), null);
});

test("selection invalidates only its exact slash-separated branch", () => {
  assert.equal(selectionInBranch("0/1", "0/1"), "0/1");
  assert.equal(selectionInBranch("0/1", "0/1/2"), "0/1/2");
  assert.equal(selectionInBranch("0/1", "0/10/2"), null);
  assert.equal(selectionInBranch("0/1/2", "0/1"), null);
  assert.equal(selectionInBranch("0/1", null), null);
});

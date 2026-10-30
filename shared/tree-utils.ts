import type { LayerImageUpdate, UiNode } from "./types";

export type TreeFilter = {
  query: string;
  interactiveOnly: boolean;
  identifiedOnly: boolean;
};

// Use the same predicate for filtering and for distinguishing matches from
// the ancestor rows kept solely to explain the hierarchy.
export function createTreeMatcher(filter: TreeFilter) {
  const query = filter.query.trim().toLocaleLowerCase();
  return (node: UiNode) => {
    if (filter.interactiveOnly && !node.clickable && !node.focusable && !node.scrollable) return false;
    if (filter.identifiedOnly && !node.attributes?.["debug-name"] && !node.text && !node.resourceId && !node.contentDesc) return false;
    return !query || [node.id, node.className, node.attributes?.["debug-name"], node.text, node.resourceId, node.contentDesc]
      .filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
  };
}

// Return plain strings for React to render. Queries are literal text, never
// regex instructions or HTML, and matching preserves the original spelling.
export function treeTextSegments(value: string, query: string): { text: string; match: boolean }[] {
  const literal = query.trim();
  if (!literal) return [{ text: value, match: false }];
  const pattern = new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const parts: { text: string; match: boolean }[] = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > cursor) parts.push({ text: value.slice(cursor, match.index), match: false });
    parts.push({ text: match[0], match: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length || !parts.length) parts.push({ text: value.slice(cursor), match: false });
  return parts;
}

export function treeSearchDetail(node: UiNode, label: string, query: string) {
  const literal = query.trim().toLocaleLowerCase();
  if (!literal || label.toLocaleLowerCase().includes(literal)) return null;
  const fields = [
    ["名称", node.attributes?.["debug-name"]], ["文本", node.text], ["描述", node.contentDesc],
    ["ID", node.resourceId], ["类型", node.className], ["路径", node.id],
  ];
  for (const [field, value] of fields) {
    if (!value) continue;
    const offset = value.toLocaleLowerCase().indexOf(literal);
    if (offset >= 0) return { field, value, display: offset > 12 ? `…${value.slice(offset - 12)}` : value };
  }
  return null;
}

export function nodeShortClass(node: UiNode) {
  return node.className?.split(".").pop() ?? "node";
}

export function nodeResourceName(node: UiNode) {
  const name = node.resourceId?.split("/").pop()?.trim();
  // Unresolved numeric IDs remain searchable identifiers, not readable names.
  return name && !/^(?:[+-]?\d+|0x[\da-f]+)$/i.test(name) ? name : null;
}

export function nodeDisplayLabel(node: UiNode) {
  return node.attributes?.["debug-name"]?.trim() || node.text?.trim() || node.contentDesc?.trim() || nodeResourceName(node) || nodeShortClass(node);
}

type TreeNodeKind = "activity" | "window" | "stub" | "input" | "checkbox" | "radio" | "switch" | "slider" | "progress" | "button" | "web" | "video" | "surface" | "image" | "text" | "pager" | "drawer" | "grid" | "list" | "scroll" | "constraint" | "linear" | "frame" | "container" | "leaf";

// Match real framework classes, not the spelling of a custom subclass. The SDK
// supplies the current class first, followed by its nearest-to-farthest parents.
const ANDROID_TREE_KINDS = new Map<string, TreeNodeKind>([
  ["com.android.internal.policy.DecorView", "window"],
  ["com.android.internal.policy.impl.PhoneWindow$DecorView", "window"],
  ["android.view.ViewStub", "stub"], ["androidx.appcompat.widget.ViewStubCompat", "stub"],
  ["android.widget.EditText", "input"], ["android.widget.SearchView", "input"], ["androidx.appcompat.widget.SearchView", "input"],
  ["android.widget.CheckBox", "checkbox"], ["android.widget.RadioButton", "radio"],
  ["android.widget.Switch", "switch"], ["android.widget.ToggleButton", "switch"], ["androidx.appcompat.widget.SwitchCompat", "switch"],
  ["android.widget.SeekBar", "slider"], ["android.widget.ProgressBar", "progress"],
  ["android.widget.Button", "button"], ["android.widget.ImageButton", "button"],
  ["android.webkit.WebView", "web"], ["android.widget.VideoView", "video"],
  ["androidx.media3.ui.PlayerView", "video"], ["com.google.android.exoplayer2.ui.PlayerView", "video"],
  ["android.view.SurfaceView", "surface"], ["android.view.TextureView", "surface"],
  ["android.widget.ImageView", "image"], ["android.widget.TextView", "text"],
  ["androidx.viewpager.widget.ViewPager", "pager"], ["androidx.viewpager2.widget.ViewPager2", "pager"], ["android.support.v4.view.ViewPager", "pager"],
  ["androidx.drawerlayout.widget.DrawerLayout", "drawer"], ["androidx.slidingpanelayout.widget.SlidingPaneLayout", "drawer"],
  ["android.support.v4.widget.DrawerLayout", "drawer"], ["android.support.v4.widget.SlidingPaneLayout", "drawer"],
  ["android.widget.GridView", "grid"], ["android.widget.ListView", "list"],
  ["androidx.recyclerview.widget.RecyclerView", "list"], ["android.support.v7.widget.RecyclerView", "list"],
  ["android.widget.ScrollView", "scroll"], ["android.widget.HorizontalScrollView", "scroll"],
  ["androidx.core.widget.NestedScrollView", "scroll"], ["android.support.v4.widget.NestedScrollView", "scroll"],
  ["androidx.constraintlayout.widget.ConstraintLayout", "constraint"], ["android.support.constraint.ConstraintLayout", "constraint"],
  ["android.widget.RelativeLayout", "constraint"], ["android.widget.LinearLayout", "linear"], ["android.widget.FrameLayout", "frame"],
  ["android.view.ViewGroup", "container"], ["android.view.View", "leaf"],
]);

function inheritedTreeNodeKind(node: UiNode): TreeNodeKind | null {
  const chain = node.attributes?.["sdk-class-hierarchy"];
  // These are the SDK producer's limits (24 names, 512 chars/name), checked
  // before splitting imported snapshot data. QML keeps its existing type rules.
  if (typeof chain !== "string" || chain.length > 24 * 512 + 23 * 3 || !node.className
      || node.attributes?.["inspection-source"] === "debug-qml" || node.attributes?.["qml-debug-id"] !== undefined
      || /(?:^|\.)QQuick|_(?:QMLTYPE|QML)_\d+$/.test(node.className)) return null;
  const classes = chain.split(" → ", 25);
  if (!classes.length || classes.length > 24 || classes[0] !== node.className || classes.at(-1) !== "android.view.View"
      || new Set(classes).size !== classes.length || !classes.every(name => /^[\w.$]{1,512}$/.test(name))) return null;
  for (const name of classes) {
    const kind = ANDROID_TREE_KINDS.get(name);
    if (kind) return kind;
  }
  return null;
}

export function treeNodeKind(node: UiNode) {
  const inherited = inheritedTreeNodeKind(node);
  if (inherited) return inherited;
  // Older Android and QML snapshots retain the existing class/structure fallback.
  const name = nodeShortClass(node).replace(/_(?:QMLTYPE|QML)_\d+$/, "");
  if (/Activity$/.test(name)) return "activity";
  if (/(DecorView|Window|Dialog)$/.test(name)) return "window";
  if (/ViewStub(?:Compat)?$/.test(name)) return "stub";
  if (/(EditText|TextInput|TextField|TextArea|SearchView)$/.test(name)) return "input";
  if (/CheckBox$/.test(name)) return "checkbox";
  if (/RadioButton$/.test(name)) return "radio";
  if (/(Switch(?:Compat|Material)?|ToggleButton)$/.test(name)) return "switch";
  if (/(SeekBar|Slider)$/.test(name)) return "slider";
  if (/(ProgressBar|ProgressIndicator|BusyIndicator)$/.test(name)) return "progress";
  if (/Button$/.test(name)) return "button";
  if (/(WebView|WebEngineView)$/.test(name)) return "web";
  if (/(VideoView|PlayerView|VideoOutput)$/.test(name)) return "video";
  if (/(SurfaceView|TextureView)$/.test(name)) return "surface";
  if (/(ImageView|DraweeView)$/.test(name) || /^(?:QQuick)?(?:Animated)?Image$/.test(name)) return "image";
  if (/TextView$/.test(name) || /^(?:QQuick)?(?:Text|Label)$/.test(name)) return "text";
  if (/(ViewPager2?|PagerView|SwipeView)$/.test(name)) return "pager";
  if (/(DrawerLayout|SlidingPaneLayout|SlidingPanelLayout)$/.test(name)) return "drawer";
  if (/GridView$/.test(name)) return "grid";
  if (/(RecyclerView|ListView)$/.test(name)) return "list";
  if (/(ScrollView|Flickable)$/.test(name) || node.scrollable) return "scroll";
  if (/(ConstraintLayout|RelativeLayout)$/.test(name)) return "constraint";
  if (/LinearLayout$/.test(name) || /^(?:QQuick)?(?:Row|Column)(?:Layout)?$/.test(name)) return "linear";
  if (/FrameLayout$/.test(name)) return "frame";
  return node.children.length > 0 || /(Layout|ViewGroup)$/.test(name) || /^(?:QQuick)?Item$/.test(name) ? "container" : "leaf";
}

// The parser assigns slash-separated positional IDs. Include the separator so
// a selection under "0/10" never invalidates the independent "0/1" branch.
export function selectionInBranch(branchId: string, selectedId: string | null) {
  return selectedId === branchId || selectedId?.startsWith(`${branchId}/`) ? selectedId : null;
}

export function flattenNodes(root: UiNode) {
  const nodes = new Map<string, UiNode>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes.set(node.id, node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }
  return nodes;
}

export function replaceTreeBranch(root: UiNode, branchId: string, branch: UiNode): UiNode {
  const parts = branchId.split("/");
  if (parts[0] !== root.id || branch.id !== branchId || !parts.slice(1).every(part => /^\d+$/.test(part))) throw new Error("刷新分支标识无效");
  const path = [root];
  for (const part of parts.slice(1)) {
    const child = path.at(-1)!.children[Number(part)];
    if (!child) throw new Error("刷新分支已不存在");
    path.push(child);
  }
  if (path.at(-1)!.attributes?.["view-ref"] !== branch.attributes?.["view-ref"]) throw new Error("刷新分支对象已变化");
  let replacement = branch;
  for (let index = path.length - 2; index >= 0; index--) {
    const parent = path[index], childIndex = Number(parts[index + 1]);
    const children = [...parent.children];
    children[childIndex] = replacement;
    replacement = { ...parent, children };
  }
  return replacement;
}

export function remapViewNodeIds(before: UiNode, after: UiNode): Map<string, string> {
  const latest = flattenNodes(after);
  const byRef = new Map<string, UiNode>();
  for (const node of latest.values()) if (node.attributes?.["view-ref"]) byRef.set(node.attributes["view-ref"], node);
  const mapping = new Map<string, string>();
  for (const old of flattenNodes(before).values()) {
    const ref = old.attributes?.["view-ref"];
    const current = ref ? byRef.get(ref) : latest.get(old.id);
    if (current?.className === old.className && (!ref || current.attributes?.["view-ref"] === ref)) mapping.set(old.id, current.id);
  }
  return mapping;
}

function layerImageState(node: UiNode): LayerImageUpdate {
  return {
    id: node.id, layerImageDataUrl: node.layerImageDataUrl, layerImageSize: node.layerImageSize,
    bounds: node.bounds ? { ...node.bounds } : undefined,
    layerImageEmpty: node.layerImageEmpty, layerImageStatus: node.layerImageStatus,
    layerCapturePlacement: node.layerCapturePlacement,
    imageSource: node.attributes?.["image-source"], imageCaptureError: node.attributes?.["image-capture-error"],
    imageCaptureSource: node.attributes?.["image-capture-source"],
    skipDraw: node.attributes?.["skip-draw"],
  };
}

export function layerImageBaseline(root: UiNode) {
  return new Map([...flattenNodes(root)].map(([id, node]) => [id, layerImageState(node)]));
}

export function layerImageUpdates(root: UiNode): LayerImageUpdate[] {
  return [...flattenNodes(root).values()].map(layerImageState).filter((update) => Boolean(update.layerImageDataUrl));
}

export function changedLayerImages(root: UiNode, previous: Map<string, LayerImageUpdate>): LayerImageUpdate[] | null {
  const nodes = flattenNodes(root);
  if (nodes.size !== previous.size || [...nodes.keys()].some(id => !previous.has(id))) return null;
  // Re-anchor the whole preview before sending pixels from a moved/resized branch.
  // Inspect all nodes first so a rejected diff never partially advances the baseline.
  for (const node of nodes.values()) {
    const before = previous.get(node.id)!.bounds, next = node.bounds;
    if (before?.left !== next?.left || before?.top !== next?.top
      || before?.right !== next?.right || before?.bottom !== next?.bottom) return null;
  }
  const updates: LayerImageUpdate[] = [];
  for (const node of nodes.values()) {
    const next = layerImageState(node), before = previous.get(node.id)!;
    if (next.layerImageDataUrl === before.layerImageDataUrl && next.layerImageStatus === before.layerImageStatus
      && next.layerImageEmpty === before.layerImageEmpty && next.layerImageSize?.width === before.layerImageSize?.width
      && next.layerImageSize?.height === before.layerImageSize?.height && next.imageSource === before.imageSource
      && next.imageCaptureSource === before.imageCaptureSource
      && next.imageCaptureError === before.imageCaptureError && next.skipDraw === before.skipDraw
      && JSON.stringify(next.layerCapturePlacement) === JSON.stringify(before.layerCapturePlacement)) continue;
    previous.set(node.id, next);
    updates.push(next);
  }
  return updates;
}

export function mergeLayerImages(root: UiNode, updates: readonly LayerImageUpdate[]): UiNode {
  if (!updates.length) return root;
  const changed = new Map(updates.map(update => [update.id, update]));
  type Frame = { node: UiNode; nextChild: number; children: UiNode[] | null };
  const stack: Frame[] = [{ node: root, nextChild: 0, children: null }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.nextChild < frame.node.children.length) {
      stack.push({ node: frame.node.children[frame.nextChild++], nextChild: 0, children: null });
      continue;
    }
    const { node, children } = frame, update = changed.get(node.id);
    let result = children ? { ...node, children } : node;
    if (update) {
      const attributes = { ...node.attributes };
      for (const [key, value] of [["image-source", update.imageSource], ["image-capture-source", update.imageCaptureSource], ["image-capture-error", update.imageCaptureError], ["skip-draw", update.skipDraw]] as const) {
        if (value === undefined) delete attributes[key]; else attributes[key] = value;
      }
      result = {
        ...result, layerImageDataUrl: update.layerImageDataUrl, layerImageSize: update.layerImageSize,
        layerImageEmpty: update.layerImageEmpty, layerImageStatus: update.layerImageStatus, attributes,
        layerCapturePlacement: update.layerCapturePlacement,
      };
    }
    stack.pop();
    if (!stack.length) return result;
    const parent = stack[stack.length - 1];
    if (result !== node) {
      parent.children ??= [...parent.node.children];
      parent.children[parent.nextChild - 1] = result;
    }
  }
  return root;
}

export function filterTree(root: UiNode, filter: TreeFilter): UiNode | null {
  const query = filter.query.trim().toLocaleLowerCase();
  if (!query && !filter.interactiveOnly && !filter.identifiedOnly) return root;

  const matches = createTreeMatcher(filter);

  // Iterative postorder keeps ancestor paths without exhausting the JS call
  // stack on deep trees. Reuse unchanged nodes so memoized branches stay valid.
  type Frame = { node: UiNode; nextChild: number; children: UiNode[] };
  const stack: Frame[] = [{ node: root, nextChild: 0, children: [] }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.nextChild < frame.node.children.length) {
      stack.push({ node: frame.node.children[frame.nextChild++], nextChild: 0, children: [] });
      continue;
    }
    stack.pop();
    const { node, children } = frame;
    const kept = children.length > 0 || matches(node);
    const unchanged = children.length === node.children.length && children.every((child, index) => child === node.children[index]);
    const result = kept ? (unchanged ? node : { ...node, children }) : null;
    if (stack.length === 0) return result;
    if (result) stack[stack.length - 1].children.push(result);
  }
  return null;
}

import type { LayerImageUpdate, UiNode } from "./types";

export type TreeFilter = {
  query: string;
  interactiveOnly: boolean;
  identifiedOnly: boolean;
};

export function nodeShortClass(node: UiNode) {
  return node.className?.split(".").pop() ?? "node";
}

export function nodeDisplayLabel(node: UiNode) {
  return node.attributes?.["debug-name"]?.trim() || node.text?.trim() || node.contentDesc?.trim() || node.resourceId?.split("/").pop() || nodeShortClass(node);
}

export function treeNodeKind(node: UiNode) {
  // ponytail: class suffixes cover known types; custom types stay generic until snapshots expose superclass metadata.
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
    layerImageEmpty: node.layerImageEmpty, layerImageStatus: node.layerImageStatus,
    imageSource: node.attributes?.["image-source"], imageCaptureError: node.attributes?.["image-capture-error"],
    skipDraw: node.attributes?.["skip-draw"],
  };
}

export function layerImageBaseline(root: UiNode) {
  return new Map([...flattenNodes(root)].map(([id, node]) => [id, layerImageState(node)]));
}

export function changedLayerImages(root: UiNode, previous: Map<string, LayerImageUpdate>): LayerImageUpdate[] | null {
  const nodes = flattenNodes(root);
  if (nodes.size !== previous.size || [...nodes.keys()].some(id => !previous.has(id))) return null;
  const updates: LayerImageUpdate[] = [];
  for (const node of nodes.values()) {
    const next = layerImageState(node), before = previous.get(node.id)!;
    if (next.layerImageDataUrl === before.layerImageDataUrl && next.layerImageStatus === before.layerImageStatus
      && next.layerImageEmpty === before.layerImageEmpty && next.layerImageSize?.width === before.layerImageSize?.width
      && next.layerImageSize?.height === before.layerImageSize?.height && next.imageSource === before.imageSource
      && next.imageCaptureError === before.imageCaptureError && next.skipDraw === before.skipDraw) continue;
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
      for (const [key, value] of [["image-source", update.imageSource], ["image-capture-error", update.imageCaptureError], ["skip-draw", update.skipDraw]] as const) {
        if (value === undefined) delete attributes[key]; else attributes[key] = value;
      }
      result = {
        ...result, layerImageDataUrl: update.layerImageDataUrl, layerImageSize: update.layerImageSize,
        layerImageEmpty: update.layerImageEmpty, layerImageStatus: update.layerImageStatus, attributes,
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

  const matches = (node: UiNode) => {
    if (filter.interactiveOnly && !node.clickable && !node.focusable && !node.scrollable) return false;
    if (filter.identifiedOnly && !node.attributes?.["debug-name"] && !node.text && !node.resourceId && !node.contentDesc) return false;
    if (!query) return true;
    return [node.id, node.className, node.attributes?.["debug-name"], node.text, node.resourceId, node.contentDesc]
      .filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
  };

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

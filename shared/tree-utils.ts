import type { UiNode } from "./types";

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

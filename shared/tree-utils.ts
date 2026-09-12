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
  return node.text?.trim() || node.contentDesc?.trim() || node.resourceId?.split("/").pop() || nodeShortClass(node);
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
    if (filter.identifiedOnly && !node.text && !node.resourceId && !node.contentDesc) return false;
    if (!query) return true;
    return [node.id, node.className, node.text, node.resourceId, node.contentDesc]
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

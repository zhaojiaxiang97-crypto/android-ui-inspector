import { nodePresentationStatus } from "./node-presentation-status";
import type { UiNode } from "./types";

// Visibility is about the displayed plane, not the tree branch. An expanded
// empty wrapper can disappear while its children remain. A folded wrapper must
// keep its combined image unless every descendant is also confirmed empty.
export function emptyLayerIds(root: UiNode, expandedIds: ReadonlySet<string>, groupImageIds: ReadonlySet<string> = new Set()): Set<string> {
  const ordered: UiNode[] = [], stack = [root];
  while (stack.length) {
    const node = stack.pop()!; ordered.push(node);
    for (const child of node.children) stack.push(child);
  }
  const emptyBranches = new Set<string>(), emptyPlanes = new Set<string>();
  for (let i = ordered.length - 1; i >= 0; i--) {
    const node = ordered[i], state = nodePresentationStatus(node).ownImage.code;
    if (state !== "empty" && state !== "structural") continue;
    const branchEmpty = !groupImageIds.has(node.id) && node.children.every(child => emptyBranches.has(child.id));
    if (branchEmpty) emptyBranches.add(node.id);
    const folded = node.children.length > 0 && !expandedIds.has(node.id);
    if (!folded || branchEmpty) emptyPlanes.add(node.id);
  }
  return emptyPlanes;
}

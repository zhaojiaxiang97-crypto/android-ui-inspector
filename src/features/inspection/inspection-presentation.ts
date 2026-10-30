import type { UiNode } from "../../../shared/types";
import { flattenNodes, remapViewNodeIds } from "../../../shared/tree-utils";
import { initialTreeExpansion, reconcileTreeExpansion, type TreeCollapsePreference } from "../../../shared/tree-collapse";

/** Build identity mapping once, then reconcile the latest selection and folds independently. */
export function captureTreePresentation(previous: UiNode | null, root: UiNode | null, touched: boolean, preference: TreeCollapsePreference) {
  const nodes = previous && root ? flattenNodes(root) : null;
  const remap = previous && root ? remapViewNodeIds(previous, root) : null;
  return {
    select: (selected: UiNode | null) => nodes && remap ? (selected && nodes.get(remap.get(selected.id) ?? "")) ?? root : root,
    expand: (expanded: ReadonlySet<string>) => !root ? new Set<string>()
      : previous && touched ? reconcileTreeExpansion(previous, root, expanded, preference) : initialTreeExpansion(root, preference),
    restore: Boolean(previous && root),
  };
}

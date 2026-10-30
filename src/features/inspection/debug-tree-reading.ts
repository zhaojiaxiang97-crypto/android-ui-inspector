import type { DebugTreeNode } from "../../../shared/debug-metadata";

/** A branch keeps its keys, scalar type and children; the existing value copy stays unchanged. */
export function debugTreeBranchCopyValue(node: DebugTreeNode) {
  return JSON.stringify(node);
}

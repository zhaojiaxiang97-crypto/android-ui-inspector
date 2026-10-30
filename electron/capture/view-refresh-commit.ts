import { flattenNodes, replaceTreeBranch } from "../../shared/tree-utils";
import type { UiSnapshot, ViewRefreshResult } from "../../shared/types";
type Session = { requestId: string; snapshot: UiSnapshot };

/** Shared by the IPC handler and regression tests: never publish into a replaced session. */
export function commitViewRefresh(session: Session, current: Session | undefined, nodeId: string, result: ViewRefreshResult, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (current !== session || !session.snapshot.root) return;
  const old = flattenNodes(session.snapshot.root).get(nodeId);
  const updated = result.branch ?? (result.nodes[0] && old ? { ...result.nodes[0], children: old.children } : null);
  if (!updated) return;
  const root = replaceTreeBranch(session.snapshot.root, nodeId, updated);
  session.snapshot = { ...session.snapshot, root, nodeCount: flattenNodes(root).size };
}

import { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { createNodeHoverStore } from "../../../shared/node-hover";
import type { NodeHoverSource } from "../../../shared/node-hover";
import type { UiNode } from "../../../shared/types";
import { indexTree } from "../../../shared/visible-tree";

type NodeHoverStore = ReturnType<typeof createNodeHoverStore>;
const NodeHoverContext = createContext<NodeHoverStore | null>(null);
const emptyStore = {
  getSnapshot: () => null,
  getServerSnapshot: () => null,
  subscribe: (_listener: () => void) => () => {},
  publishHover: (_nodeId: string | null, _source: NodeHoverSource) => {},
  clearHover: (_source: NodeHoverSource) => {},
};

export function NodeHoverProvider({ root, sessionKey, children }: {
  root: UiNode | null; sessionKey: string | number; children: ReactNode;
}) {
  const store = useMemo(() => createNodeHoverStore(root ? indexTree(root).keys() : []), [root, sessionKey]);
  useLayoutEffect(() => {
    store.activate();
    return () => store.deactivate();
  }, [store]);
  return <NodeHoverContext.Provider value={store}>{children}</NodeHoverContext.Provider>;
}

export function useNodeHover() {
  const store = useContext(NodeHoverContext) ?? emptyStore;
  const hover = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return { hover, publishHover: store.publishHover, clearHover: store.clearHover };
}

export function useNodeHoverActions() {
  const store = useContext(NodeHoverContext) ?? emptyStore;
  return useMemo(() => ({ publishHover: store.publishHover, clearHover: store.clearHover }), [store]);
}

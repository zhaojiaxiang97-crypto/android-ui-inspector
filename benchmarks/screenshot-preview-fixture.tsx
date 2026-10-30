import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { ScreenshotPreview as Preview } from "../src/components/ScreenshotPreview";
import type { LayerFocus, LayerMenuAction, TreeDoubleClickAction, UiNode } from "../shared/types";

type Props = Omit<ComponentProps<typeof Preview>, "layerFocus" | "hiddenNodeIds" | "doubleClickAction" | "onDoubleClick" | "onLayerAction" | "onOpenLayerMenu"> & {
  onExpand?: (node: UiNode) => void;
  doubleClickAction?: TreeDoubleClickAction;
  onDoubleClick?: (node: UiNode) => void;
};

// Component-only coordinate tests supply a controlled presentation. The App
// checks exercise the real workspace owner and its restoration/lifecycle rules.
export function ScreenshotPreview({ onExpand, doubleClickAction = "expand", onDoubleClick, ...props }: Props) {
  const [layerFocus, setFocus] = useState<LayerFocus | null>(null);
  const [hiddenNodeIds, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const menuRevision = useRef(0);
  useLayoutEffect(() => { menuRevision.current++; setFocus(null); setHidden(new Set());
    return () => { menuRevision.current++; }; }, [props.sessionKey ?? props.src]);
  const action = (value: LayerMenuAction, node: UiNode | null = props.selectedNode) => {
    menuRevision.current++;
    if (value === "exit-focus") setFocus(null);
    if (value === "restore") setHidden(new Set());
    if (node && value === "hide") setHidden(current => new Set([...current, node.id]));
    if (node && (value === "focus" || value === "focus-branch")) setFocus({ node, kind: value === "focus" ? "layer" : "branch" });
  };
  const menu = async (node: UiNode | null) => {
    const request = ++menuRevision.current;
    if (node) props.onSelect(node);
    const choice = await window.electronApi.showLayerMenu(Boolean(node?.visibleToUser && node.bounds && !hiddenNodeIds.has(node.id)), hiddenNodeIds.size > 0, Boolean(layerFocus));
    if (request === menuRevision.current) action(choice, node);
  };
  return <Preview {...props} layerFocus={layerFocus} hiddenNodeIds={hiddenNodeIds} doubleClickAction={doubleClickAction}
    onLayerAction={action} onOpenLayerMenu={node => void menu(node)} onDoubleClick={node => {
      if (onDoubleClick) onDoubleClick(node);
      else if (doubleClickAction === "focus-branch") action("focus-branch", node);
      else if (node.children.length && !props.expandedNodeIds.has(node.id)) onExpand?.(node);
    }} />;
}

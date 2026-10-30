import { memo, useState } from "react";
import { nodeDisplayLabel, nodeShortClass, selectionInBranch } from "../../shared/tree-utils";
import type { UiNode } from "../../shared/types";

export type UiTreeNodeProps = {
  node: UiNode;
  depth: number;
  selectedId: string | null;
  forceExpand: boolean;
  onSelect: (node: UiNode) => void;
};

// Frozen memo-only baseline for benchmarks. The app now uses UiTree.
// Use a different inner name: recursive JSX must resolve to the memo wrapper.
export const UiTreeNode = memo(function TreeNode({ node, depth, selectedId, forceExpand, onSelect }: UiTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = node.children.length > 0;
  const selected = selectedId === node.id;
  const isExpanded = forceExpand || expanded;

  return (
    <div className="tree-node" role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined} aria-selected={selected}>
      <button
        className={`tree-row ${selected ? "selected" : ""}`}
        type="button"
        style={{ paddingLeft: `${14 + depth * 18}px` }}
        onClick={() => onSelect(node)}
      >
        <span
          className={`tree-chevron ${hasChildren ? "has-children" : "leaf"}`}
          onClick={(event) => {
            if (hasChildren) {
              event.stopPropagation();
              setExpanded((value) => !value);
            }
          }}
        >
          {hasChildren ? (isExpanded ? "⌄" : "›") : "·"}
        </span>
        <span className="tree-class">{nodeShortClass(node)}</span>
        <span className="tree-label">{nodeDisplayLabel(node)}</span>
        {node.clickable && <span className="tree-flag">tap</span>}
      </button>
      {isExpanded && hasChildren && (
        <div className="tree-children" role="group">
          {node.children.map((child) => (
            <UiTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectionInBranch(child.id, selectedId)}
              forceExpand={forceExpand}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
});

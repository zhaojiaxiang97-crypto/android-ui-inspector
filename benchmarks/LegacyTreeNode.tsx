import { memo, useState } from "react";
import { nodeDisplayLabel, nodeShortClass } from "../shared/tree-utils";
import type { UiTreeNodeProps } from "../src/components/UiTreeNode";

// Frozen pre-fix renderer for A/B measurement. The inner name intentionally
// shadows the memo wrapper and forwards every selection to every child, exactly
// as App.tsx did before the performance fix. Never import this into the app.
export const LegacyTreeNode = memo(function LegacyTreeNode({ node, depth, selectedId, forceExpand, onSelect }: UiTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = node.children.length > 0;
  const selected = selectedId === node.id;
  const isExpanded = forceExpand || expanded;
  return (
    <div className="tree-node" role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined} aria-selected={selected}>
      <button className={`tree-row ${selected ? "selected" : ""}`} type="button" style={{ paddingLeft: `${14 + depth * 18}px` }} onClick={() => onSelect(node)}>
        <span className={`tree-chevron ${hasChildren ? "has-children" : "leaf"}`} onClick={(event) => {
          if (hasChildren) {
            event.stopPropagation();
            setExpanded((value) => !value);
          }
        }}>{hasChildren ? (isExpanded ? "⌄" : "›") : "·"}</span>
        <span className="tree-class">{nodeShortClass(node)}</span>
        <span className="tree-label">{nodeDisplayLabel(node)}</span>
        {node.clickable && <span className="tree-flag">tap</span>}
      </button>
      {isExpanded && hasChildren && (
        <div className="tree-children" role="group">
          {node.children.map((child) => (
            <LegacyTreeNode key={child.id} node={child} depth={depth + 1} selectedId={selectedId} forceExpand={forceExpand} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
});

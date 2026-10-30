import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UiNode } from "../../shared/types";
import { nodeDisplayLabel } from "../../shared/tree-utils";
import { findNodePath } from "../features/inspection/locators";
import "../styles/node-navigation.css";

export function NodePathNavigator({ root, node, disabled = false, onNavigate }: {
  root: UiNode; node: UiNode; disabled?: boolean;
  onNavigate: (node: UiNode, sourceRoot: UiNode) => boolean;
}) {
  const path = useMemo(() => {
    const found = findNodePath(root, node.id);
    return found?.[found.length - 1] === node ? found : [];
  }, [root, node]);
  const [expanded, setExpanded] = useState(false);
  const fullPathId = useId();
  const current = useRef<HTMLSpanElement>(null);
  const overflow = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ root: UiNode; node: UiNode } | null>(null);
  useLayoutEffect(() => {
    setExpanded(false);
    const requested = pending.current;
    pending.current = null;
    if (requested?.root === root && requested.node === node) current.current?.focus({ preventScroll: true });
  }, [root, node, onNavigate, disabled]);

  if (!path.length) return null;
  const omitted = path.length > 4 ? path.length - 3 : 0;
  const compact = omitted ? [path[0], null, ...path.slice(-2)] : path;
  const description = (item: UiNode, level: number) => `${level + 1}级 · ${nodeDisplayLabel(item)}\n${item.className ?? ""}\n#${item.id}`;
  function navigate(target: UiNode) {
    if (disabled) return;
    pending.current = { root, node: target };
    if (!onNavigate(target, root)) pending.current = null;
  }
  function entry(item: UiNode, level: number, compactEntry: boolean) {
    const title = description(item, level);
    return item === node
      ? <span className="inspector-path-current" aria-current="location" tabIndex={-1} title={title} ref={compactEntry ? current : undefined}>{nodeDisplayLabel(item)}</span>
      : <button className="inspector-path-node" type="button" disabled={disabled} title={title} aria-label={`定位到第${level + 1}级：${nodeDisplayLabel(item)}`}
          data-path-node-id={item.id} onClick={() => navigate(item)}>{nodeDisplayLabel(item)}</button>;
  }
  return <nav className="inspector-node-path" aria-label="控件层级路径" onKeyDown={event => {
    if (event.key !== "Escape" || !expanded) return;
    event.preventDefault(); event.stopPropagation();
    setExpanded(false); overflow.current?.focus({ preventScroll: true });
  }}>
    <div className="inspector-path-heading">控件路径 <span>{path.length}级</span></div>
    <ol className="inspector-path-compact">
      {compact.map((item, index) => <li key={item ? `node:${item.id}` : "overflow"} className={item ? undefined : "inspector-path-omission"}>
        {index > 0 && <span className="inspector-path-separator" aria-hidden="true">›</span>}
        {item ? entry(item, path.indexOf(item), true)
          : <button className="inspector-path-overflow" type="button" ref={overflow} aria-expanded={expanded} aria-controls={fullPathId}
            aria-label={`${expanded ? "收起" : "展开"}完整控件路径`} title={`查看完整路径，中间还有${omitted}级`}
            onClick={() => setExpanded(value => !value)}>…</button>}
      </li>)}
    </ol>
    {expanded && <ol className="inspector-path-full" id={fullPathId} aria-label="完整控件路径">
      {path.map((item, level) => <li key={item.id}><span className="inspector-path-depth" aria-hidden="true">{level + 1}</span>{entry(item, level, false)}</li>)}
    </ol>}
  </nav>;
}

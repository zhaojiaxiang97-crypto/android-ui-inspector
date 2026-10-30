import { useLayoutEffect, useMemo, useRef } from "react";
import type { UiNode } from "../../shared/types";
import { layoutRelationReasons, layoutRuleLabels, layoutRuleValue, resolveLayoutRelations, type LayoutRules } from "../../shared/layout-relations";
import { nodeDisplayLabel } from "../../shared/tree-utils";
import "../styles/layout-relations.css";

export type LayoutRulePropertiesProps = {
  root: UiNode; node: UiNode; rules: LayoutRules;
  onNavigateNode?: (node: UiNode, sourceRoot: UiNode) => boolean;
  navigationDisabled?: boolean;
  onCopyValue?: (label: string, value: string) => void;
};

export function LayoutRuleProperties({ root, node, rules, onNavigateNode, navigationDisabled = false, onCopyValue }: LayoutRulePropertiesProps) {
  const relations = useMemo(() => resolveLayoutRelations(root, node, rules), [root, node, rules]);
  const context = useRef<LayoutRulePropertiesProps | null>(null);
  useLayoutEffect(() => {
    context.current = { root, node, rules, onNavigateNode, navigationDisabled, onCopyValue };
    return () => { context.current = null; };
  }, [root, node, rules, onNavigateNode, navigationDisabled, onCopyValue]);
  return <>{relations.map(({ name, value, status, target, reason }) => {
    const label = layoutRuleLabels[name] ?? name, raw = String(value);
    const targetLabel = target && nodeDisplayLabel(target);
    const navigable = target && onNavigateNode;
    return <div className="inspector-layout-rule" key={name} data-layout-rule={name} data-layout-relation={status}
      data-inspector-value={raw} data-inspector-terms={[name, targetLabel].filter(Boolean).join(" ")}>
      <dt>{label}</dt>
      <dd>
        <div className="inspector-layout-rule-heading">
          {navigable ? <button type="button" className="inspector-layout-target" disabled={navigationDisabled}
            title={`定位到${targetLabel}\n${target.resourceId ?? ""}\n原值：${raw}`}
            aria-label={`定位${label}的目标：${targetLabel}`} data-layout-target-id={target.id}
            onClick={() => {
              const current = context.current;
              if (!current || current.root !== root || current.node !== node || current.rules !== rules
                || current.navigationDisabled || current.onNavigateNode !== onNavigateNode) return;
              current.onNavigateNode?.(target, root);
            }}><span className="inspector-layout-target-label">{targetLabel}</span><span className="inspector-layout-target-arrow" aria-hidden="true">↗</span></button>
            : <span title={raw}>{layoutRuleValue(name, value)}</span>}
          {onCopyValue && <button type="button" className="inspector-field-copy" aria-label={`复制${label}原值`} title={`复制原值：${raw}`}
            onClick={() => onCopyValue(`${label}原值`, raw)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M10 3H3v7" /></svg>
          </button>}
        </div>
        {(target || (reason && layoutRuleValue(name, value) !== raw)) && <div className="inspector-layout-rule-raw" title={raw}>{raw}</div>}
        {reason && <div className="inspector-layout-rule-reason">{layoutRelationReasons[reason]}</div>}
      </dd>
    </div>;
  })}</>;
}

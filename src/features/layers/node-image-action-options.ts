import type { LayerImageScopeOption, QmlGroupImage, UiNode } from "../../../shared/types";
import { nodeImageExportPlan } from "../../../shared/node-image-export";

export function nodeImageScopeOptions(node: UiNode, groupImage: QmlGroupImage | null = null): LayerImageScopeOption[] {
  return (["own", "branch"] as const).map(scope => {
    const plan = nodeImageExportPlan(node, scope, groupImage);
    return { scope, available: plan.kind !== "unavailable", label: plan.label.slice(0, 160), detail: plan.detail.slice(0, 500) };
  });
}

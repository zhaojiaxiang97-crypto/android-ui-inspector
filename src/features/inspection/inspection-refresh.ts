import type { UiNode, UiSnapshot, ViewRefreshResult } from "../../../shared/types";
import { flattenNodes, replaceTreeBranch } from "../../../shared/tree-utils";

export type RefreshedDocument = { before: UiSnapshot; after: UiSnapshot; node: UiNode; scope: "node" | "branch" | "list"; branch?: UiNode };

/** Validate replacement boundaries before any browser state is changed. */
export function refreshedDocument(source: UiSnapshot, node: UiNode, scope: "node" | "branch" | "list", result: ViewRefreshResult): RefreshedDocument {
  const sourceRoot = source.root;
  if (!sourceRoot) throw new Error("当前没有可刷新的控件树。");
  if (scope === "branch" || scope === "list") {
    if (!result.branch) throw new Error("没有返回可更新的分支。");
    const root = replaceTreeBranch(sourceRoot, node.id, result.branch), nodes = flattenNodes(root);
    if (result.failures.some(failure => !nodes.has(failure.id))) throw new Error("分支补图结果无效。");
    return { before: source, after: { ...source, root, nodeCount: nodes.size, layerGroupImages: undefined }, node, scope, branch: result.branch };
  }
  const nodes = flattenNodes(sourceRoot), validId = (id: string) => nodes.has(id) && id === node.id;
  if (!result.nodes.length || result.nodes.some(updated => !validId(updated.id)) || result.failures.some(failure => !validId(failure.id)))
    throw new Error("控件已变化，请重新采集整页。");
  const updates = new Map(result.nodes.map(updated => [updated.id, updated]));
  for (const failure of result.failures) {
    const old = nodes.get(failure.id)!;
    updates.set(failure.id, { ...old, attributes: { ...old.attributes, "image-refresh-error": failure.message } });
  }
  const replace = (current: UiNode): UiNode => {
    const children = current.children.map(replace), updated = updates.get(current.id);
    return updated ? { ...updated, children } : children.some((child, index) => child !== current.children[index]) ? { ...current, children } : current;
  };
  return { before: source, after: { ...source, root: replace(sourceRoot), layerGroupImages: undefined }, node, scope };
}

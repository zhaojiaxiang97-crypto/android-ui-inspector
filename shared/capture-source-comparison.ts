import type { UiBounds, UiNode, UiSnapshot } from "./types";

type Entry = { node: UiNode; parentResourceId: string | null };
type Inventory = { allNodes: number; visibleNodes: number; keyedNodes: number; unkeyedNodes: number;
  ambiguousResourceIds: number; unique: Map<string, Entry> };

function inventory(root: UiNode | null): Inventory {
  const matches = new Map<string, Entry[]>();
  const pending: { node: UiNode; parentResourceId: string | null }[] = root
    ? [{ node: root, parentResourceId: null }] : [];
  let allNodes = 0, visibleNodes = 0, keyedNodes = 0, unkeyedNodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++allNodes > 20_000) throw new Error("比较树超过最大节点范围。");
    if (item.node.visibleToUser) visibleNodes++;
    const key = item.node.resourceId?.trim() || null;
    if (key) { keyedNodes++; const found = matches.get(key) ?? []; found.push(item); matches.set(key, found); }
    else unkeyedNodes++;
    for (const child of item.node.children) pending.push({
      node: child, parentResourceId: key ?? item.parentResourceId,
    });
  }
  const unique = new Map<string, Entry>();
  let ambiguousResourceIds = 0;
  for (const [key, entries] of matches) {
    if (entries.length === 1) unique.set(key, entries[0]);
    else ambiguousResourceIds++;
  }
  return { allNodes, visibleNodes, keyedNodes, unkeyedNodes, ambiguousResourceIds, unique };
}

function sameBounds(a: UiBounds, b: UiBounds) {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/** Offline descriptive comparison only. Semantic and Debug View trees have different contracts,
 * and even matching resource IDs do not authorize a tap or establish same-frame capture. */
export function compareCaptureSources(left: UiSnapshot, right: UiSnapshot) {
  if (!left.inspectionSource || !right.inspectionSource || left.inspectionSource === right.inspectionSource)
    throw new Error("需要提供两个不同且明确标记来源的快照。");
  if (!left.serial || left.serial !== right.serial) throw new Error("只能比较同一设备的两个快照。");
  const a = inventory(left.root), b = inventory(right.root);
  let pairedUniqueResourceIds = 0, classMismatch = 0, visibleMismatch = 0,
    clickableMismatch = 0, enabledMismatch = 0, boundsMismatch = 0,
    boundsUnknown = 0, parentResourceIdMismatch = 0;
  for (const [resourceId, fromLeft] of a.unique) {
    const fromRight = b.unique.get(resourceId);
    if (!fromRight) continue;
    pairedUniqueResourceIds++;
    if (fromLeft.node.className !== fromRight.node.className) classMismatch++;
    if (fromLeft.node.visibleToUser !== fromRight.node.visibleToUser) visibleMismatch++;
    if (fromLeft.node.clickable !== fromRight.node.clickable) clickableMismatch++;
    if (fromLeft.node.enabled !== fromRight.node.enabled) enabledMismatch++;
    if (!fromLeft.node.bounds || !fromRight.node.bounds) boundsUnknown++;
    else if (!sameBounds(fromLeft.node.bounds, fromRight.node.bounds)) boundsMismatch++;
    if (fromLeft.parentResourceId !== fromRight.parentResourceId) parentResourceIdMismatch++;
  }
  return {
    version: 1 as const, sources: [left.inspectionSource, right.inspectionSource],
    left: { nodes: a.allNodes, visibleNodes: a.visibleNodes, keyedNodes: a.keyedNodes,
      unkeyedNodes: a.unkeyedNodes, ambiguousResourceIds: a.ambiguousResourceIds },
    right: { nodes: b.allNodes, visibleNodes: b.visibleNodes, keyedNodes: b.keyedNodes,
      unkeyedNodes: b.unkeyedNodes, ambiguousResourceIds: b.ambiguousResourceIds },
    pairedUniqueResourceIds, onlyLeftUniqueResourceIds: [...a.unique.keys()].filter(key => !b.unique.has(key)).length,
    onlyRightUniqueResourceIds: [...b.unique.keys()].filter(key => !a.unique.has(key)).length,
    classMismatch, visibleMismatch, clickableMismatch, enabledMismatch, boundsMismatch,
    boundsUnknown, parentResourceIdMismatch,
    comparisonValidity: "descriptive-only-different-backend-and-capture-time" as const,
    actionIdentity: "new-verified-same-source-observation-required" as const,
    limitations: "仅唯一resourceId参与字段对比；节点数、坐标、可见性及父链差异可能来自来源语义或采集时间。树和截图非严格同帧，不能据此自动点击。",
  };
}

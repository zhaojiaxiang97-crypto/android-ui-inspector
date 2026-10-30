import { createHash } from "node:crypto";
import type { UiNode } from "../../shared/types";
import type { BranchBinding, BranchGeometryRead, BranchGeometryRow } from "./branch-geometry";

export type BranchRecoveryPlan = { branch: UiNode; parent: UiNode; index: number; path: string[]; original: BranchGeometryRead };
export type BranchRecoverySelection = { plan: BranchRecoveryPlan | null; failed: readonly UiNode[];
  reason: "complete" | "bounded-cluster" | "no-candidates" | "too-many-candidates" | "no-bounded-common-branch" };
function row(node: UiNode, parent: string, branch: boolean): BranchGeometryRow {
  const ref = node.attributes?.["view-ref"], b = node.bounds;
  const children = node.children.map(n => n.attributes?.["view-ref"] ?? "");
  if (!ref || !b || children.some(ref => !ref)) throw new Error("小分支缺少原始身份或几何");
  return { ref, parent, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top,
    visible: node.visibleToUser, childCount: children.length, children: branch ? children : [],
    childRefsHash: createHash("sha256").update(children.join(";")).digest("hex") };
}

/** One complete common parent branch only. Never recover the window root or split into several requests. */
export function planBranchRecovery(root: UiNode, failed: readonly UiNode[], binding: Omit<BranchBinding, "branchRef">): BranchRecoveryPlan | null {
  if (!failed.length || failed.length > 8 || root.children.length !== 1) return null;
  const window = root.children[0], paths = new Map<UiNode, UiNode[]>(), refs = new Set<string>();
  const pending: Array<[UiNode, UiNode[]]> = [[window, []]];
  for (let i = 0; i < pending.length; i++) {
    if (pending.length > 5000) return null;
    const [node, ancestors] = pending[i], ref = node.attributes?.["view-ref"];
    if (!ref || refs.has(ref)) return null;
    refs.add(ref); paths.set(node, ancestors);
    node.children.forEach(child => pending.push([child, [...ancestors, node]]));
  }
  if (failed.some(node => !paths.has(node))) return null;
  // A failed parent is itself a valid common branch. Using only its ancestors
  // would unnecessarily pull in unrelated siblings (often exceeding the cap).
  const chains = failed.map(node => [...paths.get(node)!, node]);
  const first = chains[0]!;
  let level = 0;
  while (level < first.length && chains.every(chain => chain![level] === first[level])) level++;
  if (level && !first[level - 1].children.length) level--;
  if (level < 2) return null;
  const branch = first[level - 1], ancestors = first.slice(0, level - 1), parent = ancestors.at(-1)!;
  const nodes = [branch]; let pixels = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes.length > 64) return null;
    const n = nodes[i], b = n.bounds;
    if (!b) return null;
    if (n.visibleToUser) pixels += (b.right - b.left) * (b.bottom - b.top);
    if (pixels > 4_000_000) return null;
    nodes.push(...n.children);
  }
  if (ancestors.length > 32 || window.attributes?.["view-ref"] !== binding.rootRef) return null;
  const path = [...ancestors, branch].map(n => n.attributes!["view-ref"]);
  const original: BranchGeometryRead = { ...binding, branchRef: path.at(-1)!, version: 1, nonce: "0000000000000000", started: 0, ended: 0,
    ancestors: ancestors.map((n, i) => row(n, i ? ancestors[i - 1].attributes!["view-ref"] : "", false)),
    nodes: nodes.map(n => row(n, n === branch ? parent.attributes!["view-ref"] : paths.get(n)!.at(-1)!.attributes!["view-ref"], true)) };
  return { branch, parent, index: parent.children.indexOf(branch), path, original };
}

/** At most one complete branch. An isolated outlier must not block a recoverable cluster. */
export function selectBranchRecovery(root: UiNode, failed: readonly UiNode[], binding: Omit<BranchBinding, "branchRef">): BranchRecoverySelection {
  if (!failed.length) return { plan: null, failed: [], reason: "no-candidates" };
  if (failed.length > 8) return { plan: null, failed: [], reason: "too-many-candidates" };
  const complete = planBranchRecovery(root, failed, binding);
  if (complete) return { plan: complete, failed, reason: "complete" };
  // <=28 pairs, deduplicated by their common branch. Never chase single scattered
  // leaves or split one recovery into multiple device requests.
  const branches = new Map<UiNode, { plan: BranchRecoveryPlan; failed: UiNode[]; pixels: number }>();
  for (let i = 0; i < failed.length; i++) for (let j = i + 1; j < failed.length; j++) {
    const plan = planBranchRecovery(root, [failed[i], failed[j]], binding);
    if (!plan || branches.has(plan.branch)) continue;
    const refs = new Set(plan.original.nodes.map(n => n.ref));
    branches.set(plan.branch, { plan, failed: failed.filter(n => refs.has(n.attributes?.["view-ref"] ?? "")),
      pixels: plan.original.nodes.reduce((sum, n) => sum + (n.visible ? n.width * n.height : 0), 0) });
  }
  const chosen = [...branches.values()].sort((a, b) => b.failed.length - a.failed.length
    || a.plan.original.nodes.length - b.plan.original.nodes.length || a.pixels - b.pixels)[0];
  return chosen ? { ...chosen, reason: "bounded-cluster" } : { plan: null, failed: [], reason: "no-bounded-common-branch" };
}

/** Stage every descendant off-tree; the caller validates all images before a single pointer swap. */
export function stageRecoveredBranch<T>(plan: BranchRecoveryPlan, geometry: BranchGeometryRead, images: ReadonlyMap<string, T>,
  apply: (node: UiNode, image: T) => boolean): UiNode {
  const candidate = structuredClone(plan.branch), pending = [candidate];
  const rows = new Map(geometry.nodes.map(row => [row.ref, row]));
  for (let i = 0; i < pending.length; i++) {
    const node = pending[i], ref = node.attributes!["view-ref"], row = rows.get(ref);
    if (!row) throw new Error("小分支提交缺少几何");
    node.bounds = { left: row.x, top: row.y, right: row.x + row.width, bottom: row.y + row.height,
      raw: `[${row.x},${row.y}][${row.x + row.width},${row.y + row.height}]` };
    delete node.layerImageDataUrl; delete node.layerImageSize; delete node.layerImageEmpty; delete node.layerCapturePlacement;
    for (const key of Object.keys(node.attributes!)) if (key.startsWith("image-capture-") || key === "image-source") delete node.attributes![key];
    node.layerImageStatus = row.visible ? "unavailable" : "hidden";
    const image = images.get(ref);
    if (row.visible && row.width > 0 && row.height > 0 && (!image || !apply(node, image))) throw new Error("小分支图片提交校验失败");
    pending.push(...node.children);
  }
  if (pending.length !== geometry.nodes.length) throw new Error("小分支提交结构已变化");
  return candidate;
}

export function commitRecoveredBranch(plan: BranchRecoveryPlan, candidate: UiNode, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (plan.parent.children[plan.index] !== plan.branch) throw new Error("小分支原节点已被替换");
  plan.parent.children[plan.index] = candidate;
}

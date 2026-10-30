import { rectMetrics } from "../../../shared/node-metrics";
import { nodeDisplayLabel } from "../../../shared/tree-utils";
import type { InspectorColorEncoding } from "../../../shared/inspector-colors";
import type { UiNode, ViewStyleResult } from "../../../shared/types";

export type ReferenceSnapshot = { id?: string; capturedAt?: string; label?: string };
export type PinnedNodeReference = {
  root: UiNode; node: UiNode; session: string | number | undefined;
  identity: { ref: string; className: string } | null;
  name: string; className: string | null; text: string | null;
  geometry: { x: number; y: number; width: number; height: number } | null;
  colors: { label: string; raw: string; encoding?: InspectorColorEncoding; source: string }[];
  snapshot: ReferenceSnapshot; source: string; fixedAt: string; styleReadAt: number | null;
};

function findIdentity(root: UiNode, node: UiNode, ref: string | undefined) {
  let found = false; const references: UiNode[] = [], pending = [root];
  while (pending.length) {
    const next = pending.pop()!;
    if (next === node) found = true;
    if (ref && next.attributes?.["view-ref"] === ref) references.push(next);
    for (const child of next.children) pending.push(child);
  }
  return { found, references };
}

// Copy only displayed values. Source objects establish identity and never supply later reference values.
export function pinNodeReference(root: UiNode, node: UiNode, session: string | number | undefined, source: string,
  snapshot: ReferenceSnapshot = {}, style: ViewStyleResult | null = null, fixedAt = new Date().toISOString()): PinnedNodeReference | null {
  const ref = node.attributes?.["view-ref"], found = findIdentity(root, node, ref);
  if (!found.found) return null;
  const rect = rectMetrics(node.bounds), qml = node.attributes?.["inspection-source"] === "debug-qml";
  const live = style && ref && style.ref === ref && Number.isFinite(style.capturedAtMillis) ? style : null;
  const colors: PinnedNodeReference["colors"] = [];
  const add = (label: string, raw: string | null | undefined, encoding: InspectorColorEncoding | undefined, colorSource: string) => {
    if (raw !== null && raw !== undefined && raw !== "") colors.push({ label, raw, encoding, source: colorSource });
  };
  if (live) {
    add("背景源色", live.backgroundColor, "android-argb", "已读取的 Debug SDK 样式");
    add("文字色", live.textColor, "android-argb", "已读取的 Debug SDK 样式");
  } else add("背景源色", node.attributes?.["background-color"], qml ? "qml-rgba" : undefined, qml ? "快照中的 QML 属性" : "快照原始属性，颜色编码未确认");
  add("边框源色", node.attributes?.["border-color"], qml ? "qml-rgba" : undefined, qml ? "快照中的 QML 属性" : "快照原始属性，颜色编码未确认");
  return { root, node, session, identity: ref && node.className && found.references.length === 1 ? { ref, className: node.className } : null,
    name: nodeDisplayLabel(node), className: node.className, text: node.text,
    geometry: rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null,
    colors, snapshot: { ...snapshot }, source, fixedAt, styleReadAt: live?.capturedAtMillis ?? null };
}

export function nodeReferenceStatus(reference: PinnedNodeReference, root: UiNode): "current" | "stale" | "detached" {
  if (reference.root === root) return "current";
  const found = findIdentity(root, reference.node, reference.identity?.ref);
  if (reference.identity) return found.references.length === 1 && found.references[0].className === reference.identity.className ? "stale" : "detached";
  return !reference.node.attributes?.["view-ref"] && found.found ? "stale" : "detached";
}

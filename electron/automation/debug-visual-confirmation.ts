import { createHash } from "node:crypto";
import sharp from "sharp";
import { flattenNodes, nodeDisplayLabel } from "../../shared/tree-utils";
import type { ScreenRect } from "../../shared/screen-coordinates";
import type { DebugStep, UiNode, UiSnapshot } from "../../shared/types";
import { windowId } from "./debug-target-resolution";

type VisualEvidence = NonNullable<NonNullable<DebugStep["resolvedInput"]>["visualConfirmation"]>;

export function sameInteractionEvidence(before: UiNode[], beforeSnapshot: UiSnapshot, after: UiNode[], afterSnapshot: UiSnapshot) {
  const signatures = (nodes: UiNode[], snapshot: UiSnapshot) => {
    const tree = snapshot.root ? [...flattenNodes(snapshot.root).values()] : [];
    return nodes.map(node => JSON.stringify([
      node.package, node.className, node.resourceId, node.text, node.contentDesc,
      node.bounds && [node.bounds.left, node.bounds.top, node.bounds.right, node.bounds.bottom],
      node.visibleToUser, node.visibilityEvidence ?? "unknown", node.enabled, node.clickable, node.scrollable,
      node.attributes?.["drawing-order"], windowId(node, tree), node.attributes?.["window-layer"],
    ])).sort();
  };
  return JSON.stringify(signatures(before, beforeSnapshot)) === JSON.stringify(signatures(after, afterSnapshot));
}

/** An actionable read-only recovery result, never an input receipt or a visibility verdict. */
export class DebugVisualConfirmationRequired extends Error {
  readonly recovery;
  constructor(snapshotId: string, nodeId: string, target: "self" | "clickable-parent", targetNode: UiNode, overlaps: UiNode[]) {
    super("操作区域存在矩形重叠，尚不能确定遮挡；请查看返回快照的整屏截图，确认目标可见后再附 visualConfirmation，当前未发送操作。");
    this.recovery = { kind: "visual_confirmation_required", snapshotId, nodeId, target, targetNodeId: targetNode.id,
      image: { tool: "get_image", arguments: { snapshotId } },
      overlapCount: overlaps.length,
      overlaps: overlaps.slice(0, 20).map(node => ({ nodeId: node.id, name: nodeDisplayLabel(node).slice(0, 512),
        bounds: node.bounds, visibilityEvidence: node.visibilityEvidence ?? "unknown" })) };
  }
}

function confirmationRegion(before: ScreenRect, after: ScreenRect, width: number, height: number, padding: number) {
  const values = [before.left, before.top, before.right, before.bottom, after.left, after.top, after.right, after.bottom, width, height];
  if (!values.every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("截图确认区域无效，未发送操作。");
  const left = Math.max(0, Math.floor(Math.min(before.left, after.left) - padding));
  const top = Math.max(0, Math.floor(Math.min(before.top, after.top) - padding));
  const right = Math.min(width, Math.ceil(Math.max(before.right, after.right) + padding));
  const bottom = Math.min(height, Math.ceil(Math.max(before.bottom, after.bottom) + padding));
  if (right <= left || bottom <= top) throw new Error("目标不在截图内，未发送操作。");
  return { left, top, width: right - left, height: bottom - top };
}

async function pixels(snapshot: UiSnapshot, region: VisualEvidence["region"]) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(snapshot.screenshotDataUrl ?? "");
  const expected = snapshot.captureGeometry?.screenshotSize;
  if (!match || !expected || match[1].length > 24 * 1024 * 1024) throw new Error("缺少可验证的整屏截图，未发送操作。");
  const image = sharp(Buffer.from(match[1], "base64"), { failOn: "warning", limitInputPixels: 16 * 1024 * 1024 }).timeout({ seconds: 2 });
  const metadata = await image.metadata();
  if (metadata.width !== expected.width || metadata.height !== expected.height || (metadata.pages ?? 1) !== 1)
    throw new Error("截图实际尺寸与采集记录不一致，未发送操作。");
  return image.extract(region).toColourspace("srgb").ensureAlpha().raw().toBuffer();
}

/** The caller supplies the visual judgment. This check only proves its local pixel evidence is unchanged. */
export async function verifyVisualConfirmation(input: {
  before: UiSnapshot; after: UiSnapshot; beforeBounds: ScreenRect; afterBounds: ScreenRect;
  action?: "tap" | "scroll";
  referenceSnapshotId: string; currentSnapshotId: string; description: string; overlaps: UiNode[]; beforeOverlaps: UiNode[]; signal: AbortSignal;
}): Promise<VisualEvidence> {
  input.signal.throwIfAborted();
  const ids = input.overlaps.map(node => node.id);
  if (ids.length > 100 || ids.some(id => !id || id.length > 2048) || new Set(ids).size !== ids.length
    || ids.reduce((total, id) => total + Buffer.byteLength(id, "utf8"), 0) > 16 * 1024)
    throw new Error("重叠控件过多，无法完整保存确认依据；请缩小检查范围，未发送操作。");
  if (!sameInteractionEvidence(input.beforeOverlaps, input.before, input.overlaps, input.after))
    throw new Error("重叠控件已变化，原截图确认不再有效；请查看新截图并重新定位，未发送操作。");
  const size = input.after.captureGeometry?.screenshotSize, previousSize = input.before.captureGeometry?.screenshotSize;
  if (!size || !previousSize || size.width !== previousSize.width || size.height !== previousSize.height)
    throw new Error("截图尺寸已变化，未发送操作。");
  // Scroll bounds already include touch slop and are clipped to the usable viewport.
  const region = confirmationRegion(input.beforeBounds, input.afterBounds, size.width, size.height, input.action === "scroll" ? 0 : 24);
  const decoded = await Promise.allSettled([pixels(input.before, region), pixels(input.after, region)]);
  input.signal.throwIfAborted();
  if (decoded[0].status === "rejected") throw decoded[0].reason;
  if (decoded[1].status === "rejected") throw decoded[1].reason;
  const previous = decoded[0].value, current = decoded[1].value;
  if (!previous.equals(current)) throw new Error("目标附近画面已变化，原截图确认不再有效；请查看新截图并重新定位，未发送操作。");
  return { referenceSnapshotId: input.referenceSnapshotId, currentSnapshotId: input.currentSnapshotId,
    description: input.description, region, sha256: createHash("sha256").update(current).digest("hex"),
    overlapNodeIds: ids };
}

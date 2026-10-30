import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeNode } from "../benchmarks/fixtures";
import { layerImageProvenance, layerImagePresentation } from "../shared/layer-image-provenance";
import { nodePresentationStatus } from "../shared/node-presentation-status";
import { NodePresentationStatus, NodeStatusBadge } from "../src/components/NodePresentationStatus";
import type { UiNode } from "../shared/types";

function node(fields: Partial<UiNode> = {}) {
  return { ...makeNode("node"), children: [], ...fields };
}
const picture = { layerImageDataUrl: "data:image/png;base64,AA==", layerImageSize: { width: 16, height: 16 } };

test("missing image is not reported as transparent, including old snapshots and fast sources", () => {
  const old = nodePresentationStatus(node());
  assert.equal(old.code, "missing"); assert.equal(old.badgeLabel, null);
  assert.match(old.detail, /未记录/); assert.doesNotMatch(old.detail, /全透明/);
  for (const inspectionSource of ["uiautomator", "accessibility-helper"] as const) {
    const status = nodePresentationStatus(node(), { inspectionSource });
    assert.equal(status.code, "missing"); assert.equal(status.badgeLabel, null);
    assert.match(status.detail, /裁剪图包含背景/); assert.doesNotMatch(status.detail, /未返回具体原因/);
    assert.deepEqual(nodePresentationStatus(node(), { inspectionSource, waitingForImage: true }), status, "fast never waits for independent images");
  }
  const fastMode = nodePresentationStatus(node(), { inspectionSource: "debug-view", captureMode: "fast", waitingForImage: true });
  assert.equal(fastMode.code, "missing"); assert.equal(fastMode.badgeLabel, null);
  const unavailable = nodePresentationStatus(node({ layerImageStatus: "unavailable" }), { inspectionSource: "debug-view" });
  assert.equal(unavailable.badgeLabel, "缺画面"); assert.match(unavailable.detail, /不代表控件透明/);
  assert.equal(nodePresentationStatus(node(), { inspectionSource: "debug-qml" }).badgeLabel, "缺画面");
});

test("only an explicit ongoing capture is waiting, terminal failures remain failures", () => {
  const missing = node({ layerImageStatus: "unavailable" });
  assert.equal(nodePresentationStatus(missing).code, "missing");
  const pending = nodePresentationStatus(missing, { waitingForImage: true });
  assert.equal(pending.code, "waiting"); assert.equal(pending.badgeLabel, "等待");
  assert.equal(pending.detail, "本次采集仍在进行，尚未返回此控件的独立画面。");
  assert.equal(nodePresentationStatus(node({ layerImageStatus: "failed" }), { waitingForImage: true }).code, "failed");
  assert.equal(nodePresentationStatus(node({ layerImageStatus: "ambiguous" }), { waitingForImage: true }).code, "ambiguous");
  assert.equal(nodePresentationStatus(node({ ...picture, layerImageStatus: "captured" }), { waitingForImage: true }).code, "captured");
});

test("manual hide is distinct from device visibility and does not change own image facts", () => {
  const captured = node({ ...picture, layerImageStatus: "captured", layerImageEmpty: false });
  const manual = nodePresentationStatus(captured, { hiddenByUser: "node" });
  assert.equal(manual.code, "user-hidden"); assert.equal(manual.badgeLabel, "已隐藏");
  assert.equal(manual.ownImage.code, "captured"); assert.match(manual.detail, /工作台/); assert.doesNotMatch(manual.detail, /祖先/);
  const device = nodePresentationStatus({ ...captured, visibleToUser: false });
  assert.equal(device.code, "device-hidden"); assert.equal(device.label, "设备不可见");
  assert.equal(device.ownImage.code, "captured");
  const both = nodePresentationStatus({ ...captured, visibleToUser: false }, { hiddenByUser: "node" });
  assert.equal(both.code, "user-hidden");
  const captureHidden = nodePresentationStatus(node({ layerImageStatus: "hidden" }));
  assert.equal(captureHidden.label, "采集不可见"); assert.match(captureHidden.detail, /采集报告/);
});

test("confirmed own empty images and structural skip-draw keep child pixels possible", () => {
  const empty = nodePresentationStatus(node({ ...picture, layerImageStatus: "captured", layerImageEmpty: true }));
  assert.equal(empty.code, "empty"); assert.equal(empty.badgeLabel, "自身空图");
  assert.match(empty.detail, /自身图片全透明/); assert.match(empty.detail, /子层/);
  const structural = nodePresentationStatus(node({ layerImageStatus: "unavailable", attributes: { "skip-draw": "true" } }), { waitingForImage: true });
  assert.equal(structural.code, "structural"); assert.equal(structural.badgeLabel, null);
  assert.match(structural.detail, /跳过自身绘制/); assert.match(structural.detail, /子层/);
  assert.equal(nodePresentationStatus(node({ attributes: { "skip-draw": "false" } })).code, "missing");
});

test("normal bitmap, unchecked opacity and QML style have no tree badge", () => {
  const measured = nodePresentationStatus(node({ ...picture, layerImageStatus: "captured", layerImageEmpty: false }));
  assert.equal(measured.code, "captured"); assert.match(measured.detail, /含可见像素/); assert.equal(measured.badgeLabel, null);
  const unchecked = nodePresentationStatus(node({ ...picture, layerImageStatus: "captured" }));
  assert.match(unchecked.detail, /透明度未检测/); assert.equal(unchecked.badgeLabel, null);
  const old = nodePresentationStatus(node(picture));
  assert.equal(old.label, "已提供画面"); assert.match(old.detail, /未标注采集方式/);
  const style = nodePresentationStatus(node({ ...picture, layerImageStatus: "style" }));
  assert.equal(style.code, "style"); assert.match(style.detail, /未采集独立截图/); assert.equal(style.badgeLabel, null);
  for (const layerImageStatus of ["captured", "style"] as const) {
    const missing = nodePresentationStatus(node({ layerImageStatus }));
    assert.equal(missing.code, "missing"); assert.equal(missing.badgeLabel, "缺画面"); assert.match(missing.detail, /未提供/);
  }
});

test("capture failure is explicit and never invents a reason or discards an existing image", () => {
  const failed = nodePresentationStatus(node({ layerImageStatus: "failed", layerImageEmpty: true, attributes: { "skip-draw": "true" } }));
  assert.equal(failed.code, "failed"); assert.match(failed.detail, /未返回具体原因/); assert.equal(failed.badgeLabel, "失败");
  const reason = nodePresentationStatus(node({ layerImageStatus: "failed", attributes: { "image-capture-error": "SDK 返回指定错误" } }));
  assert.equal(reason.detail, "独立画面采集失败。");
  const retained = nodePresentationStatus(node({ ...picture, layerImageStatus: "failed" }));
  assert.match(retained.detail, /保留了已有画面/);
  const refreshed = nodePresentationStatus(node({ ...picture, layerImageStatus: "captured", attributes: { "image-refresh-error": "本轮刷新失败" } }));
  assert.equal(refreshed.code, "captured"); assert.equal(refreshed.badgeLabel, null);
  const ambiguous = nodePresentationStatus(node({ layerImageStatus: "ambiguous" }));
  assert.equal(ambiguous.code, "ambiguous"); assert.match(ambiguous.detail, /匹配有歧义/);
});

test("folded group and local composite retain provenance instead of describing own empty as whole empty", () => {
  const empty = node({ ...picture, layerImageStatus: "captured", layerImageEmpty: true });
  for (const requestState of [undefined, "pending", "unavailable"] as const) {
    const provenance = layerImageProvenance({ collapsed: true, hasGroup: false, hiddenDescendants: false, canRequestGroup: true, requestState });
    const status = nodePresentationStatus(empty, { presentation: provenance });
    assert.equal(status.code, "composite"); assert.equal(status.badgeLabel, null); assert.equal(status.ownImage.code, "empty");
    assert.deepEqual({ label: status.presentation!.label, detail: status.presentation!.detail }, layerImagePresentation(provenance));
    assert.doesNotMatch(status.detail, /全透明/);
  }
  const group = nodePresentationStatus(empty, { presentation: { source: "live-group", groupState: "ready" } });
  assert.equal(group.code, "group"); assert.equal(group.badgeLabel, null); assert.match(group.detail, /不保证与原快照同帧/);
  const hidden = nodePresentationStatus(empty, { hiddenByUser: "node", presentation: { source: "live-group", groupState: "ready" } });
  assert.equal(hidden.code, "user-hidden"); assert.equal(hidden.presentation!.code, "group");
});

test("outline provenance does not erase exact failure, wait or empty facts", () => {
  for (const fields of [{ layerImageStatus: "failed" }, { layerImageEmpty: true }, {}] as Array<Partial<UiNode>>) {
    const n = node(fields), context = { waitingForImage: fields.layerImageStatus === undefined && fields.layerImageEmpty === undefined,
      presentation: { source: "none", groupState: "not-applicable" } };
    const status = nodePresentationStatus(n, context);
    assert.equal(status.code, fields.layerImageStatus === "failed" ? "failed" : fields.layerImageEmpty ? "empty" : "waiting");
    assert.equal(status.presentation!.code, "outline");
  }
  const outlined = nodePresentationStatus(node({ ...picture, layerImageStatus: "captured" }), { presentation: { source: "none", groupState: "not-applicable" } });
  assert.equal(outlined.code, "outline"); assert.equal(outlined.ownImage.code, "captured");
  const unknown = nodePresentationStatus(node(), { presentation: { source: "unknown", groupState: "not-applicable" } });
  assert.equal(unknown.presentation, undefined); assert.equal(unknown.code, "missing");
});

test("source-specific facts and current context do not mutate snapshots or children", () => {
  const parent = node({ children: [node({ id: "child", ...picture, layerImageStatus: "captured" })],
    attributes: { "inspection-source": "accessibility-helper", "image-source": "原始来源" } });
  const original = structuredClone(parent);
  assert.equal(nodePresentationStatus(parent, { inspectionSource: "debug-view" }).badgeLabel, null, "node source describes the actual node");
  nodePresentationStatus(parent, { hiddenByUser: "node", waitingForImage: true });
  assert.equal(nodePresentationStatus(parent.children[0]).code, "captured", "manual hide does not propagate to children");
  assert.deepEqual(parent, original);
});

test("badge is concise and accessible; normal images add no badge", () => {
  const status = nodePresentationStatus(node({ layerImageEmpty: true }));
  const html = renderToStaticMarkup(createElement(NodeStatusBadge, { status }));
  assert.match(html, /data-node-status="empty"/); assert.match(html, /aria-label="自身空图：/); assert.match(html, />自身空图<\/span>/);
  assert.equal(renderToStaticMarkup(createElement(NodeStatusBadge, { status: nodePresentationStatus(node(picture)) })), "");
});

test("inspector explanations remain searchable and show own vs folded pixels separately", () => {
  const status = nodePresentationStatus(node({ ...picture, layerImageStatus: "captured", layerImageEmpty: true }),
    { presentation: { source: "local-composite", groupState: "pending" } });
  const html = renderToStaticMarkup(createElement(NodePresentationStatus, { status }));
  assert.match(html, /aria-label="控件画面状态"/); assert.match(html, /data-inspector-label="当前图层"/);
  assert.match(html, /data-inspector-value="本地重建图"/); assert.match(html, /data-inspector-label="自身画面"/);
  assert.match(html, /data-inspector-value="自身空图"/); assert.match(html, /data-inspector-terms="[^"]*独立画面/);
  assert.match(html, /正在读取原生整组图/); assert.match(html, /子层和折叠后的整组画面仍可能有内容/);
  const hidden = renderToStaticMarkup(createElement(NodePresentationStatus, { status: nodePresentationStatus(node(picture), { hiddenByUser: "node" }) }));
  assert.match(hidden, /data-inspector-label="显示状态"/); assert.match(hidden, /data-inspector-label="自身画面"/);
});

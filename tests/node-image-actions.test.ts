import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { nodeImageExportPlan } from "../shared/node-image-export";
import { isLayerMenuOptions } from "../shared/layer-context-menu";
import { nodeImageScopeOptions } from "../src/features/layers/node-image-action-options";

const saved = () => ({ ...makeNode("saved"), layerImageStatus: "captured" as const,
  layerImageDataUrl: "data:image/png;base64,aGVsbG8=", layerImageSize: { width: 360, height: 48 } });

test("menu image scopes use the same availability and provenance as property output plans", () => {
  const node = saved(), options = nodeImageScopeOptions(node);
  assert.deepEqual(options.map(item => item.scope), ["own", "branch"]);
  for (const item of options) {
    const plan = nodeImageExportPlan(node, item.scope);
    assert.equal(item.available, plan.kind !== "unavailable");
    assert.equal(item.label, plan.label); assert.equal(item.detail, plan.detail);
  }
  assert.equal(options[0].available, true); assert.match(options[1].label, /本地重建/);
  assert.ok(isLayerMenuOptions({ canFocus: false, expandable: false, expanded: false, imageScopes: options }));
});

test("missing or style-only pixels remain unavailable rather than becoming screenshot crops", () => {
  for (const node of [makeNode("missing"), { ...saved(), layerImageStatus: "style" as const }]) {
    const options = nodeImageScopeOptions(node);
    assert.ok(options.every(item => !item.available));
    assert.match(options[0].detail, /未保存|没有保存/); assert.match(options[1].detail, /不会从整屏截图裁图/);
  }
});

test("saved branch images keep original source and current frame caveat", () => {
  const group = { dataUrl: "data:image/png;base64,aGVsbG8=", size: { width: 4, height: 6 }, capturedAt: "2026-10-13T00:00:00Z" };
  const options = nodeImageScopeOptions(saved(), group);
  assert.match(options[1].label, /已保存原生整组图/); assert.match(options[1].detail, /可能与快照不同帧/);
  assert.equal(options[1].available, true);
});

test("menu scope descriptions obey IPC length bounds while retaining missing-image reasons", () => {
  const node = { ...makeNode("missing"), attributes: { "image-capture-error": "缺图原因".repeat(250) } };
  const options = nodeImageScopeOptions(node);
  assert.equal(options[0].detail.length, 500);
  assert.ok(options.every(item => item.label.length <= 160 && item.detail.length <= 500));
  assert.ok(isLayerMenuOptions({ canFocus: false, expandable: false, expanded: false, imageScopes: options }));
});

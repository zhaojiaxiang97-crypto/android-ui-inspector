import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { nodeCaptureFacts } from "../shared/node-capture-facts";
import { nodePresentationStatus } from "../shared/node-presentation-status";
import { nodeImageExportPlan } from "../shared/node-image-export";
import { layerImageProvenance } from "../shared/layer-image-provenance";
import { changedLayerImages, layerImageBaseline, mergeLayerImages } from "../shared/tree-utils";
import { diagnosticImageState, summarizeLiveDiagnosis } from "../src/features/reports/live-diagnosis";
import type { UiNode, UiSnapshot } from "../shared/types";

const png = "data:image/png;base64,aGVsbG8=";
const svg = "data:image/svg+xml;base64,PHN2Zz4=";
const size = { width: 10, height: 10 };
const node = (fields: Partial<UiNode> = {}): UiNode => ({ ...makeNode("0"), package: "fixture.app", children: [],
  bounds: { left: 0, top: 0, right: 100, bottom: 100, raw: "[0,0][100,100]" }, ...fields });

test("capture facts retain the full status and empty matrix without equating presence with saved raster pixels", () => {
  const images = [[undefined, false, false], ["", false, false], [" \n ", true, false], [png, true, true], [svg, true, true], ["pixels", true, true]] as const;
  for (const status of [undefined, "captured", "style", "hidden", "failed", "ambiguous", "unavailable"] as const)
    for (const empty of [undefined, true, false]) for (const [dataUrl, hasImageData, hasNonBlankImageData] of images) {
      const current = node({ layerImageStatus: status, layerImageEmpty: empty, layerImageDataUrl: dataUrl, layerImageSize: size,
        attributes: { "image-source": " ", "image-capture-source": "", "inspection-source": "debug-view", "image-capture-error": " raw failure ", "skip-draw": "true" } });
      const original = structuredClone(current);
      assert.deepEqual(nodeCaptureFacts(current), { status, empty, dataUrl, size, hasImageData, hasNonBlankImageData,
        source: " ", captureSource: "", inspectionSource: "debug-view", error: " raw failure ", skipDraw: true });
      assert.deepEqual(current, original);
    }
});

test("legacy facts stay unknown and the adapter does not inspect children, visibility or presentation policy", () => {
  const current = node();
  Object.defineProperty(current, "children", { get: () => assert.fail("facts cannot traverse a branch") });
  Object.defineProperty(current, "visibleToUser", { get: () => assert.fail("device visibility is separate from captured image facts") });
  Object.freeze(current);
  assert.deepEqual(nodeCaptureFacts(current), { status: undefined, empty: undefined, dataUrl: undefined, size: undefined,
    hasImageData: false, hasNonBlankImageData: false, source: undefined, captureSource: undefined, inspectionSource: undefined, error: undefined, skipDraw: false });
  for (const raw of [undefined, "", "false", "1", "TRUE", " true "])
    assert.equal(nodeCaptureFacts(node({ attributes: raw === undefined ? {} : { "skip-draw": raw } })).skipDraw, false);
  assert.equal(nodeCaptureFacts(node({ attributes: { "skip-draw": "true" } })).skipDraw, true);
});

test("presentation, diagnosis and export keep their distinct contracts for contradictory saved facts", () => {
  const cases: Array<{ fields: Partial<UiNode>; own: string; diagnosis: string; export: string }> = [
    { fields: { layerImageStatus: "hidden", layerImageEmpty: true, layerImageDataUrl: png }, own: "device-hidden", diagnosis: "hidden", export: "own" },
    { fields: { layerImageStatus: "failed", layerImageEmpty: true, layerImageDataUrl: png }, own: "failed", diagnosis: "failed", export: "own" },
    { fields: { layerImageStatus: "ambiguous", layerImageEmpty: true, layerImageDataUrl: png }, own: "ambiguous", diagnosis: "ambiguous", export: "own" },
    { fields: { layerImageStatus: "style", layerImageEmpty: false, layerImageDataUrl: png }, own: "style", diagnosis: "style", export: "unavailable" },
    { fields: { layerImageStatus: "captured", layerImageEmpty: true }, own: "empty", diagnosis: "unavailable", export: "unavailable" },
    { fields: { layerImageEmpty: true }, own: "empty", diagnosis: "unknown", export: "unavailable" },
    { fields: { layerImageStatus: "captured", layerImageEmpty: false, layerImageDataUrl: " " }, own: "missing", diagnosis: "visible", export: "unavailable" },
    { fields: { layerImageStatus: "unavailable", layerImageDataUrl: png }, own: "captured", diagnosis: "unavailable", export: "own" },
    { fields: { layerImageStatus: "captured", layerImageEmpty: false, layerImageDataUrl: svg }, own: "captured", diagnosis: "visible", export: "unavailable" },
    { fields: { layerImageStatus: "style", layerImageDataUrl: " " }, own: "missing", diagnosis: "style", export: "unavailable" },
  ];
  for (const value of cases) {
    const current = node({ ...value.fields, layerImageSize: size });
    assert.equal(nodePresentationStatus(current).ownImage.code, value.own);
    assert.equal(diagnosticImageState(current), value.diagnosis);
    assert.equal(nodeImageExportPlan(current, "own").kind, value.export);
  }
});

test("capture context, manual hiding and folded presentation never rewrite the node's own facts", () => {
  const missing = node(), captured = node({ layerImageStatus: "captured", layerImageDataUrl: png, layerImageEmpty: true, layerImageSize: size });
  assert.equal(nodePresentationStatus(missing, { captureMode: "fast", waitingForImage: true }).code, "missing");
  assert.equal(nodePresentationStatus(missing, { captureMode: "fast" }).badgeLabel, null);
  assert.equal(nodePresentationStatus(missing, { captureMode: "deep", waitingForImage: true }).code, "waiting");
  const original = nodeCaptureFacts(captured), own = nodeImageExportPlan(captured, "own");
  for (const collapsed of [false, true]) for (const hiddenDescendants of [false, true]) {
    const presentation = layerImageProvenance({ collapsed, hiddenDescendants, hasGroup: true, canRequestGroup: true, ownSource: "sdk" });
    const status = nodePresentationStatus(captured, { hiddenByUser: "node", presentation });
    assert.equal(status.code, "user-hidden"); assert.equal(status.ownImage.code, "empty");
    assert.deepEqual(nodeCaptureFacts(captured), original); assert.deepEqual(nodeImageExportPlan(captured, "own"), own);
  }
  assert.equal(nodePresentationStatus(node({ attributes: { "inspection-source": "uiautomator" } }), { inspectionSource: "debug-view" }).badgeLabel, null);
});

test("own and group export keep independent validation and local branches count missing images separately from transparent ones", () => {
  const group = { dataUrl: png, size, capturedAt: "2026-10-14T00:00:00Z" };
  const style = node({ layerImageStatus: "style", layerImageDataUrl: png, layerImageSize: { width: 0, height: 1 } });
  assert.equal(nodeImageExportPlan(style, "own").kind, "unavailable");
  assert.equal(nodeImageExportPlan(style, "branch", group).kind, "group");
  const own = node({ layerImageDataUrl: png, layerImageSize: size, layerImageStatus: "failed" });
  assert.equal(nodeImageExportPlan(own, "own").kind, "own");
  assert.equal(nodeImageExportPlan(own, "branch", { ...group, dataUrl: svg }).kind, "unavailable");
  const branch = node({ attributes: { "skip-draw": "true" }, children: [own, style, node({ layerImageEmpty: true }), node(),
    node({ visibleToUser: false, children: [node()] })] });
  const plan = nodeImageExportPlan(branch, "branch"); assert.equal(plan.kind, "composite");
  if (plan.kind === "composite") assert.equal(plan.missingCount, 2);
});

test("real image diffs and merges recompute facts without retaining stale status, error or source", () => {
  const original = node({ layerImageStatus: "failed", attributes: { "image-source": "old", "image-capture-error": "old failure", "skip-draw": "true" },
    children: [node({ id: "0/0" })] });
  const baseline = layerImageBaseline(original), previous = nodeCaptureFacts(original), captured = structuredClone(original);
  captured.layerImageStatus = "captured"; captured.layerImageDataUrl = png; captured.layerImageEmpty = false; captured.layerImageSize = size;
  captured.attributes = { "image-capture-source": "sdk" };
  const updates = changedLayerImages(captured, baseline); assert.ok(updates); assert.equal(updates.length, 1);
  const merged = mergeLayerImages(original, updates);
  assert.notEqual(merged, original); assert.equal(merged.children[0], original.children[0]);
  const facts = nodeCaptureFacts(merged);
  assert.equal(facts.status, "captured"); assert.equal(facts.empty, false); assert.equal(facts.captureSource, "sdk");
  assert.equal(facts.error, undefined); assert.equal(facts.source, undefined); assert.equal(facts.skipDraw, false);
  assert.equal(nodePresentationStatus(merged).code, "captured"); assert.equal(nodeImageExportPlan(merged, "own").kind, "own");
  assert.deepEqual(nodeCaptureFacts(original), previous);
  merged.layerImageStatus = "unavailable"; delete merged.layerImageDataUrl; delete merged.layerImageEmpty;
  assert.equal(nodeCaptureFacts(merged).status, "unavailable"); assert.equal(nodeCaptureFacts(merged).hasImageData, false);
  assert.equal(nodePresentationStatus(merged).code, "missing"); assert.equal(diagnosticImageState(merged), "unavailable");
});

test("source and error fallbacks remain consumer decisions and retain meaningful raw whitespace", () => {
  const current = node({ layerImageStatus: "failed", attributes: { "image-source": "", "image-capture-source": "sdk", "image-capture-error": " ", "skip-draw": "true" } });
  const snapshot = { serial: "fixture", root: current, nodeCount: 1, error: null, inspectionSource: "debug-view", captureMode: "deep",
    captureRequestDiagnostics: { totalAttempts: 1 } } as UiSnapshot;
  const result = summarizeLiveDiagnosis({ requestId: "fixture", expectedPackage: "fixture.app", serial: "fixture", startedAt: "", finishedAt: "", snapshot });
  assert.equal(result.rows[0].source, "sdk"); assert.equal(result.rows[0].reason, " ");
  assert.equal(nodeCaptureFacts(current).source, ""); assert.equal(nodeCaptureFacts(current).error, " ");
  assert.match(nodePresentationStatus(current).detail, /未返回具体原因/);
  assert.equal(nodeImageExportPlan(current, "own").detail, " ");
});

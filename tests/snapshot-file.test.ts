import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { UiNode, UiSnapshot } from "../shared/types";
import { isUiSnapshot } from "../shared/snapshot-validation";
import { MAX_SNAPSHOT_FILE_BYTES, parseSnapshotFile, serializeSnapshotFile } from "../shared/snapshot-file";
import { loadSnapshotFile, validateSnapshotImages } from "../electron/desktop/snapshot-file";
import { qmlStyleSvg } from "../shared/qml-style";

function node(id: string, children: UiNode[] = []): UiNode {
  return { id, index: 0, className: "android.view.View", package: "fixture.app", text: null, resourceId: "id/0x81", contentDesc: null,
    bounds: { left: 0, top: 0, right: 2, bottom: 2, raw: "[0,0][2,2]" }, clickable: false, enabled: true, focusable: false,
    focused: false, scrollable: false, selected: false, visibleToUser: true, children };
}
async function fixture(): Promise<UiSnapshot> {
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const child = { ...node("0/0"), layerImageDataUrl: dataUrl, layerImageSize: { width: 2, height: 2 }, layerImageStatus: "captured" as const, layerImageEmpty: false,
    attributes: { "image-source": "sdk", "view-ref": "android.view.View@real", "debug-name": "原始业务名" } };
  return { serial: "fixture-device", root: node("0", [child, { ...node("0/1"), layerImageStatus: "failed", attributes: { "image-capture-error": "原始缺图原因" } }]),
    nodeCount: 3, xmlSize: 12, rawXml: "<hierarchy/>", screenshotDataUrl: dataUrl, error: null, warning: "原始警告",
    inspectionSource: "debug-hybrid", captureMode: "deep", hierarchyDumpMode: "full", captureDurationMs: 20, captureTimings: { tree: 4, images: 16 },
    layerGroupImages: [{ nodeId: "0", image: { dataUrl, size: { width: 2, height: 2 }, capturedAt: "2026-10-11T00:00:00.000Z" } }] };
}
async function fileCase(run: (file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "inspector-snapshot-file-"));
  try { await run(join(directory, "snapshot.json")); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("complete file roundtrip preserves native pixels, subtree images, metadata and failures without rewriting the input", async () => {
  const snapshot = await fixture();
  const original = structuredClone(snapshot);
  await fileCase(async file => {
    const data = serializeSnapshotFile(snapshot, "2026-10-11T01:00:00.000Z");
    await writeFile(file, data);
    const imported = await loadSnapshotFile(file);
    assert.deepEqual(imported.snapshot, original);
    assert.equal(imported.legacy, false);
    assert.equal(imported.exportedAt, "2026-10-11T01:00:00.000Z");
    assert.equal(await readFile(file, "utf8"), data);
    assert.deepEqual(snapshot, original);
  });
});

test("legacy tree JSON remains a tree and never fabricates screen, source or missing layer images", async () => {
  const snapshot = await fixture();
  await fileCase(async file => {
    await writeFile(file, JSON.stringify({ serial: snapshot.serial, root: snapshot.root, nodeCount: snapshot.nodeCount, xmlSize: snapshot.xmlSize }));
    const imported = await loadSnapshotFile(file);
    assert.ok(imported.legacy);
    assert.equal(imported.snapshot.screenshotDataUrl, null);
    assert.equal(imported.snapshot.rawXml, null);
    assert.equal(imported.snapshot.inspectionSource, undefined);
    assert.equal(imported.snapshot.root!.children[1].layerImageStatus, "failed");
    assert.match(imported.snapshot.warning!, /旧版/);
  });
});

test("unknown version, wrong file type, duplicate IDs and inconsistent node counts are rejected", async () => {
  const snapshot = await fixture();
  const document = JSON.parse(serializeSnapshotFile(snapshot));
  assert.throws(() => parseSnapshotFile({ ...document, version: 3 }), /版本/);
  assert.throws(() => parseSnapshotFile({ ...document, format: "other-report" }), /不是/);
  assert.throws(() => parseSnapshotFile({ ...document, snapshot: { ...snapshot, nodeCount: 2 } }), /数量/);
  const repeated = structuredClone(snapshot); repeated.root!.children[0].id = "0";
  assert.throws(() => serializeSnapshotFile(repeated), /重复/);
  assert.throws(() => parseSnapshotFile({ serial: "f", root: snapshot.root, nodeCount: 3, xmlSize: 0, report: {} }), /请选择/);
});

test("saved native groups must reference existing unique nodes and retain validated sizes", async () => {
  const snapshot = await fixture();
  assert.ok(isUiSnapshot(snapshot));
  assert.equal(isUiSnapshot({ ...snapshot, layerGroupImages: [...snapshot.layerGroupImages!, ...snapshot.layerGroupImages!] }), false);
  assert.equal(isUiSnapshot({ ...snapshot, layerGroupImages: [{ ...snapshot.layerGroupImages![0], nodeId: "missing" }] }), false);
  assert.equal(isUiSnapshot({ ...snapshot, layerGroupImages: [{ ...snapshot.layerGroupImages![0], image: { ...snapshot.layerGroupImages![0].image, size: { width: -1, height: 2 } } }] }), false);
  const mismatch = structuredClone(snapshot); mismatch.layerGroupImages![0].image.size.width = 3;
  await assert.rejects(validateSnapshotImages(mismatch), /尺寸/);
});

test("corrupt JSON and oversized files fail before image loading", async () => {
  await fileCase(async file => {
    await writeFile(file, "{not JSON");
    await assert.rejects(loadSnapshotFile(file), /JSON/);
    await truncate(file, MAX_SNAPSHOT_FILE_BYTES + 1);
    await assert.rejects(loadSnapshotFile(file), /100 MiB/);
    await truncate(file, 0);
    await assert.rejects(loadSnapshotFile(file), /非空/);
  });
});

test("remote URLs, invalid base64, damaged pixels and dishonest dimensions are rejected", async () => {
  const original = await fixture();
  for (const screenshotDataUrl of ["https://example.com/image.png", "file:///tmp/image.png", "data:image/png;base64,YQ==", "data:image/png;base64,AAAA="])
    await assert.rejects(validateSnapshotImages({ ...original, screenshotDataUrl }), /图片/);
  const mismatch = structuredClone(original); mismatch.root!.children[0].layerImageSize!.height = 3;
  await assert.rejects(validateSnapshotImages(mismatch), /尺寸/);
});

test("small compressed images cannot exceed the fixed decoded pixel limit", async () => {
  const snapshot = await fixture();
  const oversized = await sharp({ create: { width: 4001, height: 4000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  assert.ok(oversized.length < 100_000);
  await assert.rejects(validateSnapshotImages({ ...snapshot, screenshotDataUrl: `data:image/png;base64,${oversized.toString("base64")}` }), /像素限制/);
});

test("actual self-contained QML style remains usable while active/external SVG content is rejected", async () => {
  const snapshot = await fixture();
  const svg = qmlStyleSvg({ fill: [20 / 255, 30 / 255, 40 / 255, 1], border: null, borderWidth: 0, pixelAligned: false, radii: [0, 0, 0, 0], gradient: null, unsupportedGradient: false, borderValidityUnknown: false }, { width: 2, height: 2 }, { width: 2, height: 2 }, 1);
  const styleNode = snapshot.root!.children[0];
  styleNode.layerImageStatus = "style";
  styleNode.layerImageDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await validateSnapshotImages(snapshot);
  for (const content of ['<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><script/></svg>', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><image href="file:///tmp/private.png"/></svg>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///tmp/private">]><svg/>']) {
    styleNode.layerImageDataUrl = `data:image/svg+xml;base64,${Buffer.from(content).toString("base64")}`;
    await assert.rejects(validateSnapshotImages(snapshot), /样式图片/);
  }
});

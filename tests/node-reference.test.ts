import { test } from "node:test";
import assert from "node:assert/strict";
import { makeNode } from "../benchmarks/fixtures";
import { nodeReferenceStatus, pinNodeReference } from "../src/features/inspection/node-reference";

test("reference copies existing values and rejects detached selection without reading anything", () => {
  const node = { ...makeNode("a"), text: "  保存原文\n", attributes: { "view-ref": "View@a", "inspection-source": "debug-qml", "background-color": "rgba(1,2,3,0.123456789)" } };
  const root = { ...makeNode("root"), children: [node] }, original = JSON.stringify(root);
  const reference = pinNodeReference(root, node, 1, "QML Debug", { id: "snapshot-a", capturedAt: "2026-10-13T00:00:00Z" }, null, "2026-10-13T01:00:00Z")!;
  assert.equal(reference.text, node.text); assert.equal(reference.colors[0].raw, node.attributes["background-color"]);
  assert.equal(reference.colors[0].encoding, "qml-rgba"); assert.equal(reference.styleReadAt, null);
  assert.equal(reference.snapshot.id, "snapshot-a"); assert.equal(reference.fixedAt, "2026-10-13T01:00:00Z");
  assert.equal(JSON.stringify(root), original); assert.equal(pinNodeReference(root, { ...node }, 1, "QML"), null);
  node.text = "changed"; node.bounds!.left = 99; node.attributes["background-color"] = "rgba(0,0,0,0)";
  assert.equal(reference.text, "  保存原文\n"); assert.notEqual(reference.geometry?.x, 99);
  assert.equal(reference.colors[0].raw, "rgba(1,2,3,0.123456789)");
});

test("reference stays frozen after refresh and refuses same-ID replacement, duplicate refs and changed class", () => {
  const a = { ...makeNode("a"), attributes: { "view-ref": "A" } }, root = { ...makeNode("root"), children: [a] };
  const reference = pinNodeReference(root, a, 4, "SDK")!;
  assert.equal(nodeReferenceStatus(reference, root), "current");
  const next = structuredClone(root); next.children[0].id = "moved";
  assert.equal(nodeReferenceStatus(reference, next), "stale");
  next.children[0].attributes!["view-ref"] = "replacement";
  assert.equal(nodeReferenceStatus(reference, next), "detached");
  next.children = [{ ...a, className: "OtherClass" }]; assert.equal(nodeReferenceStatus(reference, next), "detached");
  next.children = [{ ...a }, { ...a, id: "duplicate" }]; assert.equal(nodeReferenceStatus(reference, next), "detached");
  const bare = makeNode("bare"), noRefRoot = { ...root, children: [bare] }, noRef = pinNodeReference(noRefRoot, bare, 1, "unknown")!;
  assert.equal(nodeReferenceStatus(noRef, { ...noRefRoot }), "stale");
  assert.equal(nodeReferenceStatus(noRef, structuredClone(noRefRoot)), "detached");
});

test("missing values stay missing; only already confirmed styles contribute live colors and their real timestamp", () => {
  const node = { ...makeNode("a"), text: null, bounds: null, attributes: { "view-ref": "A", "background-color": "#80123456" } };
  const root = { ...makeNode("root"), children: [node] };
  const plain = pinNodeReference(root, node, "session", "未知")!;
  assert.equal(plain.geometry, null); assert.equal(plain.text, null); assert.equal(plain.colors[0].encoding, undefined);
  assert.deepEqual(plain.snapshot, {});
  const style = { ref: "A", capturedAtMillis: 1_800_000_000_000, backgroundType: "ColorDrawable", backgroundColor: "#00123456", textColor: "#FF010203", textSizePx: 14 };
  const live = pinNodeReference(root, node, 1, "SDK", {}, style)!;
  assert.equal(live.styleReadAt, style.capturedAtMillis); assert.equal(live.colors[0].raw, style.backgroundColor);
  assert.equal(live.colors[1].encoding, "android-argb");
  assert.equal(pinNodeReference(root, node, 1, "SDK", {}, { ...style, ref: "other" })!.styleReadAt, null);
});

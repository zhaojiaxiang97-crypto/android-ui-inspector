import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { GEOMETRY_EXPRESSION, geometryFrom, qmlGrabExpression, type QmlDebugNode } from "../electron/qml-debug";
import { qmlGroupNodeMatches, qmlUiTree } from "../electron/adb";
import { qmlStyleFrom, qmlStyleSvg } from "../shared/qml-style";
import { buildLayerOverview } from "../shared/layer-layout";

const red = { r: 1, g: 0, b: 0, a: 0.5 };
const item = { x: 0, y: 0, width: 20, height: 10, visible: true, opacity: 0.5, mapToItem: () => ({ x: 2, y: 3 }) };
const rectangle = { ...item, color: red, radius: 2, border: { width: 1, color: red, pixelAligned: false }, parent: { opacity: 0.5 } };
function read(object: object) {
  const value = runInNewContext(`(function() { return ${GEOMETRY_EXPRESSION}; }).call(subject)`, { subject: object, Qt: { Horizontal: 1 } });
  return geometryFrom(JSON.parse(JSON.stringify(value)))!;
}

test("QML captures own rectangle/window styles, never treats text color as a background", () => {
  const geometry = read(rectangle);
  assert.deepEqual(geometry.style?.fill, [1, 0, 0, 0.5]);
  assert.equal(geometry.effectiveOpacity, 0.25);
  assert.deepEqual(geometry.style?.radii, [2, 2, 2, 2]);
  assert.equal(read({ ...item, text: "hello", color: red }).style, null);
  assert.equal(read(item).style, null);
  assert.deepEqual(read({ width: 20, height: 10, contentItem: {}, color: red }).style?.fill, [1, 0, 0, 0.5]);
  assert.equal(geometryFrom(null), null);
  assert.equal(geometryFrom([0, 0, NaN, 10, true, true, 1, 0, ""]), null);
});

test("QML transports gradients, explicit zero corner radii, clipping and offscreen opacity", () => {
  const geometry = read({ ...rectangle, clip: true, layer: { enabled: true }, topLeftRadius: 0,
    gradient: { orientation: 1, stops: [{ position: 0, color: red }, { position: 1, color: { ...red, a: 0 } }] } });
  assert.deepEqual(geometry.style?.radii, [0, 2, 2, 2]);
  assert.equal(geometry.style?.gradient?.horizontal, true);
  assert.deepEqual(geometry.style?.gradient?.stops[1].color, [1, 0, 0, 0]);
  assert.equal(geometry.clip, true);
  assert.equal(geometry.layerEnabled, true);
  const unknown = read({ ...rectangle, gradient: "NightFade" }).style!;
  assert.equal(unknown.unsupportedGradient, true);
  assert.match(qmlStyleSvg(unknown, item, item, 1), /fill="none"/);
  assert.equal(qmlStyleFrom([[2, 0, 0, 1], null, -1, [0, 0, 0, 0], true, null, false]), null);
  const defaultPen = read({ ...rectangle, border: { width: 1, color: { r: 0, g: 0, b: 0, a: 1 }, pixelAligned: true } }).style!;
  assert.equal(defaultPen.borderValidityUnknown, true);
  assert.doesNotMatch(qmlStyleSvg(defaultPen, item, item, 1), /fill-rule="evenodd"/, "do not invent Qt's uninitialized default black border");
});

test("QML conversion attaches bounded independent style images even to parents with children", () => {
  const child: QmlDebugNode = { debugId: 2, parentId: 1, contextId: 1, type: "Text", idString: "label", objectName: "", url: "", line: 0, column: 0, geometry: read({ ...item, text: "child text", color: red }), children: [] };
  const root: QmlDebugNode = { ...child, debugId: 1, type: "CustomCard", idString: "card", geometry: read(rectangle), children: [child] };
  const node = qmlUiTree(root, "test.qml", { left: 0, top: 100, right: 60, bottom: 130, raw: "" });
  assert.equal(node.layerImageStatus, "style");
  assert.deepEqual(node.layerImageSize, { width: 60, height: 30 });
  assert.equal(node.attributes?.["background-color"], "rgba(255,0,0,0.5)");
  assert.equal(node.attributes?.["border-width"], "3");
  assert.equal(node.attributes?.["effective-alpha"], "0.25");
  assert.equal(node.children[0].layerImageDataUrl, undefined);
  const svg = Buffer.from(node.layerImageDataUrl!.split(",")[1], "base64").toString();
  assert.match(svg, /viewBox="0 0 20 10"/);
  assert.doesNotMatch(svg, /child text|<image|<script|href=/);
  assert.throws(() => qmlStyleSvg(read(rectangle).style!, { width: Infinity, height: 10 }, item, 1));

  const wrapper = { ...root, geometry: null, children: [root] };
  const converted = qmlUiTree({ ...root, children: [wrapper] }, "test.qml", null);
  const layout = buildLayerOverview(converted, null, { width: 100, height: 100 });
  assert.ok(layout.records.some((record) => record.id === "0/0/0"), "nonvisual wrappers must not hide visual children");

  const negative = { ...root, geometry: { ...root.geometry!, z: -1 }, children: [] };
  const ordered = qmlUiTree({ ...root, children: [{ ...root, children: [negative, child] }] }, "test.qml", null);
  assert.deepEqual(buildLayerOverview(ordered, null, { width: 100, height: 100 }).records.map((record) => record.id), ["0/0/0", "0/0", "0/0/1"]);
});

test("Qt image grabs only visual leaves and keeps their pixels off the parent plane", () => {
  const path = '/data/user/0/sample/cache/own"image.png';
  const expression = qmlGrabExpression(path, 80, 40);
  let saved = "", target = { width: 0, height: 0 };
  const leaf = { children: [], grabToImage(callback: (result: { saveToFile: (name: string) => boolean }) => void, size: typeof target) {
    target = size;
    callback({ saveToFile(name) { saved = name; return true; } });
    return true;
  } };
  const evaluate = (subject: object) => runInNewContext(`(function() { return ${expression}; }).call(subject)`, { subject, Qt: { size: (width: number, height: number) => ({ width, height }) } });
  assert.equal(evaluate(leaf), true);
  assert.equal(saved, path);
  assert.deepEqual(target, { width: 80, height: 40 });
  saved = "";
  assert.equal(evaluate({ ...leaf, children: [{}] }), false);
  assert.equal(saved, "", "a parent must never capture child pixels");
  const groupExpression = qmlGrabExpression(path, 80, 40, true);
  const evaluateGroup = (subject: object) => runInNewContext(`(function() { return ${groupExpression}; }).call(subject)`, { subject, Qt: { size: (width: number, height: number) => ({ width, height }) } });
  assert.equal(evaluateGroup({ ...leaf, children: [{}] }), true, "group grabs explicitly include children");
  assert.equal(saved, path);

  const text: QmlDebugNode = { debugId: 2, parentId: 1, contextId: 1, type: "QQuickText", idString: "label", objectName: "", url: "", line: 0, column: 0, geometry: read({ ...item, text: "label" }), children: [] };
  const parent: QmlDebugNode = { ...text, debugId: 1, type: "QQuickRectangle", geometry: read(rectangle), children: [text] };
  const result = qmlUiTree(parent, "sample", null, new Map([[2, { dataUrl: "data:image/png;base64,b3du", width: 56, height: 28 }]]));
  assert.equal(result.layerImageStatus, "style");
  assert.equal(result.children[0].layerImageStatus, "captured");
  assert.deepEqual(result.children[0].layerImageSize, { width: 56, height: 28 });
});

test("Qt group refresh rejects a changed object, source or geometry", () => {
  const child: QmlDebugNode = { debugId: 2, parentId: 1, contextId: 1, type: "QQuickText", idString: "label", objectName: "", url: "Card.qml", line: 8, column: 0, geometry: read({ ...item, text: "child" }), children: [] };
  const parent: QmlDebugNode = { ...child, debugId: 1, type: "QQuickRectangle", idString: "card", line: 3, geometry: read(rectangle), children: [child] };
  const expected = qmlUiTree(parent, "sample.debug", null);
  const current = structuredClone(expected);
  assert.equal(qmlGroupNodeMatches(expected, current), true);
  assert.equal(qmlGroupNodeMatches(expected, { ...current, children: [] }), false);
  assert.equal(qmlGroupNodeMatches(expected, { ...current, bounds: { ...current.bounds!, left: current.bounds!.left + 1 } }), false);
  assert.equal(qmlGroupNodeMatches(expected, { ...current, attributes: { ...current.attributes, "qml-debug-id": "99" } }), false);
  assert.equal(qmlGroupNodeMatches(expected, { ...current, attributes: { ...current.attributes, "qml-source": "Other.qml" } }), false);
});

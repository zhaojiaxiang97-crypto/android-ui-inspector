import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseInputDisplay, pngSize } from "../electron/capture-display";
import { parseUiHierarchy } from "../electron/adb";

const viewport = "Viewport INTERNAL: displayId=0, uniqueId=local:0, port=0, orientation=0, logicalFrame=[0, 0, 1080, 2400], physicalFrame=[0, 0, 1080, 2400], deviceSize=[1080, 2400], isActive=[1]";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("sanitized portrait fixture preserves preorder, index zero and common Android attributes", () => {
  const parsed = parseUiHierarchy(fixture("uiautomator-portrait.xml"));
  assert.equal(parsed.rotation, 0);
  assert.equal(parsed.root.id, "0");
  assert.equal(parsed.root.index, 0);
  assert.equal(parsed.root.children.length, 3);
  assert.deepEqual(parsed.root.bounds, { left: 0, top: 0, right: 1080, bottom: 2400, raw: "[0,0][1080,2400]" });
  assert.equal(parsed.root.attributes?.["class"], "android.widget.FrameLayout");
  assert.equal(parsed.root.attributes?.["checkable"], "false");
  assert.equal(parsed.root.attributes?.["bounds"], "[0,0][1080,2400]");
  assert.equal(parsed.root.children[0].index, 0);
  assert.equal(parsed.root.children[1].index, 1);
  assert.equal(parsed.root.children[1].children[0].id, "0/1/0");
  assert.equal(parsed.root.children[1].children[0].clickable, true);
  assert.equal(parsed.root.children[1].scrollable, true);
  assert.equal(parsed.root.children[1].children[0].resourceId, "com.example.sanitized:id/continue");
});

test("sanitized landscape fixture keeps screen-space bounds and rotation as reported", () => {
  const parsed = parseUiHierarchy(fixture("uiautomator-landscape.xml"));
  assert.equal(parsed.rotation, 1);
  assert.deepEqual(parsed.root.bounds, { left: 0, top: 0, right: 2400, bottom: 1080, raw: "[0,0][2400,1080]" });
  assert.deepEqual(parsed.root.children[1].bounds, { left: 1840, top: 900, right: 2360, bottom: 1040, raw: "[1840,900][2360,1040]" });
  assert.equal(parsed.root.children[1].focused, true);
});

test("real-device-shaped fixture tolerates omitted visibility, extra attributes and sparse child indices", () => {
  const parsed = parseUiHierarchy(fixture("uiautomator-device-landscape-sanitized.xml"));
  assert.equal(parsed.rotation, 1);
  assert.equal(parsed.root.children[0].children.length, 4);
  assert.equal(parsed.root.children[0].children[1].children.length, 12);
  assert.equal(parsed.root.children[0].children[1].children[11].index, 76);
  assert.equal(parsed.root.children[0].children[1].children[11].id, "0/0/1/11");
  assert.equal(parsed.root.children[0].children[1].children[11].visibleToUser, true);
  assert.equal(parsed.root.children[0].children[1].children[2].clickable, true);
  assert.equal(parsed.root.children[0].children[2].index, 3);
  assert.deepEqual(parsed.root.bounds, { left: 104, top: 0, right: 2400, bottom: 1080, raw: "[104,0][2400,1080]" });
  assert.deepEqual(parsed.root.children[0].children[1].children[7].bounds, { left: 104, top: 104, right: 103, bottom: 103, raw: "[104,104][103,103]" });
});

test("synthetic OEM and modern virtual-content variants tolerate attribute/order differences", () => {
  const oem = parseUiHierarchy(fixture("uiautomator-oem-style.xml"));
  assert.equal(oem.rotation, 2);
  assert.deepEqual(oem.root.bounds, { left: 0, top: 0, right: 1440, bottom: 2560, raw: "[ 0 , 0 ][ 1440 , 2560 ]" });
  assert.equal(oem.root.children[0].index, 0);
  assert.equal(oem.root.children[0].clickable, true);
  assert.equal(oem.root.children[0].enabled, true);
  assert.equal(oem.root.attributes?.displayed, "true");
  assert.equal(oem.root.attributes?.["drawing-order"], "0");
  assert.equal(oem.root.children[1].attributes?.checked, "true");
  assert.equal(oem.root.children[1].index, 4);
  assert.equal("checked" in oem.root.children[1], false);
  assert.equal(oem.root.children[1].selected, true);

  const virtual = parseUiHierarchy(fixture("uiautomator-modern-virtual.xml"));
  assert.equal(virtual.rotation, 0);
  assert.equal(virtual.root.children[0].className, "android.view.View");
  assert.equal(virtual.root.children[0].contentDesc, "Virtual action");
  assert.equal(virtual.root.children[0].clickable, true);
  assert.equal(virtual.root.children[1].index, 2);
  assert.equal(virtual.root.children[1].text, "Virtual label");
});

test("legacy fixture tolerates missing attributes and numeric boolean encodings", () => {
  const parsed = parseUiHierarchy(fixture("uiautomator-legacy.xml"));
  assert.equal(parsed.rotation, null);
  assert.equal(parsed.root.index, null);
  assert.equal(parsed.root.text, null);
  assert.equal(parsed.root.enabled, true);
  assert.equal(parsed.root.visibleToUser, true);
  assert.equal(parsed.root.focusable, true);
  assert.equal(parsed.root.children[0].index, 0);
  assert.equal(parsed.root.children[0].visibleToUser, false);
  assert.equal(parsed.root.children[0].enabled, false);
  assert.equal(parsed.root.children[0].clickable, true);
  assert.deepEqual(parsed.root.children[1].bounds, { left: 8, top: 72, right: 712, bottom: 120, raw: "[ 8, 72 ][ 712, 120 ]" });
});

test("XML entities are decoded without changing the original node structure", () => {
  const parsed = parseUiHierarchy(fixture("uiautomator-escaped.xml"));
  assert.equal(parsed.rotation, 3);
  assert.equal(parsed.root.text, "A & B < C");
  assert.equal(parsed.root.contentDesc, 'Say "hello"');
  assert.equal(parsed.root.resourceId, "com.example.sanitized:id/escaped");
});

test("malformed and unsafe bounds are ignored while valid siblings remain usable", () => {
  const parsed = parseUiHierarchy(fixture("uiautomator-invalid-bounds.xml"));
  assert.equal(parsed.root.children.length, 3);
  assert.equal(parsed.root.children[0].bounds, null);
  assert.equal(parsed.root.children[1].bounds, null);
  assert.equal(parsed.root.children[2].bounds, null);
});

test("deep accessibility hierarchy is normalized near the parser nesting limit", () => {
  const makeDeepXml = (depth: number) => {
    const open = Array.from({ length: depth }, (_, index) => `<node index="${index}" class="android.view.View" bounds="[0,${index}][10,${index + 1}]">`).join("");
    return `<hierarchy rotation="0">${open}${"</node>".repeat(depth)}</hierarchy>`;
  };
  const depth = 190;
  const { root } = parseUiHierarchy(makeDeepXml(depth));
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    assert.equal(cursor.index, index);
    assert.equal(cursor.id, `0${"/0".repeat(index)}`);
    if (index < depth - 1) {
      assert.equal(cursor.children.length, 1);
      cursor = cursor.children[0];
    }
  }
  assert.equal(cursor.children.length, 0);
  assert.throws(() => parseUiHierarchy(makeDeepXml(400)), /Maximum nested tags exceeded/);
});

test("default-display diagnostics parse repeated, rotated and overridden logical frames", () => {
  assert.deepEqual(parseInputDisplay(`${viewport}\n  ${viewport}`), { rotation: 0, width: 1080, height: 2400 });
  assert.deepEqual(parseInputDisplay(viewport.replace("orientation=0", "orientation=1").replace("logicalFrame=[0, 0, 1080, 2400]", "logicalFrame=[0, 0, 1600, 720]")), { rotation: 1, width: 1600, height: 720 });
});

test("diagnostic parser refuses unknown, external, inactive and conflicting viewports", () => {
  for (const text of ["", "SurfaceOrientation: 0", viewport.replace("INTERNAL", "EXTERNAL"), viewport.replace("displayId=0", "displayId=10"), viewport.replace("orientation=0", "orientation=90"), viewport.replace("isActive=[1]", "isActive=[0]"), viewport.replace("logicalFrame=[0, 0", "logicalFrame=[10, 0"), `${viewport}\n${viewport.replace("orientation=0", "orientation=1")}`]) {
    assert.equal(parseInputDisplay(text), null);
  }
});

test("PNG header rejects text/truncated data and reads portrait/landscape dimensions", () => {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.writeUInt32BE(13, 8); header.write("IHDR", 12, "ascii");
  for (const [width, height] of [[1080, 2400], [2400, 1080]]) {
    header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
    assert.deepEqual(pngSize(header), { width, height });
  }
  assert.equal(pngSize(Buffer.from("permission denied")), null);
  assert.equal(pngSize(header.subarray(0, 24)), null);
  header.writeUInt32BE(0, 16); assert.equal(pngSize(header), null);
  header.writeUInt32BE(100, 16); header.write("FAIL", 12, "ascii"); assert.equal(pngSize(header), null);
});

test("XML retains current-display bounds and rotation without rotating coordinates twice", () => {
  for (const rotation of [0, 1, 2, 3]) {
    const { root, rotation: parsed } = parseUiHierarchy(`<hierarchy rotation="${rotation}"><node bounds="[10,80][2400,1000]" class="android.view.View" /></hierarchy>`);
    assert.equal(parsed, rotation);
    assert.deepEqual(root.bounds, { left: 10, top: 80, right: 2400, bottom: 1000, raw: "[10,80][2400,1000]" });
  }
  for (const attribute of ["", 'rotation=""', 'rotation="90"', 'rotation="NaN"']) {
    assert.equal(parseUiHierarchy(`<hierarchy ${attribute}><node class="android.view.View" /></hierarchy>`).rotation, null);
  }
});

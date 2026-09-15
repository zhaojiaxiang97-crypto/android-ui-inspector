import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { applyViewProperties, attachViewLayerImages } from "../electron/adb";
import { captureTextureViewBitmaps, parseCapturedViewLayers } from "../electron/view-debug";
import type { UiNode } from "../shared/types";

test("failed video capture disposes the debugger session", async () => {
  const commands: number[][] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0), handshake = false;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!handshake) {
        if (buffer.length < 14) return;
        socket.write(buffer.subarray(0, 14)); buffer = buffer.subarray(14); handshake = true;
      }
      while (buffer.length >= 11 && buffer.length >= buffer.readUInt32BE()) {
        const packet = buffer.subarray(0, buffer.readUInt32BE()); buffer = buffer.subarray(packet.length);
        commands.push([packet[9], packet[10]]);
        const reply = Buffer.alloc(11);
        reply.writeUInt32BE(11); packet.copy(reply, 4, 4, 8); reply[8] = 0x80;
        if (packet[10] === 7) reply.writeUInt16BE(99, 9);
        socket.write(reply);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(captureTextureViewBitmaps(address.port, ["TextureView@123"]), /JDWP 1\/7/);
    assert.deepEqual(commands, [[1, 7], [1, 6]]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Debug View layer parser keeps transparent PNGs and tolerates null captures", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(32, 16);
  png.writeUInt32BE(16, 20);
  const name = Buffer.from("TextView");
  const imageRecord = Buffer.alloc(1 + 2 + name.length + 1 + 8 + 4 + png.length);
  let offset = 0;
  imageRecord[offset++] = 1;
  imageRecord.writeUInt16BE(name.length, offset);
  offset += 2;
  name.copy(imageRecord, offset);
  offset += name.length;
  imageRecord[offset++] = 1;
  imageRecord.writeInt32BE(10, offset);
  imageRecord.writeInt32BE(20, offset + 4);
  offset += 8;
  imageRecord.writeUInt32BE(png.length, offset);
  png.copy(imageRecord, offset + 4);
  const nullName = Buffer.from("View");
  const nullRecord = Buffer.alloc(1 + 2 + nullName.length + 1 + 8);
  offset = 0;
  nullRecord[offset++] = 1;
  nullRecord.writeUInt16BE(nullName.length, offset);
  offset += 2;
  nullName.copy(nullRecord, offset);
  offset += nullName.length;
  nullRecord[offset++] = 1;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(1080, 0);
  header.writeUInt32BE(2400, 4);

  const layers = parseCapturedViewLayers(Buffer.concat([header, imageRecord, nullRecord, Buffer.from([2])]));

  assert.deepEqual(layers.map(({ name, width, height }) => ({ name, width, height })), [
    { name: "TextView", width: 32, height: 16 },
    { name: "View", width: 0, height: 0 },
  ]);
  assert.match(layers[0].pngDataUrl ?? "", /^data:image\/png;base64,/);
  assert.equal(layers[1].pngDataUrl, null);
});

test("Debug View bitmaps only attach to an exact matching rectangle", () => {
  const node = (id: string, left: number): UiNode => ({
    id, index: 0, className: "android.widget.TextView", package: "app", text: null, resourceId: null, contentDesc: null,
    bounds: { left, top: 20, right: left + 32, bottom: 36, raw: `[${left},20][${left + 32},36]` },
    clickable: false, enabled: true, focusable: false, focused: false, scrollable: false, selected: false, visibleToUser: true,
    attributes: { "inspection-source": "debug-view" }, children: [],
  });
  const exact = node("0/0", 10);
  const nearby = node("0/1", 11);
  const root = { ...node("0", 0), className: "Activity", children: [nearby, exact] };
  const pngDataUrl = "data:image/png;base64,AA==";

  assert.equal(attachViewLayerImages(root, [{ name: "TextView", visible: true, x: 10, y: 20, width: 32, height: 16, pngDataUrl }]), 1);
  assert.equal(exact.layerImageDataUrl, pngDataUrl);
  assert.equal(nearby.layerImageDataUrl, undefined);
});

test("real alpha hides transparent overlays and descendants; screen coordinates include translation", () => {
  const node = (id: string): UiNode => ({
    id, index: 0, className: "View", package: "app", text: null, resourceId: null, contentDesc: null, bounds: null,
    clickable: false, enabled: true, focusable: false, focused: false, scrollable: false, selected: false, visibleToUser: true,
    attributes: { "view-ref": `View@${id}` }, children: [],
  });
  const root = node("a"), shadow = node("b"), child = node("c");
  root.children = [shadow]; shadow.children = [child];
  applyViewProperties(root, "View@a drawing:getAlpha()=3,0.5 layout:getLocationOnScreen_x()=2,10 layout:getLocationOnScreen_y()=2,20 layout:getWidth()=3,100 layout:getHeight()=3,200 \n View@b drawing:getAlpha()=3,0.0 \n  View@c drawing:getAlpha()=3,1.0 ");
  assert.equal(root.attributes?.["effective-alpha"], "0.5");
  assert.equal(root.bounds?.raw, "[10,20][110,220]");
  assert.equal(shadow.visibleToUser, false);
  assert.equal(child.visibleToUser, false);
});

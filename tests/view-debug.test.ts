import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { inflateSync } from "node:zlib";
import { applyViewProperties, attachViewLayerImages, debugViewTree, nativeViewBranchMatches, nativeViewNodeMatches, needsViewBitmapFallback } from "../electron/adb";
import { captureViewBitmaps, captureViewLayers, matchesViewRoot, parseCapturedViewLayers } from "../electron/view-debug";
import { inspectQmlHierarchy } from "../electron/qml-debug";
import { makeNode } from "../benchmarks/fixtures";
import { decodeViewHierarchy } from "../electron/view-hierarchy";
import type { UiNode } from "../shared/types";

const activityTarget = { packageName: "example.app", activityName: "example.app.MainActivity", component: "example.app/example.app.MainActivity" };
const activityHierarchy = `mAppBounds=Rect(0, 104 - 1080, 2355)
    View Hierarchy:
      DecorView@9c5dabe[MainActivity]
        android.widget.LinearLayout{65440cf V.E...... ........ 0,0-1080,2355}
          android.widget.TextView{abc V.ED..... ........ 10,20-110,60 #7f001 app:id/title}
    Looper (main)
`;

type EncodedProperties = { [key: string]: string | number | boolean | EncodedProperties };
function encodedHierarchy(root: EncodedProperties, complete = true) {
  const names = new Map<string, number>();
  const short = (value: number) => { const b = Buffer.alloc(3); b[0] = 83; b.writeUInt16BE(value, 1); return b; };
  const key = (name: string) => { if (!names.has(name)) names.set(name, names.size + 1); return short(names.get(name)!); };
  const value = (item: EncodedProperties[string]): Buffer => {
    if (typeof item === "boolean") return Buffer.from([90, Number(item)]);
    if (typeof item === "number") { const b = Buffer.alloc(5); b[0] = Number.isInteger(item) ? 73 : 70; if (b[0] === 73) b.writeInt32BE(item, 1); else b.writeFloatBE(item, 1); return b; }
    if (typeof item === "string") { const bytes = Buffer.from(item), header = Buffer.alloc(3); header[0] = 82; header.writeUInt16BE(bytes.length, 1); return Buffer.concat([header, bytes]); }
    return Buffer.concat([Buffer.from("M"), ...Object.entries(item).flatMap(([name, data]) => [key(name), value(data)]), short(0)]);
  };
  const body = Buffer.concat([key("window:left"), value(7), key("window:top"), value(104), value(root)]);
  const marker = [Buffer.from("M"), key("__name__"), value("propertyIndex")];
  return complete ? Buffer.concat([body, ...marker, ...[...names].flatMap(([name, id]) => [short(id), value(name)]), short(0)]) : body;
}
function encodedView(hash: number, extra: EncodedProperties = {}): EncodedProperties {
  return { "meta:__name__": "android.view.View", "meta:__hash__": hash, "layout:left": 0, "layout:top": 0, "layout:width": 100, "layout:height": 40, "misc:visibility": 0, ...extra };
}

test("V2 decoding preserves identity, text, scroll, transforms and rejects incomplete hierarchies", () => {
  const root = debugViewTree(activityHierarchy, activityTarget);
  const child = encodedView(-1, { "layout:left": 10, "layout:top": 20, "drawing:translationX": 3, "text:text": "背景 = 😀", "id": "id/title", "drawing:alpha": 0.5, "padding:paddingLeft": 2 });
  const properties = encodedView(0x9c5dabe, { "meta:__name__": "com.android.internal.policy.DecorView", "drawing:scaleX": 2, "drawing:scaleY": 2, "drawing:pivotX": 0, "drawing:pivotY": 0, "scrolling:scrollX": 4, "scrolling:scrollY": 5, "meta:__childCount__": 1, "meta:__child__0": child });
  const bytes = encodedHierarchy(properties);
  applyViewProperties(root, decodeViewHierarchy(bytes), true);
  const node = root.children[0].children[0];
  assert.equal(node.attributes?.["view-ref"], "android.view.View@ffffffff");
  assert.equal(node.bounds?.raw, "[25,134][125,174]");
  assert.equal(node.text, "背景 = 😀");
  assert.equal(node.attributes?.["effective-alpha"], "0.5");
  assert.equal(node.attributes?.["padding-left"], "2");
  assert.equal(node.attributes?.["skip-draw"], undefined, "willNotDraw must not be mistaken for PFLAG_SKIP_DRAW");
  const current = structuredClone(root);
  assert.equal(nativeViewNodeMatches(root, current, node.id), true);
  const nested = makeNode(`${node.id}/0`);
  nested.attributes = { "view-ref": "android.view.View@nested" };
  node.children.push(nested);
  current.children[0].children[0].children.push(structuredClone(nested));
  assert.equal(nativeViewBranchMatches(root, current, node.id), true);
  current.children[0].children[0].children[0].attributes!["view-ref"] = "android.view.View@replaced";
  assert.equal(nativeViewBranchMatches(root, current, node.id), false, "a replaced descendant must invalidate a branch refresh");
  current.children[0].children[0].children[0].attributes!["view-ref"] = "android.view.View@nested";
  current.children[0].children[0].bounds!.left++;
  assert.equal(nativeViewNodeMatches(root, current, node.id), true, "the same View may move between initial capture and refresh");
  current.children[0].children[0].bounds!.left--;
  current.children[0].children[0].attributes!["view-ref"] = "android.view.View@other";
  assert.equal(nativeViewNodeMatches(root, current, node.id), false, "replaced views cannot receive a stale bitmap");
  assert.equal(nativeViewNodeMatches(root, structuredClone(root), "0/99"), false);
  for (const data of [bytes.subarray(0, 12), bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from([0])]), encodedHierarchy(properties, false), encodedHierarchy({ ...properties, "meta:__childCount__": 2 }), encodedHierarchy({ ...properties, "meta:__child__0": properties }), encodedHierarchy({ ...properties, "layout:width": NaN })]) assert.throws(() => decodeViewHierarchy(data), /Debug V2/);
  const rotated = decodeViewHierarchy(encodedHierarchy(encodedView(1, { "drawing:rotation": 90, "drawing:pivotX": 0, "drawing:pivotY": 0, "meta:__childCount__": 1, "meta:__child__0": child })));
  assert.match(rotated, /layout:getLocationOnScreen_x\(\)=3,-13 layout:getLocationOnScreen_y\(\)=3,117/);
  const perspective = decodeViewHierarchy(encodedHierarchy(encodedView(1, { "drawing:rotationY": 30, "meta:__childCount__": 1, "meta:__child__0": child })));
  assert.equal(perspective.includes("getLocationOnScreen"), false, "do not guess unavailable camera/perspective geometry");
});

test("Activity hierarchy retains shorthand DecorView and fills its measured geometry from DDMS", () => {
  const root = debugViewTree(activityHierarchy, activityTarget);
  const decor = root.children[0];
  assert.equal(root.children.length, 1);
  assert.equal(decor.className, "DecorView");
  assert.equal(decor.attributes?.["view-ref"], "DecorView@9c5dabe");
  assert.equal(decor.bounds, null);
  assert.equal(decor.visibleToUser, true);
  assert.equal(decor.children[0].className, "android.widget.LinearLayout");
  assert.equal(decor.children[0].children[0].bounds?.raw, "[10,20][110,60]");
  const ref = "com.android.internal.policy.DecorView@9c5dabe";
  applyViewProperties(root, `${ref} layout:getLocationOnScreen_x()=1,0 layout:getLocationOnScreen_y()=1,0 layout:getWidth()=4,1080 layout:getHeight()=4,2355 \n`);
  assert.equal(decor.className, "com.android.internal.policy.DecorView");
  assert.equal(decor.attributes?.["view-ref"], ref);
  assert.deepEqual(decor.bounds, { left: 0, top: 0, right: 1080, bottom: 2355, raw: "[0,0][1080,2355]" });
  assert.equal(attachViewLayerImages(root, [{ name: "DecorView", x: 0, y: 0, width: 1080, height: 2355, visible: true, pngDataUrl: "data:image/png;base64,AA==" }]), 1);
  assert.equal(decor.layerImageStatus, "captured");

  const ordinary = debugViewTree(activityHierarchy.replace("DecorView@9c5dabe[MainActivity]", "com.android.internal.policy.DecorView{9c5dabe V.E...... ........ 0,0-1080,2355}"), activityTarget);
  assert.equal(ordinary.children[0].attributes?.["view-ref"], ref);
  assert.equal(ordinary.children[0].children[0].className, "android.widget.LinearLayout");
});

test("captured framework views skip duplicate JDWP lookup, custom and surface views do not", () => {
  const node = makeNode("view");
  node.layerImageStatus = "captured";
  for (const className of ["android.view.View", "android.widget.TextView", "android.widget.FrameLayout"]) {
    node.className = className;
    assert.equal(needsViewBitmapFallback(node), false);
  }
  for (const className of ["android.view.SurfaceView", "android.view.TextureView", "com.example.CustomSurface", "android.widget.VideoView"]) {
    node.className = className;
    assert.equal(needsViewBitmapFallback(node), true);
  }
  node.className = "android.widget.TextView";
  node.layerImageStatus = "unavailable";
  assert.equal(needsViewBitmapFallback(node), true);
  node.layerImageStatus = "captured";
  node.attributes = { "skip-draw": "true" };
  assert.equal(needsViewBitmapFallback(node), true);
});

test("only DecorView shorthand is accepted as an alias of a qualified root identity", () => {
  assert.equal(matchesViewRoot("DecorView@abc", "com.android.internal.policy.DecorView@abc"), true);
  assert.equal(matchesViewRoot("DecorView@abc", "com.android.internal.policy.impl.PhoneWindow$DecorView@abc"), true);
  assert.equal(matchesViewRoot("DecorView@abc", "com.android.internal.policy.DecorView@def"), false);
  assert.equal(matchesViewRoot("DecorView@abc", "com.example.NotDecorView@abc"), false);
  assert.equal(matchesViewRoot("LinearLayout@abc", "android.widget.LinearLayout@abc"), false);
  assert.equal(matchesViewRoot("one.DecorView@abc", "two.DecorView@abc"), false);
});

test("DDMS restores omitted custom parents and images, preserving identity and native properties", () => {
  const root = debugViewTree(activityHierarchy, activityTarget);
  const row = (ref: string, values: Record<string, string>) => `${ref} ${Object.entries(values).map(([key, value]) => `${key}=${value.length},${value}`).join(" ")} \n`;
  const geometry = { "layout:getLocationOnScreen_x()": "10", "layout:getLocationOnScreen_y()": "124", "layout:getWidth()": "100", "layout:getHeight()": "40" };
  const dump = row("com.android.internal.policy.DecorView@9c5dabe", { "getVisibility()": "VISIBLE" })
    + row(" example.CustomContainer@123", { ...geometry, mPrivateFlags: "0x1000080" })
    + row("  android.widget.TextView@abc", { ...geometry, "text:mText": "Text = 😀", "isClickable()": "true" })
    + row("  example.CustomImage@456", { ...geometry, mID: "id/avatar", "isEnabled()": "false" })
    + row(" example.CustomImage@789", { ...geometry, "getVisibility()": "GONE" }) + "DONE.\n";
  applyViewProperties(root, dump, true);
  const decor = root.children[0], container = decor.children[0];
  assert.equal(decor.children.length, 2);
  assert.equal(container.className, "example.CustomContainer");
  assert.equal(container.attributes?.["skip-draw"], "true");
  assert.equal(container.children[0].id, "0/0/0/0");
  assert.equal(container.children[0].text, "Text = 😀");
  assert.equal(container.children[0].resourceId, "app:id/title");
  assert.equal(container.children[0].clickable, true);
  const image = container.children[1];
  assert.equal(image.resourceId, "id/avatar");
  assert.equal(image.enabled, false);
  assert.equal(image.bounds?.raw, "[10,124][110,164]");
  assert.equal(decor.children[1].visibleToUser, false);
  assert.equal(attachViewLayerImages(root, [{ name: "id/avatar", visible: true, x: 10, y: 20, width: 100, height: 40, pngDataUrl: "own-image" }], { x: 0, y: 104 }), 1);
  assert.equal(image.layerImageDataUrl, "own-image");
  const children = root.children;
  for (const invalid of [dump.replace("example.CustomImage@789", "example.CustomImage@456"), dump.replace("id/avatar", "id/a"), dump.replace(" example.CustomImage@789", "unparsed"), dump.replace("example.CustomImage@789", "other.Window@1").replace(" other.Window@1", "other.Window@1")]) {
    assert.throws(() => applyViewProperties(root, invalid, true), /Debug/);
    assert.equal(root.children, children, "invalid data must not replace the existing hierarchy");
  }
});

test("fallback preserves own pixels, handles cold startup and bounds capture work", async () => {
  const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const string = (s: string) => Buffer.concat([int(Buffer.byteLength(s)), Buffer.from(s)]);
  const tagged = (tag: string, value: number) => Buffer.concat([Buffer.from(tag), int(value)]);
  const result = (tag: string, value = 0, exception = 0) => Buffer.concat([tag === "V" ? Buffer.from("V") : tagged(tag, value), tagged("L", exception)]);
  const methods = [
    [1, "hashCode", "()I"], [2, "findView", "(Landroid/view/View;Ljava/lang/String;)Landroid/view/View;"],
    [3, "getWidth", "()I"], [4, "getHeight", "()I"], [5, "getPixels", "([IIIIIII)V"],
    [6, "<init>", "()V"], [7, "createSnapshot", "(Landroid/view/ViewDebug$CanvasProvider;Z)Landroid/graphics/Bitmap;"],
    [8, "valueOf", "(Ljava/lang/String;)Landroid/graphics/Bitmap$Config;"], [9, "copy", "(Landroid/graphics/Bitmap$Config;Z)Landroid/graphics/Bitmap;"],
    [10, "recycle", "()V"], [11, "getBitmap", "()Landroid/graphics/Bitmap;"],
    [12, "next", "()Landroid/os/Message;"],
    [13, "getInstance", "()Landroid/view/WindowManagerGlobal;"], [14, "getRootView", "(Ljava/lang/String;)Landroid/view/View;"],
    [15, "forName", "(Ljava/lang/String;)Ljava/lang/Class;"],
  ] as const;
  const strings = new Map<number, string>(), classes = new Map<string, number>(), arrays = new Map<number, number>();
  const pins: number[] = [], released: number[] = [], recycled: number[] = [], drawn: number[] = [];
  let next = 1000, disposed = false, suspendCount = 0, resumes = 0, brokenPixels = false, emptyTexture = false, skipOwn = false, disconnect = false;
  let customDraw = false, overlayOwn = false;
  const refs = ["example.Image@aaa", "example.Image@bbb", "example.Image@ccc", "android.view.TextureView@ddd"];
  const args = (data: Buffer, start: number, count: number) => {
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const tag = data[start++];
      values.push(tag === 90 ? data[start] : data.readInt32BE(start)); start += tag === 90 ? 1 : 4;
    }
    return values;
  };
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0), handshaken = false;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!handshaken) {
        if (buffer.length < 14) return;
        socket.write(buffer.subarray(0, 14)); buffer = buffer.subarray(14); handshaken = true;
      }
      while (buffer.length >= 11 && buffer.length >= buffer.readUInt32BE()) {
        const packet = buffer.subarray(0, buffer.readUInt32BE()); buffer = buffer.subarray(packet.length);
        const body = packet.subarray(11), command = `${packet[9]}/${packet[10]}`;
        let payload = Buffer.alloc(0), event = false;
        switch (command) {
          case "1/7": payload = Buffer.concat(Array.from({ length: 5 }, () => int(4))); break;
          case "1/4": payload = Buffer.concat([int(1), int(3)]); break;
          case "11/1": payload = string("main"); break;
          case "11/2": suspendCount++; break;
          case "11/3": resumes++; break;
          case "15/1":
            assert.deepEqual([...body.subarray(0, 2)], [2, 1]);
            assert.equal(body.readInt32BE(2), 2);
            assert.equal(body[6], 3); assert.equal(body.readInt32BE(7), 3);
            assert.equal(body.readInt32BE(13), classes.get("Landroid/os/MessageQueue;"));
            assert.equal(body.readInt32BE(17), 12);
            assert.equal(body.readBigInt64BE(21), 0n);
            payload = int(7); event = true; break;
          case "15/2": break;
          case "199/1": assert.equal(body.subarray(0, 4).toString(), "VUOP"); assert.equal(body.readInt32BE(8), 2); break;
          case "1/2": {
            const name = body.subarray(4).toString();
            assert.notEqual(name, "Landroid/view/ViewDebug$HardwareCanvasProvider;", "load the snapshot provider on cold startup");
            if (!classes.has(name)) classes.set(name, classes.size + 1);
            payload = Buffer.concat([int(1), Buffer.from([1]), int(classes.get(name)!), int(7)]); break;
          }
          case "3/1":
            if (customDraw && body.readInt32BE() === classes.get("Lexample/Image;")) {
              if (!classes.has("Lexample/DecoratedLayout;")) classes.set("Lexample/DecoratedLayout;", classes.size + 1);
              payload = int(classes.get("Lexample/DecoratedLayout;")!); break;
            }
            if (!classes.has("Landroid/view/View;")) classes.set("Landroid/view/View;", classes.size + 1);
            payload = int(classes.get("Landroid/view/View;")!); break;
          case "2/1": payload = string([...classes].find(([, id]) => id === body.readInt32BE())![0]); break;
          case "9/1": {
            const name = body.readInt32BE() === 504 ? "Landroid/view/TextureView;" : "Lexample/Image;";
            if (!classes.has(name)) classes.set(name, classes.size + 1);
            payload = Buffer.concat([Buffer.from([1]), int(classes.get(name)!)]); break;
          }
          case "2/5": {
            const extra = customDraw && body.readInt32BE() === classes.get("Lexample/DecoratedLayout;")
              ? [int(16), string("dispatchDraw"), string("(Landroid/graphics/Canvas;)V"), int(0)] : [];
            payload = Buffer.concat([int(methods.length + Number(extra.length > 0)), ...methods.flatMap(([id, name, sig]) => [int(id), string(name), string(sig), int(0)]), ...extra]); break;
          }
          case "2/4": payload = Buffer.concat([int(2), int(99), string("mPrivateFlags"), string("I"), int(0), int(100), string("mOverlay"), string("Landroid/view/ViewOverlay;"), int(0)]); break;
          case "9/2": {
            const field = body.readInt32BE(8); assert.ok(field === 99 || field === 100);
            payload = Buffer.concat([int(1), field === 99 ? tagged("I", skipOwn ? 0x80 : 0) : tagged("L", overlayOwn ? 900 : 0)]); break;
          }
          case "9/7": pins.push(body.readInt32BE()); break;
          case "9/8": released.push(body.readInt32BE()); break;
          case "17/1": payload = Buffer.concat([Buffer.from([1]), int(body.readInt32BE() - 4000)]); break;
          case "1/11": strings.set(++next, body.subarray(4).toString()); payload = int(next); break;
          case "3/4": payload = result("L", 200); break;
          case "3/3": {
            const method = body.readInt32BE(8), values = args(body, 16, body.readInt32BE(12));
            if (method === 2) {
              assert.equal(values[0], 100, "only search within the identified window");
              const index = refs.indexOf(strings.get(values[1])!);
              payload = result("L", strings.get(values[1]) === "example.DecorView@abc" ? 100 : index < 0 ? 0 : 501 + index);
            } else if (method === 13) payload = result("L", 400);
            else if (method === 15) {
              const signature = `L${strings.get(values[0])!.replace(/\./g, "/")};`;
              if (!classes.has(signature)) classes.set(signature, classes.size + 1);
              payload = result("L", 4000 + classes.get(signature)!);
            }
            else { assert.equal(method, 8); payload = result("L", 300); }
            break;
          }
          case "9/6": {
            const object = body.readInt32BE(), method = body.readInt32BE(12), values = args(body, 20, body.readInt32BE(16));
            switch (method) {
              case 1: payload = result("I", 0xabc); break;
              case 3: case 4: payload = result("I", 1); break;
              case 7:
                if (disconnect) { socket.destroy(); return; }
                assert.deepEqual(values, [200, 1], "snapshot must skip children"); drawn.push(object);
                payload = object === 502 ? result("L", 0, 999) : result("L", object + 100); break;
              case 9: assert.deepEqual(values, [300, 0]); payload = result("L", object + 100); break;
              case 11: payload = result("L", object + 200); break;
              case 14: assert.equal(strings.get(values[0]), "activity-window"); payload = result("L", 100); break;
              case 5: arrays.set(values[0], object); payload = result("V"); break;
              case 10: recycled.push(object); payload = result("V"); break;
              default: assert.fail(`unknown method ${method}`);
            }
            break;
          }
          case "4/1": payload = tagged("[", ++next); break;
          case "13/2": payload = Buffer.concat([Buffer.from("I"), int(1), Buffer.from([emptyTexture && arrays.get(body.readInt32BE()) === 704 ? 0 : 1, arrays.get(body.readInt32BE())! - 700, 0, 0]).subarray(0, brokenPixels ? 3 : 4)]); break;
          case "1/6": disposed = true; break;
          default: assert.fail(`unexpected command ${command}`);
        }
        const header = Buffer.alloc(11); header.writeUInt32BE(11 + payload.length); packet.copy(header, 4, 4, 8); header[8] = 0x80;
        socket.write(Buffer.concat([header, payload]));
        if (event) {
          const eventData = Buffer.concat([Buffer.from([1]), int(1), Buffer.from([2]), int(7), int(3)]);
          const header = Buffer.alloc(11); header.writeUInt32BE(11 + eventData.length); header[9] = 64; header[10] = 100;
          socket.write(Buffer.concat([header, eventData]));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const captured = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, refs.map((ref) => ({ ref, captureOwn: true })), AbortSignal.timeout(5000));
    assert.deepEqual(drawn, [501, 502, 503]);
    assert.deepEqual([...captured.images.keys()], [refs[3], refs[0], refs[2]], "prioritize video buffers before the bounded own-view fallback");
    assert.match(captured.failures.get(refs[1])!, /exception/);
    for (const [ref, image] of captured.images) {
      const png = Buffer.from(image.pngDataUrl.split(",")[1], "base64");
      const pixels = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
      assert.deepEqual([...pixels], [0, refs.indexOf(ref) + 1, 0, 0, 1], "pixels and faint alpha stay with their object, even for same-name views");
    }
    assert.equal(suspendCount, 0, "never forcibly interrupt a draw/layout operation");
    assert.equal(disposed, true);
    assert.deepEqual(released.sort(), pins.sort());
    assert.deepEqual(recycled.sort(), [601, 701, 603, 703, 704].sort());
    const extraRefs = Array.from({ length: 70 }, (_, i) => `example.Image@${(0x1000 + i).toString(16)}`);
    refs.push(...extraRefs);
    const batch = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, extraRefs.map(ref => ({ ref, captureOwn: true })), AbortSignal.timeout(5000));
    assert.equal(batch.images.size, 64);
    assert.equal(batch.failures.size, 6, "the bounded fallback explicitly reports every omitted image");
    assert.equal(resumes, 0, "dispose releases the single safe pause");
    brokenPixels = true;
    const broken = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: true }], AbortSignal.timeout(5000));
    assert.equal(broken.images.size, 0);
    assert.match(broken.failures.get(refs[0])!, /像素不完整/);
    assert.deepEqual(released.sort(), pins.sort());
    const capturedObjects = [...drawn];
    disposed = false;
    await assert.rejects(captureViewBitmaps(address.port, { rootRef: "example.DecorView@stale", windowName: "activity-window" }, [], AbortSignal.timeout(5000)), /窗口身份已变化/);
    assert.equal(disposed, true);
    assert.deepEqual(drawn, capturedObjects, "a stale window never captures another view's pixels");
    assert.deepEqual(released.sort(), pins.sort());
    brokenPixels = false; emptyTexture = true; skipOwn = true;
    const empty = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: true }, { ref: refs[3], captureOwn: false }]);
    assert.equal(empty.images.size, 0, "a transparent video buffer is not a successful capture");
    assert.match(empty.failures.get(refs[3])!, /未确认取得视频画面/);
    assert.equal(empty.kinds.get(refs[3]), "texture", "probe video buffers even when DDMS already supplied a bitmap");
    assert.equal(empty.skipDraw.has(refs[0]), true);
    assert.deepEqual(drawn, capturedObjects, "skip-draw containers should not consume the capture budget");
    customDraw = true;
    const decorated = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [refs[0], refs[2]].map(ref => ({ ref, captureOwn: true })));
    assert.deepEqual([...decorated.images.keys()], [refs[0], refs[2]], "inherited dispatchDraw pixels survive SKIP_DRAW, including cached types");
    assert.equal(decorated.skipDraw.size, 0);
    customDraw = false; overlayOwn = true;
    const overlay = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: true }]);
    assert.equal(overlay.images.has(refs[0]), true, "an overlay must be captured even without an own background");
    assert.equal(overlay.skipDraw.size, 0);
    overlayOwn = false;
    emptyTexture = false; skipOwn = false; disconnect = true;
    const partial = await captureViewBitmaps(address.port, { rootRef: "example.DecorView@abc", windowName: "activity-window" }, [{ ref: refs[0], captureOwn: true }, { ref: refs[3], captureOwn: false }]);
    assert.deepEqual([...partial.images.keys()], [refs[3]], "disconnect must preserve already captured video pixels");
    assert.match(partial.failures.get(refs[0])!, /提前关闭/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

for (const legacy of [false, true]) test(`Surface capture isolates the actual buffer and respects protection (${legacy ? "PixelCopy backend" : "Android 14 backend"})`, async () => {
  const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const string = (s: string) => Buffer.concat([int(Buffer.byteLength(s)), Buffer.from(s)]);
  const tagged = (tag: string, n: number) => {
    const value = tag === "Z" ? Buffer.from([n]) : tag === "J" ? Buffer.alloc(8) : int(n);
    if (tag === "J") value.writeBigInt64BE(BigInt(n));
    return Buffer.concat([Buffer.from(tag), value]);
  };
  const result = (tag: string, n = 0) => Buffer.concat([tag === "V" ? Buffer.from(tag) : tagged(tag, n), tagged("L", 0)]);
  const definitions = [
    ["next", "()Landroid/os/Message;"], ["findView", "(Landroid/view/View;Ljava/lang/String;)Landroid/view/View;"],
    ["getWidth", "()I"], ["getHeight", "()I"], ["getPixels", "([IIIIIII)V"], ["recycle", "()V"],
    ["getInstance", "()Landroid/view/WindowManagerGlobal;"], ["getRootView", "(Ljava/lang/String;)Landroid/view/View;"],
    ["valueOf", "(Ljava/lang/String;)Landroid/graphics/Bitmap$Config;"], ["copy", "(Landroid/graphics/Bitmap$Config;Z)Landroid/graphics/Bitmap;"],
    ["getLayoutParams", "()Landroid/view/ViewGroup$LayoutParams;"], ["isValid", "()Z"],
    ["forName", "(Ljava/lang/String;)Ljava/lang/Class;"], ["createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;"],
    ["<init>", "(Landroid/view/SurfaceControl;)V"], ["<init>", "(IIII)V"], ["myUid", "()I"],
    ["setUid", "(J)Landroid/window/ScreenCapture$CaptureArgs$Builder;"],
    ["setCaptureSecureLayers", "(Z)Landroid/window/ScreenCapture$CaptureArgs$Builder;"],
    ["setAllowProtected", "(Z)Landroid/window/ScreenCapture$CaptureArgs$Builder;"],
    ["setChildrenOnly", "(Z)Landroid/window/ScreenCapture$LayerCaptureArgs$Builder;"],
    ["setSourceCrop", "(Landroid/graphics/Rect;)Landroid/window/ScreenCapture$CaptureArgs$Builder;"],
    ["setFrameScale", "(FF)Landroid/window/ScreenCapture$CaptureArgs$Builder;"],
    ["build", "()Landroid/window/ScreenCapture$LayerCaptureArgs;"],
    ["captureLayers", "(Landroid/window/ScreenCapture$LayerCaptureArgs;)Landroid/window/ScreenCapture$ScreenshotHardwareBuffer;"],
    ["getHardwareBuffer", "()Landroid/hardware/HardwareBuffer;"], ["containsSecureLayers", "()Z"],
    ["asBitmap", "()Landroid/graphics/Bitmap;"], ["close", "()V"], ["getBitmap", "()Landroid/graphics/Bitmap;"],
    ...(legacy ? [["copySurfaceInto", "(Landroid/view/Surface;Landroid/graphics/Rect;Landroid/graphics/Bitmap;)I"]] : []),
  ];
  const fields = [["mSurfaceFlags", "I"], ["flags", "I"], ["mSurface", "Landroid/view/Surface;"], ["mSurfacePackage", "Landroid/view/SurfaceControlViewHost$SurfacePackage;"], ["mBlastSurfaceControl", "Landroid/view/SurfaceControl;"], ["mSurfaceWidth", "I"], ["mSurfaceHeight", "I"]];
  const refs = ["example.Video@a", "example.Video@b", "example.Video@c", "example.Video@d", "example.Video@e", "example.LivePlayTextureView@f", "example.CanvasHost@g"];
  const classes = new Map<string, number>(), strings = new Map<number, string>(), objects = new Map<number, number>();
  const pins: number[] = [], released: number[] = [], recycled: number[] = [], closed: number[] = [], copied: number[] = [];
  const classId = (name: string) => { if (!classes.has(name)) classes.set(name, classes.size + 1); return classes.get(name)!; };
  const className = (id: number) => [...classes].find(([, value]) => value === id)![0];
  let next = 10000, secureWindow = false, disposed = 0;
  const args = (data: Buffer, start: number, count: number) => {
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const tag = data[start++];
      values.push(tag === 90 ? data[start] : tag === 74 ? Number(data.readBigInt64BE(start)) : tag === 70 ? data.readFloatBE(start) : data.readInt32BE(start));
      start += tag === 90 ? 1 : tag === 74 ? 8 : 4;
    }
    return values;
  };
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0), handshaken = false;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!handshaken) {
        if (buffer.length < 14) return;
        socket.write(buffer.subarray(0, 14)); buffer = buffer.subarray(14); handshaken = true;
      }
      while (buffer.length >= 11 && buffer.length >= buffer.readUInt32BE()) {
        const packet = buffer.subarray(0, buffer.readUInt32BE()); buffer = buffer.subarray(packet.length);
        const body = packet.subarray(11), command = `${packet[9]}/${packet[10]}`;
        let payload = Buffer.alloc(0), event = false;
        switch (command) {
          case "1/7": payload = Buffer.concat(Array.from({ length: 5 }, () => int(4))); break;
          case "1/2": payload = Buffer.concat([int(1), Buffer.from([1]), int(classId(body.subarray(4).toString())), int(7)]); break;
          case "3/1": {
            const name = className(body.readInt32BE());
            payload = int(classId(name === "Lexample/Video;" ? "Landroid/opengl/GLSurfaceView;" : name === "Landroid/opengl/GLSurfaceView;" ? "Landroid/view/SurfaceView;" : name === "Lexample/CanvasHost;" ? "Landroid/view/TextureView;" : "Landroid/view/View;")); break;
          }
          case "2/1": payload = string(className(body.readInt32BE())); break;
          case "9/1": payload = Buffer.concat([Buffer.from([1]), int(classId(body.readInt32BE() === 506 ? "Lexample/LivePlayTextureView;" : body.readInt32BE() === 507 ? "Lexample/CanvasHost;" : "Lexample/Video;"))]); break;
          case "2/4": case "2/5": {
            const entries = command === "2/4" ? fields : definitions;
            payload = Buffer.concat([int(entries.length), ...entries.flatMap(([name, sig], i) => [int(i + 1), string(name), string(sig), int(0)])]); break;
          }
          case "1/4": payload = Buffer.concat([int(1), int(3)]); break;
          case "11/1": payload = string("main"); break;
          case "15/1": payload = int(7); break;
          case "15/2": break;
          case "199/1":
            assert.equal(body.subarray(0, 4).toString(), "VUOP");
            assert.equal(body.readInt32BE(8), 2, "wake idle UI with a non-blocking read, not invoke or layout mutation");
            event = true; break;
          case "1/11": strings.set(++next, body.subarray(4).toString()); payload = int(next); break;
          case "9/7": pins.push(body.readInt32BE()); break;
          case "9/8": released.push(body.readInt32BE()); break;
          case "17/1": payload = Buffer.concat([Buffer.from([1]), int(body.readInt32BE() - 9000)]); break;
          case "9/2": {
            const object = body.readInt32BE(), [name, signature] = fields[body.readInt32BE(8) - 1];
            const value = name === "mSurfaceFlags" ? (object === 504 ? 0x80 : 0) : name === "flags" ? (secureWindow ? 0x2000 : 0) : name === "mSurface" ? object + 2000 : name === "mBlastSurfaceControl" ? object + 1000 : name === "mSurfacePackage" ? 0 : 2;
            payload = Buffer.concat([int(1), tagged(signature[0], value)]); break;
          }
          case "3/3": case "3/4": case "9/6": {
            const instance = command === "9/6", object = instance ? body.readInt32BE() : 0;
            const [name, signature] = definitions[body.readInt32BE(instance ? 12 : 8) - 1];
            const values = args(body, instance ? 20 : 16, body.readInt32BE(instance ? 16 : 12));
            let value = 0, tag = "L";
            switch (name) {
              case "findView": assert.equal(values[0], 100); value = strings.get(values[1]) === "example.Root@1" ? 100 : 501 + refs.indexOf(strings.get(values[1])!); break;
              case "getInstance": value = 101; break;
              case "getRootView": assert.equal(strings.get(values[0]), "window"); value = 100; break;
              case "valueOf": value = 300; break;
              case "getLayoutParams": assert.equal(object, 100); value = 102; break;
              case "isValid": tag = "Z"; value = object === 2503 ? 0 : 1; break;
              case "getWidth": case "getHeight": tag = "I"; value = 1; break;
              case "forName": value = 9000 + classId(`L${strings.get(values[0])!.replace(/\./g, "/")};`); break;
              case "<init>":
                value = ++next;
                if (signature.includes("SurfaceControl")) { assert.ok([1501, 1502, 1505].includes(values[0])); objects.set(value, values[0] - 1000); }
                else assert.deepEqual(values, [0, 0, 2, 2]);
                break;
              case "myUid": tag = "I"; value = 10329; break;
              case "setUid": assert.deepEqual(values, [10329]); value = object; break;
              case "setCaptureSecureLayers": case "setAllowProtected": case "setChildrenOnly": assert.deepEqual(values, [0]); value = object; break;
              case "setFrameScale": assert.ok(values.every((value) => Math.abs(value - 0.505) < 0.0001)); value = object; break;
              case "setSourceCrop": value = object; break;
              case "build": value = object; break;
              case "captureLayers": { const owner = objects.get(values[0])!; copied.push(owner); value = owner === 505 || owner === 502 ? 0 : owner + 3000; break; }
              case "getHardwareBuffer": value = object + 1000; break;
              case "containsSecureLayers": tag = "Z"; break;
              case "asBitmap": value = object + 2000; break;
              case "copy": assert.deepEqual(values, [300, 0]); value = object + 1000; break;
              case "createBitmap": assert.deepEqual(values, [1, 1, 300]); value = ++next; break;
              case "copySurfaceInto":
                assert.equal(values[1], 0, "copy the source Surface, never a window crop");
                objects.set(values[2], values[0] - 2000); copied.push(values[0] - 2000);
                tag = "I"; value = values[0] === 2505 ? 4 : values[0] === 2502 ? 3 : 0; break;
              case "getBitmap": value = object + 6000; break;
              case "getPixels": objects.set(values[0], legacy && objects.has(object) ? objects.get(object)! : object - 6000); tag = "V"; break;
              case "recycle": recycled.push(object); tag = "V"; break;
              case "close": closed.push(object); tag = "V"; break;
              default: assert.fail(`Unexpected method ${name}`);
            }
            payload = result(tag, value); break;
          }
          case "4/1": payload = tagged("[", ++next); break;
          case "13/2": payload = Buffer.concat([Buffer.from("I"), int(1), Buffer.from([255, objects.get(body.readInt32BE())! - 500, 23, 42])]); break;
          case "1/6": disposed++; break;
          default: assert.fail(`Unexpected command ${command}`);
        }
        const header = Buffer.alloc(11); header.writeUInt32BE(11 + payload.length); packet.copy(header, 4, 4, 8); header[8] = 0x80;
        socket.write(Buffer.concat([header, payload]));
        if (event) {
          const payload = Buffer.concat([Buffer.from([1]), int(1), Buffer.from([2]), int(7), int(3)]);
          const header = Buffer.alloc(11); header.writeUInt32BE(11 + payload.length); header[9] = 64; header[10] = 100;
          socket.write(Buffer.concat([header, payload]));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const capture = (refs: string[]) => captureViewBitmaps(address.port, { rootRef: "example.Root@1", windowName: "window" }, refs.map((ref) => ({ ref, captureOwn: false })), AbortSignal.timeout(5000));
    const captured = await capture(refs);
    assert.deepEqual([...captured.images.keys()], [refs[0], refs[6]]);
    assert.equal(captured.kinds.get(refs[0]), "surface", "custom GLSurfaceView subclass is recognized");
    assert.equal(captured.kinds.get(refs[5]), "own", "a name containing TextureView is not a TextureView");
    assert.equal(captured.kinds.get(refs[6]), "texture", "custom TextureView subclass is recognized");
    assert.match(captured.failures.get(refs[1])!, legacy ? /尚未提交/ : /无画面/);
    assert.match(captured.failures.get(refs[2])!, /已经销毁/);
    assert.match(captured.failures.get(refs[3])!, /保护/);
    assert.match(captured.failures.get(refs[4])!, /保护/);
    for (const [ref, image] of captured.images) {
      const png = Buffer.from(image.pngDataUrl.split(",")[1], "base64");
      assert.deepEqual([...inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))], [0, refs.indexOf(ref) + 1, 23, 42, 255]);
    }
    assert.deepEqual(copied, [501, 502, 505], "invalid/secure surfaces never reach the copy API; frame availability is checked by the copy backend");
    assert.deepEqual(closed, legacy ? [] : [4501]);
    assert.equal(recycled.length, legacy ? 4 : 3);
    assert.deepEqual(released.sort(), pins.sort());
    secureWindow = true;
    const blocked = await capture([refs[0]]);
    assert.equal(blocked.images.size, 0);
    assert.match(blocked.failures.get(refs[0])!, /FLAG_SECURE/);
    assert.deepEqual(copied, [501, 502, 505]);
    assert.equal(disposed, 2);
    assert.deepEqual(released.sort(), pins.sort());
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

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
    await assert.rejects(captureViewBitmaps(address.port, { rootRef: "DecorView@a", windowName: "activity-window" }, [{ ref: "TextureView@123", captureOwn: true }]), /JDWP 1\/7/);
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

test("same-name/same-bounds layers are ambiguous, but an explicit view identity is unique", () => {
  const a = { ...makeNode("0/0"), resourceId: null, attributes: { "view-ref": "ViewGroup@a" } };
  const b = { ...makeNode("0/1"), resourceId: null, attributes: { "view-ref": "ViewGroup@b" } };
  const root = { ...makeNode("0"), children: [a, b] };
  const layer = { name: "ViewGroup", visible: true, x: 0, y: 0, width: 360, height: 48, pngDataUrl: "data:image/png;base64,AA==" };
  assert.equal(attachViewLayerImages(root, [layer]), 0);
  assert.equal(root.children[0].layerImageStatus, "ambiguous");
  assert.equal(root.children[1].layerImageDataUrl, undefined);
  assert.equal(attachViewLayerImages(root, [{ ...layer, viewRef: "ViewGroup@b" }]), 1);
  assert.equal(root.children[1].layerImageStatus, "captured");
  assert.equal(root.children[0].layerImageStatus, "unavailable");
});

test("duplicate bitmap records do not silently attach the first image", () => {
  const child: UiNode = { ...makeNode("0/0"), resourceId: null };
  const root = { ...makeNode("0"), children: [child] };
  const layer = { name: "ViewGroup", visible: true, x: 0, y: 0, width: 360, height: 48, pngDataUrl: "data:image/png;base64,AA==" };
  assert.equal(attachViewLayerImages(root, [layer, { ...layer, pngDataUrl: "other" }]), 0);
  assert.equal(child.layerImageStatus, "ambiguous");
  assert.equal(child.layerImageDataUrl, undefined);
});

test("skip-draw containers do not compete with anonymous drawable images, but retain explicit identity", () => {
  const child: UiNode = { ...makeNode("0/0/0"), resourceId: null, attributes: { "view-ref": "ViewGroup@b", "skip-draw": "false" } };
  const parent: UiNode = { ...makeNode("0/0"), resourceId: null, attributes: { "view-ref": "ViewGroup@a", "skip-draw": "true" }, children: [child], layerImageEmpty: true };
  const root = { ...makeNode("0"), children: [parent] };
  const layer = { name: "ViewGroup", visible: true, x: 0, y: 0, width: 360, height: 48, pngDataUrl: "child-own-image" };
  assert.equal(attachViewLayerImages(root, [layer]), 1);
  assert.equal(parent.layerImageStatus, "unavailable");
  assert.equal(parent.layerImageDataUrl, undefined);
  assert.equal(parent.layerImageEmpty, undefined, "new capture clears stale transparency");
  assert.equal(child.layerImageDataUrl, "child-own-image");
  assert.equal(attachViewLayerImages(root, [{ ...layer, viewRef: "ViewGroup@a" }]), 1);
  assert.equal(parent.layerImageStatus, "captured");
  delete parent.attributes!["skip-draw"];
  assert.equal(attachViewLayerImages(root, [layer]), 0, "an unknown draw flag must not hide genuine ambiguity");
  assert.equal(child.layerImageStatus, "ambiguous");
});

test("exported native z, clipping and padding are preserved without inventing missing values", () => {
  const root: UiNode = { ...makeNode("root"), attributes: { "view-ref": "View@a" } };
  const values = { "drawing:getZ()": "7.5", "drawing:getElevation()": "5", "drawing:getClipChildren()": "true", "drawing:getClipToPadding()": "false", "padding:mPaddingLeft": "12" };
  applyViewProperties(root, `View@a ${Object.entries(values).map(([k, v]) => `${k}=${v.length},${v}`).join(" ")} `);
  assert.equal(root.attributes?.["z"], "7.5");
  assert.equal(root.attributes?.["clip-children"], "true");
  assert.equal(root.attributes?.["padding-left"], "12");
  assert.equal(root.attributes?.["padding-right"], undefined);
});

test("Debug capture chooses the window whose root identity matches, not the first window", async () => {
  const captured: string[] = [];
  let layerRequests = 0;
  let duplicateRoot = false, changedRoot = false, truncate = false, incomplete = false;
  const padding = "hello world ".repeat(1024);
  const int = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const utf16 = (s: string) => Buffer.from(s, "utf16le").swap16();
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0), handshaken = false;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!handshaken) {
        if (buffer.length < 14) return;
        socket.write(buffer.subarray(0, 14)); buffer = buffer.subarray(14); handshaken = true;
      }
      while (buffer.length >= 11 && buffer.length >= buffer.readUInt32BE()) {
        const packet = buffer.subarray(0, buffer.readUInt32BE()); buffer = buffer.subarray(packet.length);
        const type = packet.subarray(11, 15).toString();
        let data: Buffer;
        if (type === "VULW") data = Buffer.concat([int(2), ...["dialog", "activity"].flatMap((name) => [int(name.length), utf16(name)])]);
        else {
          const operation = packet.readUInt32BE(19), length = packet.readUInt32BE(23);
          const name = Buffer.from(packet.subarray(27, 27 + length * 2)).swap16().toString("utf16le");
          if (operation === 2) {
            layerRequests++;
            assert.equal(name, "activity", "capture only the matching window");
            data = Buffer.concat([Buffer.alloc(8), Buffer.from([2])]);
          } else {
          assert.equal(operation, 1);
          const flags = packet.subarray(27 + length * 2);
          if (flags.readUInt32BE(0) === 0) {
            assert.equal(flags.readUInt32BE(4), 1);
            assert.equal(flags.readUInt32BE(8), 1, "never use reflection for full properties after JDWP attach");
            captured.push(name);
          } else assert.equal(flags.readUInt32BE(4), 0, "identity probes need no properties");
          const full = flags.readUInt32BE(0) === 0;
          const hash = name === "activity" || duplicateRoot ? full && changedRoot ? -559038737 : 0x9c5dabe : 0x1b9116c;
          data = full ? encodedHierarchy(encodedView(hash, { "meta:__name__": "com.android.internal.policy.DecorView", "text:text": padding }), !incomplete) : Buffer.from(`com.android.internal.policy.DecorView@${(hash >>> 0).toString(16)} properties\n\nDONE.\n`);
          }
        }
        const payload = Buffer.concat([Buffer.from(type), int(data.length), data]);
        const reply = Buffer.alloc(11); reply.writeUInt32BE(11 + payload.length); packet.copy(reply, 4, 4, 8); reply[8] = 0x80;
        const response = Buffer.concat([reply, payload]);
        // Split headers and large payloads; include an empty unsolicited packet
        // to exercise zero-length reads and buffered leftovers between packets.
        const event = Buffer.alloc(11); event.writeUInt32BE(11);
        socket.write(event);
        socket.write(response.subarray(0, 3));
        let offset = 3;
        const send = () => {
          if (socket.destroyed) return;
          if (truncate && response.length > 1000) { socket.end(response.subarray(offset, offset + 16)); return; }
          if (offset >= response.length) return;
          socket.write(response.subarray(offset, offset + 16_384)); offset += 16_384;
          setImmediate(send);
        };
        send();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    let dump = "";
    const root = debugViewTree(activityHierarchy, activityTarget);
    const rootRefs = root.children.map((node) => node.attributes!["view-ref"]);
    let batchTiming: { waitMs: number; readMs: number; parseMs: number; bytes: number; layers: number } | undefined;
    assert.deepEqual(await captureViewLayers(address.port, { rootRefs, onHierarchy: (value) => { dump = value; }, onBatchTiming: (timing) => { batchTiming = timing; } }), []);
    assert.equal(batchTiming?.bytes, 9);
    assert.equal(batchTiming?.layers, 0);
    assert.ok(batchTiming && batchTiming.waitMs >= 0 && batchTiming.readMs >= 0 && batchTiming.parseMs >= 0);
    assert.deepEqual(captured, ["activity"]);
    assert.match(dump, /^com\.android\.internal\.policy\.DecorView@9c5dabe/);
    assert.ok(dump.includes(`text:mText=${padding.length},${padding}`), "fragmented replies must retain all properties");
    assert.deepEqual(await captureViewLayers(address.port, { rootRefs, onHierarchy: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(layerRequests, 1, "bulk capture started before the early preview finished");
    } }), []);
    assert.equal(layerRequests, 2);
    assert.deepEqual(await captureViewLayers(address.port, { rootRefs, skipImages: true, onHierarchy: () => undefined }), []);
    assert.equal(layerRequests, 2, "single-view refresh must not launch the bulk DDMS image capture");
    await assert.rejects(captureViewLayers(address.port, { rootRefs: ["stale"], onHierarchy: () => assert.fail("wrong window properties") }), /窗口与当前控件树不一致/);
    assert.deepEqual(captured, ["activity", "activity", "activity"]);
    duplicateRoot = false;
    changedRoot = true;
    await assert.rejects(captureViewLayers(address.port, { rootRefs, onHierarchy: () => assert.fail("stale full hierarchy") }), /身份已变化/);
    changedRoot = false;
    truncate = true;
    await assert.rejects(captureViewLayers(address.port, { rootRefs, onHierarchy: () => assert.fail("truncated hierarchy") }), /提前关闭/);
    truncate = false;
    incomplete = true;
    await assert.rejects(captureViewLayers(address.port, { rootRefs, onHierarchy: () => assert.fail("unfinished Android export") }), /Debug V2/);
    duplicateRoot = true;
    await assert.rejects(captureViewLayers(address.port, { rootRefs, onHierarchy: () => assert.fail("ambiguous window properties") }), /多个 Debug 窗口匹配/);
    assert.deepEqual(captured, Array(6).fill("activity"));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("cancel closes stalled native and QML connections promptly", async () => {
  for (const capture of [
    (port: number, signal: AbortSignal) => captureViewLayers(port, { rootRefs: ["DecorView@a"], onHierarchy: () => undefined, signal }),
    (port: number, signal: AbortSignal) => captureViewBitmaps(port, { rootRef: "DecorView@a", windowName: "activity-window" }, [], signal),
    (port: number, signal: AbortSignal) => inspectQmlHierarchy(port, signal),
  ]) {
    const controller = new AbortController();
    const server = createServer((socket) => { socket.on("data", () => controller.abort()); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const address = server.address(); assert.ok(address && typeof address !== "string");
      await assert.rejects(capture(address.port, controller.signal));
    } finally { clearTimeout(timeout); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test("next debugger handshake survives an earlier canceled layer capture", { timeout: 10_000 }, async () => {
  const server = createServer((socket) => {
    socket.once("data", (handshake) => {
      setTimeout(() => {
        if (socket.destroyed) return;
        socket.write(handshake);
        socket.once("data", (request) => {
          const payload = Buffer.from([86, 85, 76, 87, 0, 0, 0, 4, 0, 0, 0, 0]);
          const reply = Buffer.alloc(11);
          reply.writeUInt32BE(11 + payload.length);
          request.copy(reply, 4, 4, 8);
          reply[8] = 0x80;
          socket.end(Buffer.concat([reply, payload]));
        });
      }, 5_200);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await assert.rejects(captureViewLayers(address.port, { rootRefs: ["DecorView@a"], onHierarchy: () => undefined, signal: AbortSignal.timeout(8_000) }), /窗口与当前控件树不一致/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

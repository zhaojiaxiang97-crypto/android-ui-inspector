import { crc32, deflate } from "node:zlib";
import { promisify } from "node:util";
import { connectJdwp as connect } from "./jdwp-transport";
import { createJdwpViewSession } from "./jdwp-view-session";

const compress = promisify(deflate);

// Reuse Android's own snapshot implementation with skipChildren=true. A normal
// DDMS CAPTURE_VIEW includes descendants and is not an independent layer.
export async function captureViewBitmaps(port: number, target: { rootRef: string; windowName: string; wakeUi?: () => Promise<void>; hardwareAccelerated?: boolean; metadataBatch?: boolean }, views: readonly { ref: string; captureOwn: boolean }[], signal?: AbortSignal) {
  const started = performance.now();
  const deadline = AbortSignal.timeout(15_000);
  const { socket, reader } = await connect(port, signal ? AbortSignal.any([signal, deadline]) : deadline);
  const connectedAt = performance.now();
  type Kind = "own" | "texture" | "surface";
  const results = new Map<string, { width: number; height: number; imageDataUrl: string; kind: Kind; empty: boolean }>();
  const failures = new Map<string, string>();
  const kinds = new Map<string, Kind>();
  const skipDraw = new Set<string>();
  const timing = { setupMs: 0, connectMs: connectedAt - started, idsMs: 0, threadLookupMs: 0, boundaryMs: 0,
    metadataMs: 0, rootVerifyMs: 0, threadNameRequests: 0, setupRequests: 0,
    lookupMs: 0, lookupRefMs: 0, lookupTypeMs: 0, lookupDrawMs: 0, lookupReleaseMs: 0,
    bitmapSetupMs: 0, bitmapSetupRequests: 0,
    captureMs: 0, snapshotMs: 0, pixelsMs: 0, compressMs: 0, requested: 0, skipped: 0, fieldReadRequests: 0, batchedFieldReads: 0 };
  let phase = "连接调试窗口";
  let setupComplete = false;
  let preparingBitmap = false;
  const measureLookup = async <T>(key: "lookupRefMs" | "lookupTypeMs" | "lookupDrawMs" | "lookupReleaseMs", action: () => Promise<T>) => {
    const at = performance.now();
    try { return await action(); } finally { timing[key] += performance.now() - at; }
  };
  const session = createJdwpViewSession(socket, reader, {
    timing,
    onRequests: count => { if (!setupComplete) timing.setupRequests += count; if (preparingBitmap) timing.bitmapSetupRequests += count; },
    onFieldRead: count => { timing.fieldReadRequests++; if (count > 1) timing.batchedFieldReads++; },
    onPhase: value => { phase = value; },
  });
  try {
    const { objectSize, classSize, classes, resolveClass, classFor, membersFor, methodFor, mainThread, command,
      metadataBatch, pinned, pin, int, string, objectArg, integerArg, resultValue, invoke, invokeStatic, fieldValues,
      fieldValue, loadClass, viewClass, debugClass, findMethod, rootObject } = await session.prepare(target, views[0]?.ref);
    phase = "读取独立位图";
    // Read the already-resolved object's real type instead of repeatedly scanning
    // ART's class loaders by name. Cache by class ID, not an ambiguous class name.
    const typeKinds = new Map<string, { kind: Kind; drawClasses: Buffer[]; customDraw?: boolean }>();
    const kindFor = async (object: Buffer, inspectDraw: boolean) => {
      const type = await command(9, 1, object);
      if (type.length !== 1 + classSize || type[0] !== 1) throw new Error("Invalid View reference type");
      let id = type.subarray(1);
      const path: Buffer[] = [];
      let kind: Kind = "own";
      while (!typeKinds.has(id.toString("hex"))) {
        if (path.length >= 64 || path.some(parent => parent.equals(id))) throw new Error("Invalid View superclass chain");
        path.push(id);
        const data = await command(2, 1, id);
        if (data.length < 4 || data.readUInt32BE(0) !== data.length - 4) throw new Error("Invalid JDWP class signature");
        const signature = data.subarray(4).toString();
        if (["Landroid/view/SurfaceView;", "Landroid/view/TextureView;", "Landroid/view/ViewGroup;", "Landroid/view/View;"].includes(signature)) {
          kind = signature === "Landroid/view/SurfaceView;" ? "surface" : signature === "Landroid/view/TextureView;" ? "texture" : "own";
          classes.set(signature, id);
          break;
        }
        const parent = await command(3, 1, id);
        if (parent.length !== classSize) throw new Error("Invalid JDWP superclass");
        if (parent.every((byte) => byte === 0)) throw new Error("Object is not an Android View");
        id = parent;
      }
      let result = typeKinds.get(id.toString("hex")) ?? { kind, drawClasses: [], customDraw: false };
      for (const klass of path.reverse()) {
        // Framework endpoints own no custom dispatchDraw override. Keep the
        // inheritance chain so a later missing bitmap can inspect it lazily.
        result = { kind: result.kind, drawClasses: klass.equals(id) ? result.drawClasses : [klass, ...result.drawClasses] };
        typeKinds.set(klass.toString("hex"), result);
      }
      if (inspectDraw && result.kind === "own" && result.customDraw === undefined) {
        let customDraw = false;
        // SKIP_DRAW bypasses onDraw, not inherited dispatchDraw decorations.
        for (const klass of result.drawClasses) {
          if ((await membersFor(klass)).has("dispatchDraw:(Landroid/graphics/Canvas;)V")) {
            customDraw = true;
            break;
          }
        }
        result.customDraw = customDraw;
      }
      return { kind: result.kind, customDraw: result.customDraw ?? false };
    };
    timing.setupMs = Math.round(performance.now() - started);
    setupComplete = true;
    const lookupStarted = performance.now();
    const requested: { ref: string; kind: Kind; object: Buffer }[] = [];
    for (const view of views) {
      let name: Buffer | undefined, object: Buffer | undefined;
      try {
        object = await measureLookup("lookupRefMs", async () => {
          name = await pin(await command(1, 11, string(view.ref)));
          const found = await invokeStatic(debugClass, findMethod, [objectArg(rootObject), objectArg(name)]);
          if (found.every(byte => byte === 0)) throw new Error("控件已不在当前窗口，请重新采集");
          return pin(found);
        });
        const foundObject = object;
        const { kind, customDraw } = await measureLookup("lookupTypeMs", () => kindFor(foundObject, view.captureOwn));
        kinds.set(view.ref, kind);
        if (kind === "own" && view.captureOwn) {
          // One object-local read while stopped at the same UI message boundary.
          // Keep the old behavior when an Android version lacks mOverlay.
          const empty = await measureLookup("lookupDrawMs", async () => {
            const hasOverlay = (await membersFor(viewClass, true)).has("mOverlay:Landroid/view/ViewOverlay;");
            const [flags, batchedOverlay] = await fieldValues(foundObject, viewClass, hasOverlay
              ? [["mPrivateFlags", "I"], ["mOverlay", "Landroid/view/ViewOverlay;"]]
              : [["mPrivateFlags", "I"]]);
            if ((flags.readInt32BE() & 0x80) === 0) return false;
            // A non-null overlay is conservatively captured, even if empty.
            const overlay = batchedOverlay ?? await fieldValue(foundObject, viewClass, "mOverlay", "Landroid/view/ViewOverlay;");
            return !customDraw && overlay.every(byte => byte === 0);
          });
          if (empty) {
            skipDraw.add(view.ref);
            continue;
          }
        }
        if (view.captureOwn || kind !== "own") {
          requested.push({ ref: view.ref, kind, object });
          object = undefined; // Keep drawable objects pinned through capture.
        }
      } catch (error) {
        if (socket.destroyed) throw error;
        failures.set(view.ref, error instanceof Error ? error.message : "无法识别控件类型");
      } finally {
        await measureLookup("lookupReleaseMs", async () => {
          for (const value of [name, object]) if (value && !socket.destroyed) {
            await command(9, 8, value).catch(() => undefined);
            pinned.delete(value);
          }
        });
      }
    }
    timing.lookupMs = Math.round(performance.now() - lookupStarted);
    timing.requested = requested.length;
    timing.skipped = skipDraw.size;
    // Type-only checks and empty containers need no bitmap classes or pixel methods.
    // Return through finally so even this path releases pins and the UI suspension.
    signal?.throwIfAborted();
    if (!requested.length) return { images: results, failures, kinds, skipDraw, timing };
    const { bitmapClass, arrayClass, widthMethod, heightMethod, pixelsMethod, recycleMethod } = await (async () => {
      const at = performance.now();
      preparingBitmap = true;
      try {
        const bitmapSignatures = ["Landroid/graphics/Bitmap;", "[I"].filter(signature => !classes.has(signature));
        if (target.metadataBatch === true && bitmapSignatures.length) {
          const replies = await metadataBatch(1, 2, bitmapSignatures.map(string));
          for (let i = 0; i < bitmapSignatures.length; i++) await resolveClass(bitmapSignatures[i], replies[i]);
        }
        const bitmapClass = await classFor("Landroid/graphics/Bitmap;");
        const arrayClass = await classFor("[I");
        const widthMethod = await methodFor(bitmapClass, "getWidth", "()I");
        const heightMethod = await methodFor(bitmapClass, "getHeight", "()I");
        const pixelsMethod = await methodFor(bitmapClass, "getPixels", "([IIIIIII)V");
        const recycleMethod = await methodFor(bitmapClass, "recycle", "()V");
        return { bitmapClass, arrayClass, widthMethod, heightMethod, pixelsMethod, recycleMethod };
      } finally {
        preparingBitmap = false;
        timing.bitmapSetupMs = Math.round(performance.now() - at);
      }
    })();
    const captureStarted = performance.now();
    requested.sort((a, b) => Number(b.kind !== "own") - Number(a.kind !== "own"));
    let provider: Buffer | undefined, snapshotMethod: Buffer | undefined, copyMethod: Buffer | undefined, config: Buffer | undefined;
    let textureClass: Buffer | undefined, bitmapMethod: Buffer | undefined;
    const captureSurface = async (object: Buffer, hold: (value: Buffer) => Promise<Buffer>, bitmaps: Buffer[], buffers: Buffer[]) => {
      phase = "检查 Surface 状态";
      const surfaceViewClass = await classFor("Landroid/view/SurfaceView;");
      if ((await fieldValue(object, surfaceViewClass, "mSurfaceFlags", "I")).readInt32BE() & 0x80) throw new Error("Surface 设置了安全保护，不采集受保护内容");
      const params = await hold(await invoke(rootObject, viewClass, await methodFor(viewClass, "getLayoutParams", "()Landroid/view/ViewGroup$LayoutParams;")));
      if ((await fieldValue(params, await classFor("Landroid/view/WindowManager$LayoutParams;"), "flags", "I")).readInt32BE() & 0x2000) throw new Error("窗口设置了 FLAG_SECURE，不采集受保护内容");
      const surface = await fieldValue(object, surfaceViewClass, "mSurface", "Landroid/view/Surface;");
      if (surface.every((byte) => byte === 0)) throw new Error("Surface 尚未创建或已经销毁");
      await hold(surface);
      const surfaceClass = await classFor("Landroid/view/Surface;");
      if (!(await invoke(surface, surfaceClass, await methodFor(surfaceClass, "isValid", "()Z")))[0]) throw new Error("Surface 尚未创建或已经销毁");
      // Don't use Surface.getNextFrameNumber as a presence check: a remote
      // MediaCodec producer can queue frames without updating this Java wrapper.
      const width = (await invoke(object, viewClass, await methodFor(viewClass, "getWidth", "()I"))).readInt32BE();
      const height = (await invoke(object, viewClass, await methodFor(viewClass, "getHeight", "()I"))).readInt32BE();
      if (width < 1 || height < 1 || width * height > 4_000_000) throw new Error("Surface 位图尺寸超过限制");

      const renderer = await loadClass("Landroid/graphics/HardwareRenderer;");
      phase = "准备 Surface 像素拷贝";
      let copySurface: Buffer | undefined;
      try { copySurface = await methodFor(renderer, "copySurfaceInto", "(Landroid/view/Surface;Landroid/graphics/Rect;Landroid/graphics/Bitmap;)I"); }
      catch (error) { if (!(error instanceof Error && error.message === "Debug method unavailable: copySurfaceInto")) throw error; }
      if (copySurface) {
        // Android 10–13: the same synchronous native path used by PixelCopy.
        const bitmap = await hold(await invokeStatic(bitmapClass, await methodFor(bitmapClass, "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;"), [integerArg(width), integerArg(height), objectArg(config!)]));
        bitmaps.push(bitmap);
        const status = (await invokeStatic(renderer, copySurface, [objectArg(surface), objectArg(Buffer.alloc(objectSize)), objectArg(bitmap)])).readInt32BE();
        if (status !== 0) throw new Error(({ 1: "Surface 像素拷贝失败", 2: "Surface 等待画面超时", 3: "Surface 尚未提交画面", 4: "Surface 不可读（已销毁或受保护）", 5: "Surface 目标位图不可用" } as Record<number, string>)[status] ?? `Surface 像素拷贝失败：${status}`);
        return bitmap;
      }

      // Android 14+: copy only this view's BLAST buffer, not the window/container.
      // Embedded SurfacePackages contain a different UI tree; don't flatten them
      // into this view's own bitmap. No app surfaces are modified or released.
      const embedded = await fieldValue(object, surfaceViewClass, "mSurfacePackage", "Landroid/view/SurfaceControlViewHost$SurfacePackage;");
      if (embedded.some((byte) => byte !== 0)) throw new Error("嵌入式 SurfacePackage 需要独立子树采集，未混入当前图层");
      const control = await fieldValue(object, surfaceViewClass, "mBlastSurfaceControl", "Landroid/view/SurfaceControl;");
      if (control.every((byte) => byte === 0)) throw new Error("Surface 独立缓冲层尚未就绪");
      await hold(control);
      const sw = (await fieldValue(object, surfaceViewClass, "mSurfaceWidth", "I")).readInt32BE();
      const sh = (await fieldValue(object, surfaceViewClass, "mSurfaceHeight", "I")).readInt32BE();
      if (sw < 1 || sh < 1 || sw > 16384 || sh > 16384) throw new Error("Surface 缓冲区尺寸无效");
      const captureClass = await loadClass("Landroid/window/ScreenCapture;");
      phase = "准备 Surface 缓冲层";
      const builderClass = await loadClass("Landroid/window/ScreenCapture$LayerCaptureArgs$Builder;");
      const baseClass = await loadClass("Landroid/window/ScreenCapture$CaptureArgs$Builder;");
      const builder = await hold(resultValue(await command(3, 4, builderClass, mainThread!, await methodFor(builderClass, "<init>", "(Landroid/view/SurfaceControl;)V"), int(1), objectArg(control), int(1))));
      const processClass = await classFor("Landroid/os/Process;");
      const uid = (await invokeStatic(processClass, await methodFor(processClass, "myUid", "()I"), [])).readInt32BE();
      if (uid < 10000) throw new Error("Surface 采集仅允许普通 App 自身 UID");
      const uidValue = Buffer.alloc(9); uidValue[0] = 74; uidValue.writeBigInt64BE(BigInt(uid), 1);
      await invoke(builder, baseClass, await methodFor(baseClass, "setUid", "(J)Landroid/window/ScreenCapture$CaptureArgs$Builder;"), [uidValue]);
      for (const name of ["setCaptureSecureLayers", "setAllowProtected"]) await invoke(builder, baseClass, await methodFor(baseClass, name, "(Z)Landroid/window/ScreenCapture$CaptureArgs$Builder;"), [Buffer.from([90, 0])]);
      await invoke(builder, builderClass, await methodFor(builderClass, "setChildrenOnly", "(Z)Landroid/window/ScreenCapture$LayerCaptureArgs$Builder;"), [Buffer.from([90, 0])]);
      const rectClass = await classFor("Landroid/graphics/Rect;");
      const rect = await hold(resultValue(await command(3, 4, rectClass, mainThread!, await methodFor(rectClass, "<init>", "(IIII)V"), int(4), ...[0, 0, sw, sh].map(integerArg), int(1))));
      await invoke(builder, baseClass, await methodFor(baseClass, "setSourceCrop", "(Landroid/graphics/Rect;)Landroid/window/ScreenCapture$CaptureArgs$Builder;"), [objectArg(rect)]);
      const floatArg = (value: number) => { const b = Buffer.alloc(5); b[0] = 70; b.writeFloatBE(value, 1); return b; };
      // Round upwards by less than one pixel before SurfaceFlinger's truncation.
      await invoke(builder, baseClass, await methodFor(baseClass, "setFrameScale", "(FF)Landroid/window/ScreenCapture$CaptureArgs$Builder;"), [floatArg((width + 0.01) / sw), floatArg((height + 0.01) / sh)]);
      const args = await hold(await invoke(builder, builderClass, await methodFor(builderClass, "build", "()Landroid/window/ScreenCapture$LayerCaptureArgs;")));
      const shot = await invokeStatic(captureClass, await methodFor(captureClass, "captureLayers", "(Landroid/window/ScreenCapture$LayerCaptureArgs;)Landroid/window/ScreenCapture$ScreenshotHardwareBuffer;"), [objectArg(args)]);
      phase = "读取 Surface 像素";
      if (shot.every((byte) => byte === 0)) throw new Error("Surface 读取失败（无画面、受保护或系统拒绝）");
      await hold(shot);
      const shotClass = await loadClass("Landroid/window/ScreenCapture$ScreenshotHardwareBuffer;");
      const buffer = await invoke(shot, shotClass, await methodFor(shotClass, "getHardwareBuffer", "()Landroid/hardware/HardwareBuffer;"));
      if (buffer.every((byte) => byte === 0)) throw new Error("Surface 未返回缓冲区");
      buffers.push(await hold(buffer));
      if ((await invoke(shot, shotClass, await methodFor(shotClass, "containsSecureLayers", "()Z")))[0]) throw new Error("Surface 含安全图层，不读取其像素");
      const bitmap = await invoke(shot, shotClass, await methodFor(shotClass, "asBitmap", "()Landroid/graphics/Bitmap;"));
      if (bitmap.every((byte) => byte === 0)) throw new Error("Surface 未返回位图");
      bitmaps.push(await hold(bitmap));
      return invoke(bitmap, bitmapClass, copyMethod!, [objectArg(config!), Buffer.from([90, 0])]);
    };
    // ponytail: bounded fallback, not a second full capture pass.
    const maxViews = 64;
    for (const view of requested.slice(maxViews)) failures.set(view.ref, `本次补采达到 ${maxViews} 个控件上限`);
    for (const view of requested.slice(0, maxViews)) {
      signal?.throwIfAborted();
      const itemStarted = performance.now();
      phase = "读取独立位图";
      const temporary: Buffer[] = [], bitmaps: Buffer[] = [], buffers: Buffer[] = [];
      const hold = async (value: Buffer) => { temporary.push(await pin(value)); return value; };
      try {
        const { object, kind } = view;
        if (kind === "own" && !provider) {
          const providerClass = await loadClass(target.hardwareAccelerated === false
            ? "Landroid/view/ViewDebug$SoftwareCanvasProvider;" : "Landroid/view/ViewDebug$HardwareCanvasProvider;");
          const constructor = await methodFor(providerClass, "<init>", "()V");
          provider = await pin(resultValue(await command(3, 4, providerClass, mainThread, constructor, int(0), int(1))));
          snapshotMethod = await methodFor(viewClass, "createSnapshot", "(Landroid/view/ViewDebug$CanvasProvider;Z)Landroid/graphics/Bitmap;");
        }
        if (kind !== "texture" && !config) {
          const configClass = await classFor("Landroid/graphics/Bitmap$Config;");
          const valueOf = await methodFor(configClass, "valueOf", "(Ljava/lang/String;)Landroid/graphics/Bitmap$Config;");
          const name = await pin(await command(1, 11, string("ARGB_8888")));
          config = await pin(await invokeStatic(configClass, valueOf, [objectArg(name)]));
          copyMethod = await methodFor(bitmapClass, "copy", "(Landroid/graphics/Bitmap$Config;Z)Landroid/graphics/Bitmap;");
        }
        if (kind === "texture" && !textureClass) {
          textureClass = await classFor("Landroid/view/TextureView;");
          bitmapMethod = await methodFor(textureClass, "getBitmap", "()Landroid/graphics/Bitmap;");
        }
        let bitmap = kind === "surface" ? await captureSurface(object, hold, bitmaps, buffers) : kind === "texture"
          ? await invoke(object, textureClass!, bitmapMethod!)
          : await invoke(object, viewClass, snapshotMethod!, [objectArg(provider!), Buffer.from([90, 1])]);
        if (bitmap.every((byte) => byte === 0)) throw new Error("控件没有返回自身位图");
        if (!bitmaps.includes(bitmap)) bitmaps.push(await hold(bitmap));
        if (kind === "own") {
          bitmap = await invoke(bitmap, bitmapClass, copyMethod!, [objectArg(config!), Buffer.from([90, 0])]);
          if (bitmap.every((byte) => byte === 0)) throw new Error("无法读取控件位图像素");
          bitmaps.push(await hold(bitmap));
        }
        timing.snapshotMs += performance.now() - itemStarted;
        const width = (await invoke(bitmap, bitmapClass, widthMethod)).readInt32BE();
        const height = (await invoke(bitmap, bitmapClass, heightMethod)).readInt32BE();
        if (width < 1 || height < 1 || width * height > 4_000_000) throw new Error("控件位图尺寸超过限制");
        const array = (await command(4, 1, arrayClass, int(width * height))).subarray(1);
        await hold(array);
        await invoke(bitmap, bitmapClass, pixelsMethod, [Buffer.concat([Buffer.from("["), array]), ...[0, width, 0, 0, width, height].map(integerArg)]);
        const pixelsStarted = performance.now();
        const arrayData = await command(13, 2, array, int(0), int(width * height));
        timing.pixelsMs += performance.now() - pixelsStarted;
        if (arrayData.length !== 5 + width * height * 4 || arrayData[0] !== 73 || arrayData.readInt32BE(1) !== width * height) throw new Error("控件位图像素不完整");
        const pixels = arrayData.subarray(5);
        const scanlines = Buffer.alloc(height * (width * 4 + 1));
        let empty = true;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const source = (y * width + x) * 4, dest = y * (width * 4 + 1) + 1 + x * 4;
          if (pixels[source]) empty = false;
          scanlines[dest] = pixels[source + 1]; scanlines[dest + 1] = pixels[source + 2];
          scanlines[dest + 2] = pixels[source + 3]; scanlines[dest + 3] = pixels[source];
        }
        if (kind !== "own" && empty) throw new Error("独立缓冲区返回全透明像素，未确认取得视频画面；不代表控件本身没有内容");
        const chunk = (name: string, payload: Buffer) => {
          const body = Buffer.concat([Buffer.from(name), payload]);
          const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
          return Buffer.concat([int(payload.length), body, checksum]);
        };
        const header = Buffer.concat([int(width), int(height), Buffer.from([8, 6, 0, 0, 0])]);
        const compressStarted = performance.now();
        const compressed = await compress(scanlines);
        timing.compressMs += performance.now() - compressStarted;
        signal?.throwIfAborted();
        const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
        results.set(view.ref, { width, height, imageDataUrl: `data:image/png;base64,${png.toString("base64")}`, kind, empty });
      } catch (error) {
        signal?.throwIfAborted();
        if (socket.destroyed) throw error;
        failures.set(view.ref, error instanceof Error ? error.message : "独立画面补采失败");
      } finally {
        for (const bitmap of bitmaps) if (!socket.destroyed) await invoke(bitmap, bitmapClass, recycleMethod).catch(() => undefined);
        for (const buffer of buffers) if (!socket.destroyed) {
          const klass = await classFor("Landroid/hardware/HardwareBuffer;");
          await invoke(buffer, klass, await methodFor(klass, "close", "()V")).catch(() => undefined);
        }
        for (const object of temporary) if (!socket.destroyed) {
          await command(9, 8, object).catch(() => undefined);
          pinned.delete(object);
        }
      }
    }
    timing.snapshotMs = Math.round(timing.snapshotMs);
    timing.pixelsMs = Math.round(timing.pixelsMs);
    timing.compressMs = Math.round(timing.compressMs);
    timing.captureMs = Math.round(performance.now() - captureStarted);
    return { images: results, failures, kinds, skipDraw, timing };
  } catch (error) {
    signal?.throwIfAborted();
    if (!deadline.aborted && !results.size) throw error;
    const reason = deadline.aborted ? `独立画面补采达到 15 秒上限（${phase}）` : error instanceof Error ? error.message : "独立画面补采中断";
    for (const view of views) if (!results.has(view.ref) && !failures.has(view.ref) && !skipDraw.has(view.ref) && (view.captureOwn || kinds.get(view.ref) !== "own")) failures.set(view.ref, reason);
    return { images: results, failures, kinds, skipDraw, timing };
  } finally {
    await session.close();
  }
}

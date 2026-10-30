import type { ViewFontResult } from "../../shared/view-font";
import { connectJdwp } from "./jdwp-transport";
import { createJdwpViewSession } from "./jdwp-view-session";

type FontTarget = { rootRef: string; windowName: string; wakeUi?: () => Promise<void>; hardwareAccelerated?: boolean };

function waitForWake(wake: () => Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(wake).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// Read the current TextPaint's base font at a UI message boundary. This is a
// deliberately fixed operation, not an arbitrary application method invoker.
export async function readViewFont(port: number, target: FontTarget, ref: string, signal?: AbortSignal): Promise<ViewFontResult> {
  const deadline = AbortSignal.timeout(15_000);
  const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let session: ReturnType<typeof createJdwpViewSession> | undefined;
  try {
    for (const value of [target.rootRef, target.windowName, ref]) {
      if (!value || value.length > 4096 || /[\u0000\r\n]/.test(value)) throw new Error("字体读取目标无效，请重新采集");
    }
    const { socket, reader } = await connectJdwp(port, boundedSignal);
    session = createJdwpViewSession(socket, reader, { requireBootstrap: true });
    const view = await session.prepare({
      ...target,
      wakeUi: target.wakeUi ? () => waitForWake(target.wakeUi!, boundedSignal) : undefined,
    }, ref);
    const { command, commandBounded, classFor, membersFor, methodFor, objectSize, classSize, pin, int, string,
      objectArg, invokeStatic, invokeFramework, fieldValue, rootObject, debugClass, findMethod } = view;
    const nonnull = (value: Buffer) => value.length === objectSize && value.some(byte => byte !== 0);
    const assertInstanceOf = async (object: Buffer, expected: Buffer, label: string) => {
      const type = await command(9, 1, object);
      if (type.length !== 1 + classSize || type[0] !== 1) throw new Error("Invalid font object reference type");
      let klass = type.subarray(1);
      const seen = new Set<string>();
      while (!klass.equals(expected)) {
        const key = klass.toString("hex");
        if (seen.has(key) || seen.size >= 64) throw new Error("Invalid font superclass chain");
        seen.add(key);
        const parent = await command(3, 1, klass);
        if (parent.length !== classSize) throw new Error("Invalid font superclass");
        if (parent.every(byte => byte === 0)) throw new Error(label);
        klass = parent;
      }
    };
    const refName = await pin(await command(1, 11, string(ref)));
    const object = await invokeStatic(debugClass, findMethod, [objectArg(rootObject), objectArg(refName)]);
    if (!nonnull(object)) throw new Error("控件已不在当前窗口，请重新采集");
    await pin(object);
    const textViewClass = await classFor("Landroid/widget/TextView;");
    await assertInstanceOf(object, textViewClass, "此控件不是原生 TextView，无法读取字体");
    // TextView.getTypeface() can return mOriginalTypeface before font-weight
    // adjustment. getPaint().getTypeface() is the font actually used by the paint.
    const paint = await invokeFramework(object, textViewClass, await methodFor(textViewClass, "getPaint", "()Landroid/text/TextPaint;"), "L");
    if (!nonnull(paint)) throw new Error("TextView 未返回有效画笔");
    await pin(paint);
    const paintClass = await classFor("Landroid/graphics/Paint;");
    await assertInstanceOf(paint, paintClass, "TextView 返回了无效画笔类型");
    let typeface = await invokeFramework(paint, paintClass, await methodFor(paintClass, "getTypeface", "()Landroid/graphics/Typeface;"), "L");
    const typefaceClass = await classFor("Landroid/graphics/Typeface;");
    const usesDefaultTypeface = !nonnull(typeface);
    if (usesDefaultTypeface) {
      // Paint's null Typeface means the system default; it is not a custom font.
      const id = (await membersFor(typefaceClass, true)).get("DEFAULT:Landroid/graphics/Typeface;");
      if (!id) throw new Error("系统默认字体不可读取");
      const data = await command(2, 6, typefaceClass, int(1), id);
      if (data.length !== 5 + objectSize || data.readInt32BE(0) !== 1 || data[4] !== 76) throw new Error("Invalid default Typeface value");
      typeface = data.subarray(5);
    }
    if (!nonnull(typeface)) throw new Error("系统未返回有效字体");
    await pin(typeface);
    await assertInstanceOf(typeface, typefaceClass, "画笔返回了无效字体类型");
    const methods = await membersFor(typefaceClass);
    const readInteger = async (name: "getWeight" | "getStyle", field: "mWeight" | "mStyle", minimum: number, maximum: number) => {
      const method = methods.get(`${name}:()I`);
      let bytes: Buffer;
      if (method) bytes = await invokeFramework(typeface, typefaceClass, method, "I");
      else {
        // Older AOSP versions expose these exact int fields. Use metadata to
        // confirm the signature; an absent/changed field remains unknown.
        if (!(await membersFor(typefaceClass, true)).has(`${field}:I`)) return null;
        bytes = await fieldValue(typeface, typefaceClass, field, "I");
      }
      if (bytes.length !== 4) throw new Error("Invalid Typeface integer value");
      const value = bytes.readInt32BE();
      if (value < minimum || value > maximum) throw new Error("Invalid Typeface integer range");
      return value;
    };
    const weight = await readInteger("getWeight", "mWeight", 1, 1000);
    const style = await readInteger("getStyle", "mStyle", 0, 3);
    let familyName: string | null = null;
    let familyNameStatus: ViewFontResult["familyNameStatus"] = "unsupported";
    const familyMethod = methods.get("getSystemFontFamilyName:()Ljava/lang/String;");
    if (familyMethod) {
      // ART may use the generic object tag for a null String reference.
      const name = await invokeFramework(typeface, typefaceClass, familyMethod, "sL");
      familyNameStatus = "not-exposed";
      if (nonnull(name)) {
        await pin(name);
        await assertInstanceOf(name, await classFor("Ljava/lang/String;"), "字体家族名称不是字符串");
        // Bound the packet before allocating its payload, then validate its
        // exact byte count and UTF-8. Never label an absent name as a custom font.
        const data = await commandBounded(4100, 10, 1, name);
        if (data.length < 4 || data.readUInt32BE(0) > 4096 || data.readUInt32BE(0) !== data.length - 4) throw new Error("Invalid Typeface family name length");
        familyName = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(4));
        if (!familyName || /[\u0000-\u001f\u007f]/.test(familyName)) throw new Error("Invalid Typeface family name");
        familyNameStatus = "system-family";
      }
    }
    boundedSignal.throwIfAborted();
    return { ref, capturedAtMillis: Date.now(), source: "jdwp", basis: "text-paint", familyName, familyNameStatus,
      weight, style, usesDefaultTypeface };
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new Error("字体读取达到 15 秒上限，请稍后重试");
    throw error;
  } finally {
    await session?.close();
    signal?.throwIfAborted();
    if (deadline.aborted) throw new Error("字体读取达到 15 秒上限，请稍后重试");
  }
}

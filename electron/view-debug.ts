import { createConnection, type Socket } from "node:net";
import { crc32, deflate } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(deflate);

const JDWP_HANDSHAKE = Buffer.from("JDWP-Handshake");
const DDMS_COMMAND_SET = 199;
const DDMS_COMMAND = 1;
const MAX_PACKET_BYTES = 256 * 1024 * 1024;

export type CapturedViewLayer = {
  name: string;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  pngDataUrl: string | null;
  viewRef?: string;
};

class SocketReader {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(socket: Socket) {
    this.iterator = socket[Symbol.asyncIterator]();
  }

  async take(size: number) {
    if (this.buffer.length >= size) {
      const value = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      return value;
    }
    // Each packet byte is copied once, not once per arriving TCP fragment.
    const value = Buffer.allocUnsafe(size);
    let offset = this.buffer.copy(value);
    while (offset < size) {
      const next = await this.iterator.next();
      if (next.done) throw new Error("Debug View 连接提前关闭。");
      const copied = next.value.copy(value, offset, 0, size - offset);
      offset += copied;
      this.buffer = next.value.subarray(copied);
    }
    return value;
  }
}

function fourCc(value: string) {
  return Buffer.from(value, "ascii").readUInt32BE(0);
}

function utf16be(value: string) {
  const littleEndian = Buffer.from(value, "utf16le");
  for (let index = 0; index < littleEndian.length; index += 2) {
    const byte = littleEndian[index];
    littleEndian[index] = littleEndian[index + 1];
    littleEndian[index + 1] = byte;
  }
  return littleEndian;
}

function readUtf16be(buffer: Buffer, offset: number, length: number) {
  const value = Buffer.from(buffer.subarray(offset, offset + length * 2));
  for (let index = 0; index < value.length; index += 2) {
    const byte = value[index];
    value[index] = value[index + 1];
    value[index + 1] = byte;
  }
  return value.toString("utf16le");
}

async function connect(port: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const socket = createConnection({ host: "127.0.0.1", port, signal });
  socket.setNoDelay(true);
  socket.setTimeout(5_000, () => socket.destroy(new Error("Debug View 连接超时。")));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const reader = new SocketReader(socket);
  try {
    socket.write(JDWP_HANDSHAKE);
    const handshake = await reader.take(JDWP_HANDSHAKE.length);
    if (!handshake.equals(JDWP_HANDSHAKE)) throw new Error("目标进程未接受 Debug View 连接。");
    socket.setTimeout(90_000);
    return { socket, reader };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function requestChunk(socket: Socket, reader: SocketReader, id: number, type: string, data: Buffer = Buffer.alloc(0)) {
  const chunk = Buffer.alloc(8 + data.length);
  chunk.writeUInt32BE(fourCc(type), 0);
  chunk.writeUInt32BE(data.length, 4);
  data.copy(chunk, 8);
  const packet = Buffer.alloc(11 + chunk.length);
  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt32BE(id, 4);
  packet[8] = 0;
  packet[9] = DDMS_COMMAND_SET;
  packet[10] = DDMS_COMMAND;
  chunk.copy(packet, 11);
  socket.write(packet);

  while (true) {
    const header = await reader.take(11);
    const length = header.readUInt32BE(0);
    if (length < 11 || length > MAX_PACKET_BYTES) throw new Error("Debug View 返回了无效数据。");
    const payload = await reader.take(length - 11);
    if (header[8] !== 0x80 || header.readUInt32BE(4) !== id) continue;
    const errorCode = header.readUInt16BE(9);
    if (errorCode !== 0) throw new Error(`Debug View 请求失败：${errorCode}`);
    if (payload.length < 8) throw new Error("Debug View 返回内容为空。");
    const responseType = payload.subarray(0, 4).toString("ascii");
    const responseLength = payload.readUInt32BE(4);
    if (responseLength !== payload.length - 8) throw new Error("Debug View 返回长度不一致。");
    if (responseType === "FAIL") throw new Error("Android 无法抓取独立控件画面。");
    return payload.subarray(8, 8 + responseLength);
  }
}

function parseWindowNames(data: Buffer) {
  if (data.length < 4) return [];
  const count = data.readUInt32BE(0);
  const names: string[] = [];
  let offset = 4;
  for (let index = 0; index < count && offset + 4 <= data.length; index += 1) {
    const length = data.readUInt32BE(offset);
    offset += 4;
    if (offset + length * 2 > data.length) break;
    names.push(readUtf16be(data, offset, length));
    offset += length * 2;
  }
  return names;
}

function pngSize(data: Buffer) {
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export function parseCapturedViewLayers(data: Buffer): CapturedViewLayer[] {
  if (data.length < 9) return [];
  const layers: CapturedViewLayer[] = [];
  let offset = 8;
  while (offset < data.length) {
    const tag = data[offset++];
    if (tag === 2) break;
    if (tag !== 1 || offset + 2 > data.length) throw new Error("Debug View 图层数据损坏。");
    const nameLength = data.readUInt16BE(offset);
    offset += 2;
    if (offset + nameLength + 9 > data.length) throw new Error("Debug View 图层数据不完整。");
    const name = data.subarray(offset, offset + nameLength).toString("utf8");
    offset += nameLength;
    const visible = data[offset++] === 1;
    const x = data.readInt32BE(offset);
    const y = data.readInt32BE(offset + 4);
    offset += 8;
    let image: Buffer | null = null;
    // Android omits the length entirely when performViewCapture returns null.
    if (offset < data.length && data[offset] !== 1 && data[offset] !== 2) {
      if (offset + 4 > data.length) throw new Error("Debug View 图层图片长度缺失。");
      const imageLength = data.readUInt32BE(offset);
      offset += 4;
      if (offset + imageLength > data.length) throw new Error("Debug View 图层图片不完整。");
      image = data.subarray(offset, offset + imageLength);
      offset += imageLength;
    }
    const size = image ? pngSize(image) : null;
    layers.push({ name, visible, x, y, width: size?.width ?? 0, height: size?.height ?? 0, pngDataUrl: size ? `data:image/png;base64,${image!.toString("base64")}` : null });
  }
  return layers;
}

export function matchesViewRoot(expected: string, actual: string) {
  // Activity.dump() abbreviates DecorView; DDMS includes its package/enclosing class.
  return expected === actual || (/^DecorView@[0-9a-f]+$/i.test(expected)
    && (actual.endsWith(`.${expected}`) || actual.endsWith(`$${expected}`)));
}

export async function captureViewLayers(port: number, options: { rootRefs: readonly string[]; onHierarchy: (hierarchy: string, windowName: string) => void; signal?: AbortSignal }) {
  const { socket, reader } = await connect(port, options.signal);
  try {
    const names = parseWindowNames(await requestChunk(socket, reader, 1, "VULW"));
    if (names.length > 32) throw new Error("Debug 窗口数量异常。");
    let selected: { request: Buffer; name: string } | null = null;
    let sequence = 2;
    for (const name of names) {
      const encodedName = utf16be(name);
      const request = Buffer.alloc(8 + encodedName.length);
      request.writeUInt32BE(1, 0);
      request.writeUInt32BE(name.length, 4);
      encodedName.copy(request, 8);
      // Probe identities without exporting every unrelated window's properties.
      const dump = Buffer.concat([request, Buffer.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])]);
      const hierarchy = (await requestChunk(socket, reader, sequence++, "VURT", dump)).toString("utf8");
      const rootRef = hierarchy.trimStart().split(/\s/)[0];
      if (!options.rootRefs.some((expected) => matchesViewRoot(expected, rootRef))) continue;
      if (selected) throw new Error("多个 Debug 窗口匹配当前控件树，请关闭弹窗后重新采集。");
      selected = { request, name };
    }
    if (!selected) throw new Error("Debug 窗口与当前控件树不一致，请重新采集。");
    const dump = Buffer.concat([selected.request, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0])]);
    const hierarchy = (await requestChunk(socket, reader, sequence++, "VURT", dump)).toString("utf8");
    if (!options.rootRefs.some((expected) => matchesViewRoot(expected, hierarchy.trimStart().split(/\s/)[0]))) throw new Error("Debug 窗口身份已变化，请重新采集。");
    if (!hierarchy.trimEnd().endsWith("\nDONE.")) throw new Error("Android 未完成控件属性导出，请确认 App 正常响应后重新采集。");
    options.onHierarchy(hierarchy, selected.name);
    selected.request.writeUInt32BE(2, 0);
    return parseCapturedViewLayers(await requestChunk(socket, reader, sequence, "VURT", selected.request));
  } finally {
    socket.destroy();
  }
}

export async function captureViewBitmapsDdms(port: number, target: { windowName: string }, views: readonly { ref: string }[], signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(15_000);
  const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const { socket, reader } = await connect(port, combinedSignal);
  const images = new Map<string, { width: number; height: number; pngDataUrl: string }>();
  const failures = new Map<string, string>();
  const int = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; };
  try {
    if (!target.windowName) throw new Error("Debug 窗口名称为空，请重新采集");
    for (let index = 0; index < views.length; index += 1) {
      combinedSignal.throwIfAborted();
      const view = views[index];
      try {
        const root = utf16be(target.windowName);
        const ref = utf16be(view.ref);
        const request = Buffer.concat([Buffer.alloc(4), int(target.windowName.length), root, int(view.ref.length), ref]);
        request.writeUInt32BE(1, 0);
        const png = await requestChunk(socket, reader, index + 1, "VUOP", request);
        const size = pngSize(png);
        if (!size) throw new Error("DDMS 未返回有效控件图片");
        images.set(view.ref, { width: size.width, height: size.height, pngDataUrl: "data:image/png;base64," + png.toString("base64") });
      } catch (error) {
        if (socket.destroyed) throw error;
        failures.set(view.ref, error instanceof Error ? error.message : "DDMS 控件图片采集失败");
      }
    }
    return { images, failures };
  } catch (error) {
    combinedSignal.throwIfAborted();
    if (!deadline.aborted) throw error;
    for (const view of views) if (!images.has(view.ref) && !failures.has(view.ref)) failures.set(view.ref, "DDMS 控件图片采集达到 15 秒上限");
    return { images, failures };
  } finally {
    socket.destroy();
  }
}

// Reuse Android's own snapshot implementation with skipChildren=true. A normal
// DDMS CAPTURE_VIEW includes descendants and is not an independent layer.
export async function captureViewBitmaps(port: number, target: { rootRef: string; windowName: string }, views: readonly { ref: string; captureOwn: boolean }[], signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(15_000);
  const { socket, reader } = await connect(port, signal ? AbortSignal.any([signal, deadline]) : deadline);
  let sequence = 10;
  let mainThread: Buffer | null = null;
  const events: Buffer[] = [];
  const pinned = new Set<Buffer>();
  type Kind = "own" | "texture" | "surface";
  const results = new Map<string, { width: number; height: number; pngDataUrl: string; kind: Kind }>();
  const failures = new Map<string, string>();
  const kinds = new Map<string, Kind>();
  let phase = "连接调试窗口";
  const int = (value: number) => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; };
  const string = (value: string) => { const b = Buffer.from(value); return Buffer.concat([int(b.length), b]); };
  const command = async (set: number, operation: number, ...parts: Buffer[]) => {
    const data = Buffer.concat(parts);
    const packet = Buffer.alloc(11 + data.length);
    packet.writeUInt32BE(packet.length); packet.writeUInt32BE(++sequence, 4);
    packet[9] = set; packet[10] = operation; data.copy(packet, 11); socket.write(packet);
    while (true) {
      const header = await reader.take(11);
      const length = header.readUInt32BE(0);
      if (length < 11 || length > MAX_PACKET_BYTES) throw new Error("Invalid JDWP packet size");
      const payload = await reader.take(length - 11);
      if (header[8] !== 0x80) { events.push(payload); continue; }
      if (header.readUInt32BE(4) !== sequence) continue;
      if (header.readUInt16BE(9)) throw new Error(`JDWP ${set}/${operation}: ${header.readUInt16BE(9)}`);
      return payload;
    }
  };
  try {
    const sizes = await command(1, 7);
    if (sizes.length !== 20 || [0, 4, 8, 12, 16].some((offset) => ![4, 8].includes(sizes.readInt32BE(offset)))) throw new Error("Invalid JDWP ID sizes");
    const fieldSize = sizes.readInt32BE(0), methodSize = sizes.readInt32BE(4), objectSize = sizes.readInt32BE(8), classSize = sizes.readInt32BE(12);
    const classes = new Map<string, Buffer>();
    const classFor = async (signature: string) => {
      if (classes.has(signature)) return classes.get(signature)!;
      const data = await command(1, 2, string(signature));
      if (data.length !== 9 + classSize || data.readInt32BE(0) !== 1) throw new Error(`Debug class unavailable: ${signature}`);
      const id = data.subarray(5, 5 + classSize);
      classes.set(signature, id);
      return id;
    };
    const members = new Map<string, Map<string, Buffer>>();
    const memberFor = async (classId: Buffer, name: string, signature: string, fields = false) => {
      const key = `${classId.toString("hex")}/${fields ? "fields" : "methods"}`;
      let entries = members.get(key);
      if (!entries) {
        const data = await command(2, fields ? 4 : 5, classId);
        if (data.length < 4 || data.readInt32BE(0) < 0) throw new Error("Invalid JDWP member list");
        let offset = 4;
        const readString = () => {
          if (offset + 4 > data.length) throw new Error("Invalid JDWP member string");
          const size = data.readUInt32BE(offset); offset += 4;
          if (offset + size > data.length) throw new Error("Invalid JDWP member string");
          const value = data.subarray(offset, offset + size).toString(); offset += size; return value;
        };
        entries = new Map();
        for (let count = data.readInt32BE(0); count > 0; count--) {
          const idSize = fields ? fieldSize : methodSize;
          const id = data.subarray(offset, offset + idSize); offset += idSize;
          const memberName = readString(), memberSignature = readString(); offset += 4;
          if (offset > data.length) throw new Error("Invalid JDWP member");
          entries.set(`${memberName}:${memberSignature}`, id);
        }
        if (offset !== data.length) throw new Error("Invalid JDWP member list");
        members.set(key, entries);
      }
      const id = entries.get(`${name}:${signature}`);
      if (!id) throw new Error(`Debug ${fields ? "field" : "method"} unavailable: ${name}`);
      return id;
    };
    const methodFor = (classId: Buffer, name: string, signature: string) => memberFor(classId, name, signature);
    // Read the already-resolved object's real type instead of repeatedly scanning
    // ART's class loaders by name. Cache by class ID, not an ambiguous class name.
    const typeKinds = new Map<string, Kind>();
    const kindFor = async (object: Buffer): Promise<Kind> => {
      const type = await command(9, 1, object);
      if (type.length !== 1 + classSize || type[0] !== 1) throw new Error("Invalid View reference type");
      let id = type.subarray(1);
      const path: string[] = [];
      let kind: Kind = "own";
      while (!typeKinds.has(id.toString("hex"))) {
        const key = id.toString("hex");
        if (path.length >= 64 || path.includes(key)) throw new Error("Invalid View superclass chain");
        path.push(key);
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
      kind = typeKinds.get(id.toString("hex")) ?? kind;
      for (const key of path) typeKinds.set(key, kind);
      return kind;
    };
    const threads = await command(1, 4);
    for (let offset = 4; offset < threads.length; offset += objectSize) {
      const id = threads.subarray(offset, offset + objectSize);
      const name = await command(11, 1, id);
      if (name.subarray(4).toString() === "main") { mainThread = id; break; }
    }
    if (!mainThread) throw new Error("Main thread unavailable");
    {
      phase = "等待主线程消息边界";
      // Stop between UI messages, never in the middle of draw/layout. Arbitrary
      // single-stepping can re-enter a live draw when createSnapshot is invoked.
      const queueClass = await classFor("Landroid/os/MessageQueue;");
      const nextMessage = await methodFor(queueClass, "next", "()Landroid/os/Message;");
      events.length = 0;
      const breakpoint = await command(15, 1, Buffer.from([2, 1]), int(2), Buffer.from([3]), mainThread!, Buffer.from([7, 1]), queueClass, nextMessage, Buffer.alloc(8));
      // Wake a static page without invoking a method on the suspended UI thread.
      const wake = Buffer.concat([int(2), ...[target.windowName, views[0]?.ref ?? target.rootRef].flatMap((value) => [int(value.length), utf16be(value)])]);
      const wakeReply = await command(DDMS_COMMAND_SET, DDMS_COMMAND, Buffer.from("VUOP"), int(wake.length), wake);
      if (wakeReply.length) throw new Error("无法唤醒当前 Debug 窗口，请重新采集");
      const isOurBreakpoint = (event: Buffer) => event.length >= 10 + objectSize && event[0] === 1 && event.readInt32BE(1) === 1
        && event[5] === 2 && event.subarray(6, 10).equals(breakpoint) && event.subarray(10, 10 + objectSize).equals(mainThread!);
      while (!events.some(isOurBreakpoint)) {
        const header = await reader.take(11);
        const length = header.readUInt32BE(0);
        if (length < 11 || length > MAX_PACKET_BYTES) throw new Error("Invalid JDWP event");
        const payload = await reader.take(length - 11);
        if (header[8] !== 0x80) events.push(payload);
      }
      await command(15, 2, Buffer.from([2]), breakpoint);
    }
    phase = "读取独立位图";
    const valueSize = (tag: number) => {
      const primitive = new Map([[86, 0], [66, 1], [90, 1], [67, 2], [83, 2], [73, 4], [70, 4], [74, 8], [68, 8]]).get(tag);
      if (primitive !== undefined) return primitive;
      if ("[Lstglc".includes(String.fromCharCode(tag))) return objectSize;
      throw new Error("Invalid JDWP value tag");
    };
    const resultValue = (data: Buffer) => {
      const valueLength = valueSize(data[0]);
      if (data.length !== 2 + valueLength + objectSize) throw new Error("Invalid JDWP method result");
      if (data.subarray(2 + valueLength, 2 + valueLength + objectSize).some((byte) => byte !== 0)) throw new Error("Android bitmap method threw an exception");
      return data.subarray(1, 1 + valueLength);
    };
    const invoke = async (object: Buffer, klass: Buffer, method: Buffer, args: Buffer[] = []) => resultValue(await command(9, 6, object, mainThread!, klass, method, int(args.length), ...args, int(1)));
    const invokeStatic = async (klass: Buffer, method: Buffer, args: Buffer[]) => resultValue(await command(3, 3, klass, mainThread!, method, int(args.length), ...args, int(1)));
    const pin = async (object: Buffer) => { await command(9, 7, object); pinned.add(object); return object; };
    const objectArg = (object: Buffer) => Buffer.concat([Buffer.from("L"), object]);
    const integerArg = (value: number) => Buffer.concat([Buffer.from("I"), int(value)]);
    const fieldValue = async (object: Buffer, klass: Buffer, name: string, signature: string) => {
      const field = await memberFor(klass, name, signature, true);
      const data = await command(9, 2, object, int(1), field);
      if (data.length < 5 || data.readInt32BE(0) !== 1 || data[4] !== signature.charCodeAt(0) || data.length !== 5 + valueSize(data[4])) throw new Error("Invalid JDWP field value");
      return data.subarray(5);
    };
    const loadClass = async (signature: string) => {
      if (classes.has(signature)) return classFor(signature);
      const klass = await classFor("Ljava/lang/Class;");
      const name = await pin(await command(1, 11, string(signature.slice(1, -1).replace(/\//g, "."))));
      const object = await pin(await invokeStatic(klass, await methodFor(klass, "forName", "(Ljava/lang/String;)Ljava/lang/Class;"), [objectArg(name)]));
      const data = await command(17, 1, object);
      if (data.length !== 1 + classSize || data[0] !== 1) throw new Error("Invalid JDWP reflected class");
      const id = data.subarray(1); classes.set(signature, id); return id;
    };
    const viewClass = await classFor("Landroid/view/View;");
    const debugClass = await classFor("Landroid/view/ViewDebug;");
    const bitmapClass = await classFor("Landroid/graphics/Bitmap;");
    const arrayClass = await classFor("[I");
    const findMethod = await methodFor(debugClass, "findView", "(Landroid/view/View;Ljava/lang/String;)Landroid/view/View;");
    const widthMethod = await methodFor(bitmapClass, "getWidth", "()I");
    const heightMethod = await methodFor(bitmapClass, "getHeight", "()I");
    const pixelsMethod = await methodFor(bitmapClass, "getPixels", "([IIIIIII)V");
    // Use the exact DDMS window, not a heap-wide Instances scan (which forces GC).
    const windowsClass = await classFor("Landroid/view/WindowManagerGlobal;");
    const getInstance = await methodFor(windowsClass, "getInstance", "()Landroid/view/WindowManagerGlobal;");
    const getRoot = await methodFor(windowsClass, "getRootView", "(Ljava/lang/String;)Landroid/view/View;");
    const windows = await pin(await invokeStatic(windowsClass, getInstance, []));
    const windowName = await pin(await command(1, 11, string(target.windowName)));
    const rootObject = await invoke(windows, windowsClass, getRoot, [objectArg(windowName)]);
    if (rootObject.every((byte) => byte === 0)) throw new Error("Debug 窗口已关闭，请重新采集");
    await pin(rootObject);
    const rootName = await pin(await command(1, 11, string(target.rootRef)));
    if (!rootObject.equals(await invokeStatic(debugClass, findMethod, [objectArg(rootObject), objectArg(rootName)]))) throw new Error("Debug 窗口身份已变化，请重新采集");
    const requested: { ref: string; kind: Kind; object: Buffer }[] = [];
    for (const view of views) {
      let name: Buffer | undefined, object: Buffer | undefined;
      try {
        name = await pin(await command(1, 11, string(view.ref)));
        const found = await invokeStatic(debugClass, findMethod, [objectArg(rootObject), objectArg(name)]);
        if (found.every(byte => byte === 0)) throw new Error("控件已不在当前窗口，请重新采集");
        object = await pin(found);
        const kind = await kindFor(object);
        kinds.set(view.ref, kind);
        if (view.captureOwn || kind !== "own") {
          requested.push({ ref: view.ref, kind, object });
          object = undefined; // Keep drawable objects pinned through capture.
        }
      } catch (error) {
        if (socket.destroyed) throw error;
        failures.set(view.ref, error instanceof Error ? error.message : "无法识别控件类型");
      } finally {
        for (const value of [name, object]) if (value && !socket.destroyed) {
          await command(9, 8, value).catch(() => undefined);
          pinned.delete(value);
        }
      }
    }
    requested.sort((a, b) => Number(b.kind !== "own") - Number(a.kind !== "own"));
    let provider: Buffer | undefined, snapshotMethod: Buffer | undefined, copyMethod: Buffer | undefined, config: Buffer | undefined;
    let textureClass: Buffer | undefined, bitmapMethod: Buffer | undefined;
    const recycleMethod = await methodFor(bitmapClass, "recycle", "()V");
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
      phase = "读取独立位图";
      const temporary: Buffer[] = [], bitmaps: Buffer[] = [], buffers: Buffer[] = [];
      const hold = async (value: Buffer) => { temporary.push(await pin(value)); return value; };
      try {
        const { object, kind } = view;
        if (kind === "own" && !provider) {
          const providerClass = await loadClass("Landroid/view/ViewDebug$HardwareCanvasProvider;");
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
        const width = (await invoke(bitmap, bitmapClass, widthMethod)).readInt32BE();
        const height = (await invoke(bitmap, bitmapClass, heightMethod)).readInt32BE();
        if (width < 1 || height < 1 || width * height > 4_000_000) throw new Error("控件位图尺寸超过限制");
        const array = (await command(4, 1, arrayClass, int(width * height))).subarray(1);
        await hold(array);
        await invoke(bitmap, bitmapClass, pixelsMethod, [Buffer.concat([Buffer.from("["), array]), ...[0, width, 0, 0, width, height].map(integerArg)]);
        const arrayData = await command(13, 2, array, int(0), int(width * height));
        if (arrayData.length !== 5 + width * height * 4 || arrayData[0] !== 73 || arrayData.readInt32BE(1) !== width * height) throw new Error("控件位图像素不完整");
        const pixels = arrayData.subarray(5);
        const scanlines = Buffer.alloc(height * (width * 4 + 1));
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const source = (y * width + x) * 4, dest = y * (width * 4 + 1) + 1 + x * 4;
          scanlines[dest] = pixels[source + 1]; scanlines[dest + 1] = pixels[source + 2];
          scanlines[dest + 2] = pixels[source + 3]; scanlines[dest + 3] = pixels[source];
        }
        const chunk = (name: string, payload: Buffer) => {
          const body = Buffer.concat([Buffer.from(name), payload]);
          const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
          return Buffer.concat([int(payload.length), body, checksum]);
        };
        const header = Buffer.concat([int(width), int(height), Buffer.from([8, 6, 0, 0, 0])]);
        const compressed = await compress(scanlines);
        signal?.throwIfAborted();
        const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
        results.set(view.ref, { width, height, pngDataUrl: `data:image/png;base64,${png.toString("base64")}`, kind });
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
    return { images: results, failures, kinds };
  } catch (error) {
    signal?.throwIfAborted();
    if (!deadline.aborted) throw error;
    for (const view of views) if (!results.has(view.ref) && (view.captureOwn || kinds.get(view.ref) !== "own")) failures.set(view.ref, `独立画面补采达到 15 秒上限（${phase}）`);
    return { images: results, failures, kinds };
  } finally {
    for (const object of pinned) if (!socket.destroyed) await command(9, 8, object).catch(() => undefined);
    // Dispose clears event requests and releases every debugger suspension.
    if (!socket.destroyed) await command(1, 6).catch(() => undefined);
    socket.destroy();
  }
}

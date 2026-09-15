import { createConnection, type Socket } from "node:net";
import { crc32, deflateSync } from "node:zlib";

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
};

class SocketReader {
  private buffer = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(socket: Socket) {
    this.iterator = socket[Symbol.asyncIterator]();
  }

  async take(size: number) {
    while (this.buffer.length < size) {
      const next = await this.iterator.next();
      if (next.done) throw new Error("Debug View 连接提前关闭。");
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
    const value = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
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

async function connect(port: number) {
  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.setTimeout(90_000, () => socket.destroy(new Error("Debug View 连接超时。")));
  const reader = new SocketReader(socket);
  try {
    socket.write(JDWP_HANDSHAKE);
    const handshake = await reader.take(JDWP_HANDSHAKE.length);
    if (!handshake.equals(JDWP_HANDSHAKE)) throw new Error("目标进程未接受 Debug View 连接。");
    return { socket, reader };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function requestChunk(socket: Socket, reader: SocketReader, id: number, type: string, data = Buffer.alloc(0)) {
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

export async function captureViewLayers(port: number, onHierarchy?: (hierarchy: string) => void) {
  const { socket, reader } = await connect(port);
  try {
    const names = parseWindowNames(await requestChunk(socket, reader, 1, "VULW"));
    if (names.length === 0) return [];
    const name = names[0];
    const encodedName = utf16be(name);
    const request = Buffer.alloc(8 + encodedName.length);
    request.writeUInt32BE(2, 0);
    request.writeUInt32BE(name.length, 4);
    encodedName.copy(request, 8);
    if (onHierarchy) {
      const dump = Buffer.concat([request, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0])]);
      dump.writeUInt32BE(1, 0);
      onHierarchy((await requestChunk(socket, reader, 3, "VURT", dump)).toString("utf8"));
    }
    return parseCapturedViewLayers(await requestChunk(socket, reader, 2, "VURT", request));
  } finally {
    socket.destroy();
  }
}

// TextureView.draw() doesn't copy its SurfaceTexture into ViewDebug snapshots.
// Read getBitmap() on the app's main thread and transfer its ARGB pixels via JDWP.
export async function captureTextureViewBitmaps(port: number, views: readonly string[]) {
  const { socket, reader } = await connect(port);
  let sequence = 10;
  let mainThread: Buffer | null = null;
  const events: Buffer[] = [];
  const pinned: Buffer[] = [];
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
    const methodSize = sizes.readInt32BE(4), objectSize = sizes.readInt32BE(8), classSize = sizes.readInt32BE(12);
    const classFor = async (signature: string) => {
      const data = await command(1, 2, string(signature));
      if (data.readInt32BE(0) !== 1) throw new Error(`Debug class unavailable: ${signature}`);
      return data.subarray(5, 5 + classSize);
    };
    const methodFor = async (classId: Buffer, name: string, signature: string) => {
      const data = await command(2, 5, classId);
      let offset = 4;
      const readString = () => { const size = data.readInt32BE(offset); offset += 4; const value = data.subarray(offset, offset + size).toString(); offset += size; return value; };
      for (let count = data.readInt32BE(0); count > 0; count--) {
        const id = data.subarray(offset, offset + methodSize); offset += methodSize;
        const methodName = readString(), methodSignature = readString(); offset += 4;
        if (methodName === name && methodSignature === signature) return id;
      }
      throw new Error(`Debug method unavailable: ${name}`);
    };
    const threads = await command(1, 4);
    for (let offset = 4; offset < threads.length; offset += objectSize) {
      const id = threads.subarray(offset, offset + objectSize);
      const name = await command(11, 1, id);
      if (name.subarray(4).toString() === "main") { mainThread = id; break; }
    }
    if (!mainThread) throw new Error("Main thread unavailable");
    await command(11, 2, mainThread);
    // ART only permits method invocation at an event suspension.
    events.length = 0;
    const stepRequest = await command(15, 1, Buffer.from([1, 1]), int(2), Buffer.from([1]), int(1), Buffer.from([10]), mainThread, int(-1), int(0));
    await command(11, 3, mainThread);
    while (!events.length) {
      const header = await reader.take(11);
      const length = header.readUInt32BE(0);
      if (length < 11 || length > MAX_PACKET_BYTES) throw new Error("Invalid JDWP event");
      const payload = await reader.take(length - 11);
      if (header[8] !== 0x80) events.push(payload);
    }
    await command(15, 2, Buffer.from([1]), stepRequest);
    const invoke = async (object: Buffer, klass: Buffer, method: Buffer, args: Buffer[] = []) => {
      const data = await command(9, 6, object, mainThread!, klass, method, int(args.length), ...args, int(1));
      const valueLength = data[0] === 86 ? 0 : data[0] === 73 ? 4 : objectSize;
      if (data.subarray(2 + valueLength, 2 + valueLength + objectSize).some((byte) => byte !== 0)) throw new Error("Android bitmap method threw an exception");
      return data.subarray(1, 1 + valueLength);
    };
    const textureClass = await classFor("Landroid/view/TextureView;");
    const objectClass = await classFor("Ljava/lang/Object;");
    const bitmapClass = await classFor("Landroid/graphics/Bitmap;");
    const arrayClass = await classFor("[I");
    const hashMethod = await methodFor(objectClass, "hashCode", "()I");
    const bitmapMethod = await methodFor(textureClass, "getBitmap", "()Landroid/graphics/Bitmap;");
    const widthMethod = await methodFor(bitmapClass, "getWidth", "()I");
    const heightMethod = await methodFor(bitmapClass, "getHeight", "()I");
    const pixelsMethod = await methodFor(bitmapClass, "getPixels", "([IIIIIII)V");
    const results = new Map<string, { width: number; height: number; pngDataUrl: string }>();
    for (const view of views) {
      const split = view.lastIndexOf("@");
      const targetHash = Number.parseInt(view.slice(split + 1), 16) >>> 0;
      const klass = await classFor(`L${view.slice(0, split).replace(/\./g, "/")};`);
      const instances = await command(2, 16, klass, int(256));
      for (let offset = 4; offset < instances.length; offset += objectSize + 1) {
        const object = instances.subarray(offset + 1, offset + 1 + objectSize);
        if ((await invoke(object, objectClass, hashMethod)).readUInt32BE() !== targetHash) continue;
        const bitmap = await invoke(object, textureClass, bitmapMethod);
        if (bitmap.every((byte) => byte === 0)) break;
        await command(9, 7, bitmap); pinned.push(bitmap);
        const width = (await invoke(bitmap, bitmapClass, widthMethod)).readInt32BE();
        const height = (await invoke(bitmap, bitmapClass, heightMethod)).readInt32BE();
        if (width < 1 || height < 1 || width * height > 16_000_000) throw new Error("Video bitmap dimensions exceed limit");
        const array = (await command(4, 1, arrayClass, int(width * height))).subarray(1);
        await command(9, 7, array); pinned.push(array);
        const integerArg = (value: number) => Buffer.concat([Buffer.from("I"), int(value)]);
        await invoke(bitmap, bitmapClass, pixelsMethod, [Buffer.concat([Buffer.from("["), array]), ...[0, width, 0, 0, width, height].map(integerArg)]);
        const pixels = (await command(13, 2, array, int(0), int(width * height))).subarray(5);
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
        const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
        results.set(view, { width, height, pngDataUrl: `data:image/png;base64,${png.toString("base64")}` });
        break;
      }
    }
    return results;
  } finally {
    for (const object of pinned) await command(9, 8, object).catch(() => undefined);
    // Dispose clears event requests and releases every debugger suspension.
    await command(1, 6).catch(() => undefined);
    socket.destroy();
  }
}

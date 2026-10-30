import { createConnection, type Socket } from "node:net";

const JDWP_HANDSHAKE = Buffer.from("JDWP-Handshake");

export const DDMS_COMMAND_SET = 199;

export const DDMS_COMMAND = 1;

export const MAX_PACKET_BYTES = 256 * 1024 * 1024;

const JDWP_HANDSHAKE_TIMEOUT_MS = 30_000;

export class SocketReader {
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

// One reader owns a bounded group of read-only metadata requests. Never pipeline
// invocation, suspension, pinning or capture commands through this helper.
export async function requestJdwpMetadataBatch(socket: Pick<Socket, "write">, reader: { take(size: number): Promise<Buffer> },
  requests: readonly { id: number; set: number; operation: number; data: Buffer }[], events: Buffer[]) {
  if (!requests.length || requests.length > 8 || new Set(requests.map(r => r.id)).size !== requests.length
      || requests.some(r => !(r.set === 1 && r.operation === 2 || r.set === 2 && r.operation === 5)))
    throw new Error("Invalid JDWP metadata batch");
  const pending = new Map(requests.map((r, index) => [r.id, { ...r, index }]));
  const packets = requests.map(r => {
    const packet = Buffer.alloc(11 + r.data.length);
    packet.writeUInt32BE(packet.length); packet.writeUInt32BE(r.id, 4);
    packet[9] = r.set; packet[10] = r.operation; r.data.copy(packet, 11);
    return packet;
  });
  socket.write(Buffer.concat(packets));
  const replies: Buffer[] = new Array(requests.length);
  let failure: Error | undefined;
  while (pending.size) {
    const header = await reader.take(11);
    const length = header.readUInt32BE(0);
    if (length < 11 || length > MAX_PACKET_BYTES) throw new Error("Invalid JDWP packet size");
    const payload = await reader.take(length - 11);
    if (header[8] !== 0x80) { events.push(payload); continue; }
    const id = header.readUInt32BE(4), request = pending.get(id);
    if (!request) throw new Error("Unexpected JDWP metadata reply");
    pending.delete(id);
    const error = header.readUInt16BE(9);
    if (error && !failure) failure = new Error(`JDWP ${request.set}/${request.operation}: ${error}`);
    replies[request.index] = payload;
  }
  // Drain the complete batch before throwing so Dispose can still release the UI.
  if (failure) throw failure;
  return replies;
}

export async function connectJdwp(port: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const socket = createConnection({ host: "127.0.0.1", port, signal });
  socket.setNoDelay(true);
  // A canceled DDMS layer request can keep the App's debugger busy until its
  // in-process capture finishes; the next handshake must wait for that work.
  socket.setTimeout(JDWP_HANDSHAKE_TIMEOUT_MS, () => socket.destroy(new Error("Debug View 连接超时。")));
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

export async function requestChunk(socket: Socket, reader: SocketReader, id: number, type: string, data: Buffer = Buffer.alloc(0), onTiming?: (waitMs: number, readMs: number, bytes: number) => void) {
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
  const started = performance.now();
  socket.write(packet);

  while (true) {
    const header = await reader.take(11);
    const headerAt = performance.now();
    const length = header.readUInt32BE(0);
    if (length < 11 || length > MAX_PACKET_BYTES) throw new Error("Debug View 返回了无效数据。");
    const payload = await reader.take(length - 11);
    const payloadAt = performance.now();
    if (header[8] !== 0x80 || header.readUInt32BE(4) !== id) continue;
    const errorCode = header.readUInt16BE(9);
    if (errorCode !== 0) throw new Error(`Debug View 请求失败：${errorCode}`);
    if (payload.length < 8) throw new Error("Debug View 返回内容为空。");
    const responseType = payload.subarray(0, 4).toString("ascii");
    const responseLength = payload.readUInt32BE(4);
    if (responseLength !== payload.length - 8) throw new Error("Debug View 返回长度不一致。");
    if (responseType === "FAIL") throw new Error("Android 无法抓取独立控件画面。");
    onTiming?.(headerAt - started, payloadAt - headerAt, responseLength);
    return payload.subarray(8, 8 + responseLength);
  }
}

export async function requestJdwpCommand(socket: Socket, reader: { take(size: number): Promise<Buffer> }, id: number, set: number, operation: number, events: Buffer[], ...parts: Buffer[]) {
  const data = Buffer.concat(parts);
  const packet = Buffer.alloc(11 + data.length);
  packet.writeUInt32BE(packet.length); packet.writeUInt32BE(id, 4);
  packet[9] = set; packet[10] = operation; data.copy(packet, 11); socket.write(packet);
  while (true) {
    const header = await reader.take(11);
    const length = header.readUInt32BE(0);
    if (length < 11 || length > MAX_PACKET_BYTES) throw new Error("Invalid JDWP packet size");
    const payload = await reader.take(length - 11);
    if (header[8] !== 0x80) { events.push(payload); continue; }
    if (header.readUInt32BE(4) !== id) continue;
    if (header.readUInt16BE(9)) throw new Error(`JDWP ${set}/${operation}: ${header.readUInt16BE(9)}`);
    return payload;
  }
}

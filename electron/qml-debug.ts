import { createConnection, type Socket } from "node:net";

const QML_DEBUG_PLUGIN = "QmlDebugger";
const MAX_PACKET_BYTES = 32 * 1024 * 1024;
const MAX_OBJECTS = 20_000;
const PACKET_TIMEOUT_MS = 15_000;
const GEOMETRY_BATCH_SIZE = 200;
const GEOMETRY_EXPRESSION = `typeof this.width === "number" && typeof this.height === "number" ? [
  typeof this.mapToItem === "function" ? this.mapToItem(null, 0, 0).x : (typeof this.x === "number" ? this.x : 0),
  typeof this.mapToItem === "function" ? this.mapToItem(null, 0, 0).y : (typeof this.y === "number" ? this.y : 0),
  this.width,
  this.height,
  typeof this.visible === "boolean" ? this.visible : true,
  typeof this.enabled === "boolean" ? this.enabled : true,
  typeof this.opacity === "number" ? this.opacity : 1,
  typeof this.z === "number" ? this.z : 0,
  typeof this.text === "string" ? this.text : ""
] : null`;

export type QmlGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  enabled: boolean;
  opacity: number;
  z: number;
  text: string;
};

export type QmlDebugNode = {
  debugId: number;
  parentId: number;
  contextId: number;
  type: string;
  idString: string;
  objectName: string;
  url: string;
  line: number;
  column: number;
  geometry: QmlGeometry | null;
  children: QmlDebugNode[];
};

class Reader {
  offset = 0;

  constructor(readonly buffer: Buffer) {}

  get remaining() {
    return this.buffer.length - this.offset;
  }

  private take(size: number) {
    if (size < 0 || this.offset + size > this.buffer.length) throw new Error("收到损坏的 QML 调试数据。");
    const value = this.buffer.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  uint8() {
    return this.take(1)[0];
  }

  int32() {
    const value = this.buffer.readInt32BE(this.offset);
    this.take(4);
    return value;
  }

  uint32() {
    const value = this.buffer.readUInt32BE(this.offset);
    this.take(4);
    return value;
  }

  uint64() {
    const value = this.buffer.readBigUInt64BE(this.offset);
    this.take(8);
    return Number(value);
  }

  float64() {
    const value = this.buffer.readDoubleBE(this.offset);
    this.take(8);
    return value;
  }

  size() {
    const size = this.uint32();
    if (size === 0xffffffff) return -1;
    if (size === 0xfffffffe) return this.uint64();
    return size;
  }

  bytes() {
    const size = this.size();
    return size < 0 ? Buffer.alloc(0) : this.take(size);
  }

  string() {
    const bytes = this.bytes();
    if (bytes.length % 2 !== 0) throw new Error("收到损坏的 QML 字符串。");
    let value = "";
    for (let offset = 0; offset < bytes.length; offset += 2) value += String.fromCharCode(bytes.readUInt16BE(offset));
    return value;
  }

  stringList() {
    const count = this.uint32();
    if (count > MAX_OBJECTS) throw new Error("QML 调试列表过大。");
    return Array.from({ length: count }, () => this.string());
  }
}

function uint32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function int32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function qString(value: string) {
  const content = Buffer.alloc(value.length * 2);
  for (let index = 0; index < value.length; index += 1) content.writeUInt16BE(value.charCodeAt(index), index * 2);
  return Buffer.concat([uint32(content.length), content]);
}

function qBytes(value: Buffer | string) {
  const content = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([uint32(content.length), content]);
}

function qStringList(values: string[]) {
  return Buffer.concat([uint32(values.length), ...values.map(qString)]);
}

function frame(payload: Buffer) {
  const header = Buffer.alloc(4);
  header.writeInt32LE(payload.length + 4);
  return Buffer.concat([header, payload]);
}

class PacketTransport {
  private buffer = Buffer.alloc(0);
  private packets: Buffer[] = [];
  private waiting: ((value: Buffer) => void) | null = null;
  private failure: ((error: Error) => void) | null = null;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readInt32LE(0);
        if (size < 4 || size > MAX_PACKET_BYTES) return this.reject(new Error("QML 调试数据包大小异常。"));
        if (this.buffer.length < size) return;
        this.push(this.buffer.subarray(4, size));
        this.buffer = this.buffer.subarray(size);
      }
    });
    socket.on("error", (error) => this.reject(error));
    socket.on("close", () => this.reject(new Error("QML 调试连接已断开。")));
  }

  static connect(port: number) {
    return new Promise<PacketTransport>((resolve, reject) => {
      const socket = createConnection(port, "127.0.0.1");
      socket.once("connect", () => resolve(new PacketTransport(socket)));
      socket.once("error", reject);
    });
  }

  send(payload: Buffer) {
    this.socket.write(frame(payload));
  }

  read() {
    const packet = this.packets.shift();
    if (packet) return Promise.resolve(packet);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        this.failure = null;
        reject(new Error("QML 调试连接超时。"));
      }, PACKET_TIMEOUT_MS);
      this.waiting = (value) => {
        clearTimeout(timer);
        this.failure = null;
        resolve(value);
      };
      this.failure = (error) => {
        clearTimeout(timer);
        this.waiting = null;
        reject(error);
      };
    });
  }

  close() {
    this.socket.destroy();
  }

  private push(packet: Buffer) {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(packet);
    } else {
      this.packets.push(packet);
    }
  }

  private reject(error: Error) {
    if (!this.failure) return;
    const reject = this.failure;
    this.failure = null;
    reject(error);
  }
}

function pluginPacket(messages: Buffer[]) {
  return Buffer.concat([qString(QML_DEBUG_PLUGIN), ...messages.map(qBytes)]);
}

function request(type: string, queryId: number, ...values: Buffer[]) {
  return Buffer.concat([qBytes(type), uint32(queryId), ...values]);
}

function decodeVariant(reader: Reader): unknown {
  const type = reader.uint32();
  reader.uint8(); // QVariant null marker. The payload format still follows its type.
  switch (type) {
    case 0:
    case 51: return null;
    case 1: return Boolean(reader.uint8());
    case 2: return reader.int32();
    case 3: return reader.uint32();
    case 6: return reader.float64();
    case 9: {
      const count = reader.uint32();
      if (count > MAX_OBJECTS) throw new Error("QML 属性列表过大。");
      return Array.from({ length: count }, () => decodeVariant(reader));
    }
    case 10: return reader.string();
    default: throw new Error(`不支持的 QML 属性类型：${type}`);
  }
}

function objectHeader(reader: Reader): QmlDebugNode {
  return {
    url: reader.bytes().toString(),
    line: reader.int32(),
    column: reader.int32(),
    idString: reader.string(),
    objectName: reader.string(),
    type: reader.string(),
    debugId: reader.int32(),
    contextId: reader.int32(),
    parentId: reader.int32(),
    geometry: null,
    children: [],
  };
}

function objectTree(reader: Reader, budget = { count: 0 }, depth = 0): QmlDebugNode {
  if (depth > 200 || budget.count++ > MAX_OBJECTS) throw new Error("QML 对象树过大。");
  const node = objectHeader(reader);
  const childCount = reader.int32();
  const recursive = Boolean(reader.uint8());
  if (childCount < 0 || childCount > MAX_OBJECTS) throw new Error("QML 子节点数量异常。");
  for (let index = 0; index < childCount; index += 1) {
    node.children.push(recursive ? objectTree(reader, budget, depth + 1) : objectHeader(reader));
  }
  const propertyCount = reader.int32();
  if (propertyCount !== 0) throw new Error("QML 对象树包含未请求的属性。");
  return node;
}

function contextRoots(reader: Reader, roots: QmlDebugNode[], budget = { count: 0 }, depth = 0) {
  if (depth > 200 || budget.count++ > MAX_OBJECTS) throw new Error("QML 上下文树过大。");
  reader.string();
  reader.int32();
  const contextCount = reader.int32();
  for (let index = 0; index < contextCount; index += 1) contextRoots(reader, roots, budget, depth + 1);
  const objectCount = reader.int32();
  for (let index = 0; index < objectCount; index += 1) {
    const node = objectHeader(reader);
    if (node.parentId === -1) roots.push(node);
  }
}

function countTree(root: QmlDebugNode) {
  let count = 0;
  const pending = [root];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    count += 1;
    pending.push(...pending[cursor].children);
  }
  return count;
}

function innerMessages(packet: Buffer) {
  const reader = new Reader(packet);
  const plugin = reader.string();
  if (plugin !== QML_DEBUG_PLUGIN) return [];
  const messages: Buffer[] = [];
  while (reader.remaining > 0) messages.push(reader.bytes());
  return messages;
}

function replyHeader(message: Buffer) {
  const reader = new Reader(message);
  return { type: reader.bytes().toString(), queryId: reader.int32(), reader };
}

async function readReply(transport: PacketTransport, type: string, queryId: number) {
  while (true) {
    for (const message of innerMessages(await transport.read())) {
      const reply = replyHeader(message);
      if (reply.type === type && reply.queryId === queryId) return reply.reader;
    }
  }
}

function geometryFrom(value: unknown): QmlGeometry | null {
  if (!Array.isArray(value) || value.length < 9) return null;
  const [x, y, width, height, visible, enabled, opacity, z, text] = value;
  if (![x, y, width, height].every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  return {
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
    visible: visible !== false,
    enabled: enabled !== false,
    opacity: typeof opacity === "number" ? opacity : 1,
    z: typeof z === "number" ? z : 0,
    text: typeof text === "string" ? text : "",
  };
}

async function populateGeometry(transport: PacketTransport, root: QmlDebugNode, engineId: number, nextId: { value: number }) {
  const nodes: QmlDebugNode[] = [];
  const pending = [root];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    nodes.push(pending[cursor]);
    pending.push(...pending[cursor].children);
  }

  for (let start = 0; start < nodes.length; start += GEOMETRY_BATCH_SIZE) {
    const batch = nodes.slice(start, start + GEOMETRY_BATCH_SIZE);
    const queries = new Map<number, QmlDebugNode>();
    const messages = batch.map((node) => {
      const queryId = nextId.value++;
      queries.set(queryId, node);
      return request("EVAL_EXPRESSION", queryId, int32(node.debugId), qString(GEOMETRY_EXPRESSION), int32(engineId));
    });
    transport.send(pluginPacket(messages));

    while (queries.size > 0) {
      for (const message of innerMessages(await transport.read())) {
        const reply = replyHeader(message);
        if (reply.type !== "EVAL_EXPRESSION_R") continue;
        const node = queries.get(reply.queryId);
        if (!node) continue;
        node.geometry = geometryFrom(decodeVariant(reply.reader));
        queries.delete(reply.queryId);
      }
    }
  }
}

export async function inspectQmlHierarchy(port: number): Promise<QmlDebugNode> {
  const transport = await PacketTransport.connect(port);
  const nextId = { value: 1 };
  try {
    transport.send(Buffer.concat([
      qString("QDeclarativeDebugServer"),
      int32(0),
      int32(1),
      qStringList([QML_DEBUG_PLUGIN]),
      int32(22),
      Buffer.from([1]),
    ]));
    const hello = new Reader(await transport.read());
    if (hello.string() !== "QDeclarativeDebugClient" || hello.int32() !== 0 || hello.int32() !== 1) {
      throw new Error("QML 调试服务握手失败。");
    }
    const plugins = hello.stringList();
    const versionCount = hello.uint32();
    for (let index = 0; index < versionCount; index += 1) hello.float64();
    if (hello.remaining >= 4) hello.int32();
    if (!plugins.includes(QML_DEBUG_PLUGIN)) throw new Error("Debug APK 未启用 QmlDebugger 服务。");

    const engineQuery = nextId.value++;
    transport.send(pluginPacket([request("LIST_ENGINES", engineQuery)]));
    const engineReply = await readReply(transport, "LIST_ENGINES_R", engineQuery);
    const engineCount = engineReply.int32();
    if (engineCount < 1) throw new Error("未找到正在运行的 QML Engine。");
    engineReply.string();
    const engineId = engineReply.int32();

    const objectsQuery = nextId.value++;
    transport.send(pluginPacket([request("LIST_OBJECTS", objectsQuery, int32(engineId))]));
    const objectsReply = await readReply(transport, "LIST_OBJECTS_R", objectsQuery);
    const roots: QmlDebugNode[] = [];
    if (objectsReply.remaining > 0) contextRoots(objectsReply, roots);
    if (roots.length === 0) throw new Error("未找到 QML 顶层对象。");

    const trees: QmlDebugNode[] = [];
    for (const root of roots) {
      const queryId = nextId.value++;
      transport.send(pluginPacket([request("FETCH_OBJECT", queryId, int32(root.debugId), Buffer.from([1, 0]))]));
      const reply = await readReply(transport, "FETCH_OBJECT_R", queryId);
      if (reply.remaining > 0) trees.push(objectTree(reply));
    }
    const root = trees.sort((left, right) => countTree(right) - countTree(left))[0];
    if (!root) throw new Error("未读取到 QML 对象树。");
    await populateGeometry(transport, root, engineId, nextId);
    return root;
  } finally {
    transport.close();
  }
}

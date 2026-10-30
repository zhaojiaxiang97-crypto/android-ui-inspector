import type { Socket } from "node:net";
import { DDMS_COMMAND_SET, DDMS_COMMAND, MAX_PACKET_BYTES, requestJdwpCommand, requestJdwpMetadataBatch, type SocketReader } from "./jdwp-transport";
import { utf16be } from "./view-protocol";

type SessionTiming = { idsMs: number; threadLookupMs: number; boundaryMs: number; metadataMs: number; rootVerifyMs: number; threadNameRequests: number };
export type ViewSessionTarget = { rootRef: string; windowName: string; wakeUi?: () => Promise<void>; hardwareAccelerated?: boolean; metadataBatch?: boolean };

// Internal protocol session shared by the fixed bitmap and font operations. The
// caller owns the connection deadline and must close even when prepare fails.
export function createJdwpViewSession(socket: Socket, reader: SocketReader, hooks: {
  timing?: SessionTiming; onRequests?: (count: number) => void; onFieldRead?: (count: number) => void;
  onPhase?: (phase: string) => void; requireBootstrap?: boolean;
} = {}) {
  let sequence = 10;
  const events: Buffer[] = [];
  const pinned = new Set<Buffer>();
  const timing = hooks.timing ?? { idsMs: 0, threadLookupMs: 0, boundaryMs: 0, metadataMs: 0, rootVerifyMs: 0, threadNameRequests: 0 };
  const int = (value: number) => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; };
  const string = (value: string) => { const b = Buffer.from(value); return Buffer.concat([int(b.length), b]); };
  const command = async (set: number, operation: number, ...parts: Buffer[]) => {
    hooks.onRequests?.(1);
    return requestJdwpCommand(socket, reader, ++sequence, set, operation, events, ...parts);
  };
  const commandBounded = async (maxPayloadBytes: number, set: number, operation: number, ...parts: Buffer[]) => {
    hooks.onRequests?.(1);
    const bounded = { take: async (size: number) => {
      if (size > Math.max(11, maxPayloadBytes)) {
        // An unread oversized frame cannot be reused for cleanup commands.
        socket.destroy();
        throw new Error("JDWP response exceeds read limit");
      }
      return reader.take(size);
    } };
    return requestJdwpCommand(socket, bounded, ++sequence, set, operation, events, ...parts);
  };
  const close = async () => {
    for (const object of pinned) if (!socket.destroyed) await command(9, 8, object).catch(() => undefined);
    // Dispose clears event requests and releases every debugger suspension.
    if (!socket.destroyed) await command(1, 6).catch(() => undefined);
    socket.destroy();
  };
  const prepare = async (target: ViewSessionTarget, firstRef?: string) => {
    let mainThread: Buffer | null = null;
    const idsStarted = performance.now();
    const sizes = await command(1, 7);
    if (sizes.length !== 20 || [0, 4, 8, 12, 16].some((offset) => ![4, 8].includes(sizes.readInt32BE(offset)))) throw new Error("Invalid JDWP ID sizes");
    const fieldSize = sizes.readInt32BE(0), methodSize = sizes.readInt32BE(4), objectSize = sizes.readInt32BE(8), classSize = sizes.readInt32BE(12);
    timing.idsMs = performance.now() - idsStarted;
    const classes = new Map<string, Buffer>();
    const resolveClass = async (signature: string, data: Buffer) => {
      const count = data.length >= 4 ? data.readInt32BE(0) : -1;
      if (count < 1 || count > 32 || data.length !== 4 + count * (1 + classSize + 4)) throw new Error(`Debug class unavailable: ${signature}`);
      let id = data.subarray(5, 5 + classSize);
      if (count > 1 || hooks.requireBootstrap) {
        const bootstrap: Buffer[] = [];
        for (let index = 0; index < count; index++) {
          const candidate = data.subarray(5 + index * (1 + classSize + 4), 5 + index * (1 + classSize + 4) + classSize);
          const loader = await command(2, 2, candidate);
          if (loader.length !== objectSize) throw new Error(`Debug class loader unavailable: ${signature}`);
          if (loader.every(byte => byte === 0)) bootstrap.push(candidate);
        }
        if (bootstrap.length !== 1) throw new Error(`Debug class ambiguous: ${signature}`);
        id = bootstrap[0];
      }
      classes.set(signature, id);
      return id;
    };
    const classFor = async (signature: string) => classes.get(signature) ?? resolveClass(signature, await command(1, 2, string(signature)));
    const members = new Map<string, Map<string, Buffer>>();
    const membersFor = async (classId: Buffer, fields = false, reply?: Buffer) => {
      const key = `${classId.toString("hex")}/${fields ? "fields" : "methods"}`;
      let entries = members.get(key);
      if (!entries) {
        const data = reply ?? await command(2, fields ? 4 : 5, classId);
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
      return entries;
    };
    const memberFor = async (classId: Buffer, name: string, signature: string, fields = false) => {
      const entries = await membersFor(classId, fields);
      const id = entries.get(`${name}:${signature}`);
      if (!id) throw new Error(`Debug ${fields ? "field" : "method"} unavailable: ${name}`);
      return id;
    };
    const methodFor = (classId: Buffer, name: string, signature: string) => memberFor(classId, name, signature);
    const threadsStarted = performance.now();
    const threads = await command(1, 4);
    for (let offset = 4; offset < threads.length; offset += objectSize) {
      const id = threads.subarray(offset, offset + objectSize);
      timing.threadNameRequests++;
      const name = await command(11, 1, id);
      if (name.subarray(4).toString() === "main") { mainThread = id; break; }
    }
    if (!mainThread) throw new Error("Main thread unavailable");
    timing.threadLookupMs = performance.now() - threadsStarted;
    {
      const boundaryStarted = performance.now();
      hooks.onPhase?.("等待主线程消息边界");
      // Stop between UI messages, never in the middle of draw/layout. Arbitrary
      // single-stepping can re-enter a live draw when createSnapshot is invoked.
      const queueClass = await classFor("Landroid/os/MessageQueue;");
      const nextMessage = await methodFor(queueClass, "next", "()Landroid/os/Message;");
      events.length = 0;
      const breakpoint = await command(15, 1, Buffer.from([2, 1]), int(2), Buffer.from([3]), mainThread!, Buffer.from([7, 1]), queueClass, nextMessage, Buffer.alloc(8));
      // Wake a static page without invoking a method on the suspended UI thread.
      if (target.wakeUi) await target.wakeUi();
      else {
        if (target.hardwareAccelerated === false) throw new Error("软件窗口需要新版 SDK 的安全唤醒能力，已停止旧硬件渲染唤醒");
        const wake = Buffer.concat([int(2), ...[target.windowName, firstRef ?? target.rootRef].flatMap((value) => [int(value.length), utf16be(value)])]);
        const wakeReply = await command(DDMS_COMMAND_SET, DDMS_COMMAND, Buffer.from("VUOP"), int(wake.length), wake);
        if (wakeReply.length) throw new Error("无法唤醒当前 Debug 窗口，请重新采集");
      }
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
      timing.boundaryMs = performance.now() - boundaryStarted;
    }
    const valueSize = (tag: number) => {
      const primitive = new Map([[86, 0], [66, 1], [90, 1], [67, 2], [83, 2], [73, 4], [70, 4], [74, 8], [68, 8]]).get(tag);
      if (primitive !== undefined) return primitive;
      if ("[Lstglc".includes(String.fromCharCode(tag))) return objectSize;
      throw new Error("Invalid JDWP value tag");
    };
    const resultValue = (data: Buffer, expectedTag?: string) => {
      if (expectedTag !== undefined && !expectedTag.includes(String.fromCharCode(data[0]))) throw new Error("Invalid JDWP method result type");
      const valueLength = valueSize(data[0]);
      if (data.length !== 2 + valueLength + objectSize) throw new Error("Invalid JDWP method result");
      if (data.subarray(2 + valueLength, 2 + valueLength + objectSize).some((byte) => byte !== 0)) throw new Error("Android bitmap method threw an exception");
      return data.subarray(1, 1 + valueLength);
    };
    const invoke = async (object: Buffer, klass: Buffer, method: Buffer, args: Buffer[] = []) => resultValue(await command(9, 6, object, mainThread!, klass, method, int(args.length), ...args, int(1)));
    // Framework-only reads can bypass application overrides without changing bitmap calls.
    const invokeFramework = async (object: Buffer, klass: Buffer, method: Buffer, expectedTag: string) =>
      resultValue(await command(9, 6, object, mainThread!, klass, method, int(0), int(1 | 2)), expectedTag);
    const invokeStatic = async (klass: Buffer, method: Buffer, args: Buffer[]) => resultValue(await command(3, 3, klass, mainThread!, method, int(args.length), ...args, int(1)));
    const pin = async (object: Buffer) => { await command(9, 7, object); pinned.add(object); return object; };
    const objectArg = (object: Buffer) => Buffer.concat([Buffer.from("L"), object]);
    const integerArg = (value: number) => Buffer.concat([Buffer.from("I"), int(value)]);
    const fieldValues = async (object: Buffer, klass: Buffer, fields: readonly (readonly [string, string])[]) => {
      const ids: Buffer[] = [];
      for (const [name, signature] of fields) ids.push(await memberFor(klass, name, signature, true));
      hooks.onFieldRead?.(ids.length);
      const data = await command(9, 2, object, int(ids.length), ...ids);
      if (data.length < 4 || data.readInt32BE(0) !== fields.length) throw new Error("Invalid JDWP field value");
      const values: Buffer[] = [];
      let offset = 4;
      for (const [, signature] of fields) {
        if (offset >= data.length || data[offset] !== signature.charCodeAt(0)) throw new Error("Invalid JDWP field value");
        const size = valueSize(data[offset++]);
        if (offset + size > data.length) throw new Error("Invalid JDWP field value");
        values.push(data.subarray(offset, offset + size)); offset += size;
      }
      if (offset !== data.length) throw new Error("Invalid JDWP field value");
      return values;
    };
    const fieldValue = async (object: Buffer, klass: Buffer, name: string, signature: string) =>
      (await fieldValues(object, klass, [[name, signature]]))[0];
    const loadClass = async (signature: string) => {
      if (classes.has(signature)) return classFor(signature);
      const klass = await classFor("Ljava/lang/Class;");
      const name = await pin(await command(1, 11, string(signature.slice(1, -1).replace(/\//g, "."))));
      const object = await pin(await invokeStatic(klass, await methodFor(klass, "forName", "(Ljava/lang/String;)Ljava/lang/Class;"), [objectArg(name)]));
      const data = await command(17, 1, object);
      if (data.length !== 1 + classSize || data[0] !== 1) throw new Error("Invalid JDWP reflected class");
      const id = data.subarray(1); classes.set(signature, id); return id;
    };
    const metadataStarted = performance.now();
    const metadataBatch = async (set: number, operation: number, data: Buffer[]) => {
      hooks.onRequests?.(data.length);
      return requestJdwpMetadataBatch(socket, reader, data.map(data => ({ id: ++sequence, set, operation, data })), events);
    };
    const signatures = ["Landroid/view/View;", "Landroid/view/ViewDebug;", "Landroid/view/WindowManagerGlobal;"];
    const missing = signatures.filter(signature => !classes.has(signature));
    // Keep the serial path as the product default until broader paired evidence
    // proves a useful gain. The diagnostic probe explicitly opts into batching.
    if (target.metadataBatch === true && missing.length) {
      const replies = await metadataBatch(1, 2, missing.map(string));
      for (let i = 0; i < missing.length; i++) await resolveClass(missing[i], replies[i]);
    }
    const viewClass = await classFor("Landroid/view/View;");
    const debugClass = await classFor("Landroid/view/ViewDebug;");
    const methodClasses = target.metadataBatch !== true ? [] : [debugClass, classes.get("Landroid/view/WindowManagerGlobal;")!].filter(id => !members.has(`${id.toString("hex")}/methods`));
    if (methodClasses.length) {
      const replies = await metadataBatch(2, 5, methodClasses);
      for (let i = 0; i < methodClasses.length; i++) await membersFor(methodClasses[i], false, replies[i]);
    }
    const findMethod = await methodFor(debugClass, "findView", "(Landroid/view/View;Ljava/lang/String;)Landroid/view/View;");
    // Use the exact DDMS window, not a heap-wide Instances scan (which forces GC).
    const windowsClass = await classFor("Landroid/view/WindowManagerGlobal;");
    const getInstance = await methodFor(windowsClass, "getInstance", "()Landroid/view/WindowManagerGlobal;");
    const getRoot = await methodFor(windowsClass, "getRootView", "(Ljava/lang/String;)Landroid/view/View;");
    timing.metadataMs = performance.now() - metadataStarted;
    const rootVerifyStarted = performance.now();
    const windows = await pin(await invokeStatic(windowsClass, getInstance, []));
    const windowName = await pin(await command(1, 11, string(target.windowName)));
    const rootObject = await invoke(windows, windowsClass, getRoot, [objectArg(windowName)]);
    if (rootObject.every((byte) => byte === 0)) throw new Error("Debug 窗口已关闭，请重新采集");
    await pin(rootObject);
    const rootName = await pin(await command(1, 11, string(target.rootRef)));
    if (!rootObject.equals(await invokeStatic(debugClass, findMethod, [objectArg(rootObject), objectArg(rootName)]))) throw new Error("Debug 窗口身份已变化，请重新采集");
    timing.rootVerifyMs = performance.now() - rootVerifyStarted;
    return { objectSize, classSize, classes, resolveClass, classFor, members, membersFor, memberFor, methodFor,
      mainThread, command, commandBounded, metadataBatch, pinned, pin, int, string, objectArg, integerArg,
      resultValue, invoke, invokeFramework, invokeStatic, fieldValues, fieldValue, loadClass,
      viewClass, debugClass, findMethod, rootObject };
  };
  return { prepare, close };
}

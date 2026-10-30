// Explicit one-shot diagnostic primitive. No device connection or pause on import.
import { createRequire } from "node:module";
const { withSuspendedMain } = createRequire(import.meta.url)("./lib/startup-stack-observer.cjs") as {
  withSuspendedMain: (request: Request, main: Buffer, frames: () => Promise<Frame[]>, evidence: StackEvidence,
    beforeSuspend?: () => void | Promise<void>) => Promise<Frame[]>;
};
type Request = (set: number, command: number, data?: Buffer) => Promise<Buffer>;
export type StackEvidence = { suspendRequested?: boolean; suspendSent?: boolean; resumeVerified?: boolean; pauseMs?: number;
  resumeError?: string; disposeAcknowledged?: boolean; disposeError?: string };
export type Frame = { frameId: string; tag: number; classId: string; methodId: string; codeIndex: string };
function integer(reply: Buffer) {
  if (reply.length !== 4 || reply.readInt32BE() < 0) throw Error("Invalid JDWP integer reply");
  return reply.readInt32BE();
}

/** Run before subscribing/capturing. Transport must bound every request (including recovery).
 * Lookup is read-only and limited to 128 threads / 3 seconds; no lazy lookup while main is paused.
 */
export async function prepareMainStack(request: Request, signal: AbortSignal,
  now: () => number = () => Math.floor(performance.now())) {
  const deadline = now() + 3000;
  const read = async (set: number, command: number, data?: Buffer) => {
    signal.throwIfAborted();
    if (now() >= deadline) throw Error("JDWP preparation deadline exceeded");
    const result = await request(set, command, data);
    signal.throwIfAborted();
    if (now() >= deadline) throw Error("JDWP preparation deadline exceeded");
    return result;
  };
  const sizes = await read(1, 7);
  if (sizes.length !== 20) throw Error("Invalid JDWP ID sizes");
  const values = Array.from({ length: 5 }, (_, i) => sizes.readInt32BE(i * 4));
  if (values.some(n => n !== 4 && n !== 8)) throw Error("Unsupported JDWP ID sizes");
  const [, methodSize, objectSize, classSize, frameSize] = values;
  const threads = await read(1, 4);
  if (threads.length < 4) throw Error("Invalid JDWP thread reply");
  const count = threads.readInt32BE();
  if (count < 1 || count > 128 || threads.length !== 4 + count * objectSize) throw Error("Invalid JDWP thread count");
  let main: Buffer | undefined;
  for (let i = 0; i < count; i++) {
    const id = threads.subarray(4 + i * objectSize, 4 + (i + 1) * objectSize);
    const name = await read(11, 1, id);
    if (name.length < 4 || name.length > 1028 || name.readUInt32BE() !== name.length - 4) throw Error("Invalid JDWP thread name");
    if (name.subarray(4).toString() === "main") { main = Buffer.from(id); break; }
  }
  if (!main) throw Error("JDWP main thread unavailable");
  const mainId = main;
  let attempted = false;
  let captured: Frame[] | undefined;
  let rawFrames: Frame[] = [];
  return {
    rawFrames: () => rawFrames.map(frame => ({ ...frame })),
    async sample(beforeSuspend: () => void | Promise<void>, evidence: StackEvidence) {
      if (attempted) throw Error("Main stack already attempted");
      attempted = true;
      signal.throwIfAborted();
      const frames = await withSuspendedMain(request, mainId, async () => {
        signal.throwIfAborted();
        const total = integer(await request(11, 7, mainId));
        signal.throwIfAborted();
        if (!total) throw Error("No main frames available");
        const length = Math.min(total, 32), range = Buffer.alloc(8);
        range.writeInt32BE(length, 4);
        const reply = await request(11, 6, Buffer.concat([mainId, range]));
        signal.throwIfAborted();
        const stride = frameSize + 1 + classSize + methodSize + 8;
        if (reply.length < 4) throw Error("Invalid JDWP frames");
        const count = reply.readInt32BE();
        if (count < 1 || count > length || reply.length !== 4 + count * stride) throw Error("Invalid JDWP frames");
        const frames: Frame[] = []; let at = 4;
        const hex = (n: number) => { const s = reply.subarray(at, at + n).toString("hex"); at += n; return s; };
        for (let i = 0; i < count; i++) {
          const frameId = hex(frameSize), tag = reply[at++];
          if (![1, 2, 3].includes(tag)) throw Error("Invalid JDWP location tag");
          frames.push({ frameId, tag, classId: hex(classSize), methodId: hex(methodSize), codeIndex: hex(8) });
        }
        rawFrames = frames.map(frame => ({ ...frame }));
        return frames;
      }, evidence, async () => {
        signal.throwIfAborted();
        await beforeSuspend();
        signal.throwIfAborted();
      });
      captured = frames.map(frame => ({ ...frame }));
      return frames;
    },
    /** Only available after this sampler has successfully verified resume. No business invocation. */
    async resolveFrames() {
      if (!captured) throw Error("Verified frame sample required before symbols");
      const deadline = now() + 2000;
      const read = async (command: number, id: Buffer) => {
        signal.throwIfAborted();
        if (now() >= deadline) throw Error("JDWP symbol deadline exceeded");
        const reply = await request(2, command, id);
        signal.throwIfAborted();
        if (now() >= deadline || reply.length > 1024 * 1024) throw Error("JDWP symbol deadline or size exceeded");
        return reply;
      };
      const parse = (buffer: Buffer) => {
        let at = 0;
        const bytes = (n: number) => {
          if (n < 0 || at + n > buffer.length) throw Error("Short JDWP symbol reply");
          const b = buffer.subarray(at, at + n); at += n; return b;
        };
        const number = () => bytes(4).readInt32BE();
        const string = () => { const n = number(); if (n < 0 || n > 1024) throw Error("Invalid JDWP symbol length"); return bytes(n).toString(); };
        return { bytes, number, string, done: () => { if (at !== buffer.length) throw Error("Trailing JDWP symbol reply"); } };
      };
      const classes = new Map<string, { className: string; methods: Map<string, { name: string; signature: string }> }>();
      const result = [];
      for (const frame of captured) {
        if (!classes.has(frame.classId)) {
          const id = Buffer.from(frame.classId, "hex"), signature = parse(await read(1, id));
          const className = signature.string(); signature.done();
          const reader = parse(await read(5, id)), count = reader.number();
          if (count < 0 || count > 2048) throw Error("JDWP method count exceeded");
          const methods = new Map<string, { name: string; signature: string }>();
          for (let i = 0; i < count; i++) {
            const methodId = reader.bytes(methodSize).toString("hex"), name = reader.string(), signature = reader.string();
            reader.number();
            if (methods.has(methodId)) throw Error("Duplicate JDWP method ID");
            methods.set(methodId, { name, signature });
          }
          reader.done(); classes.set(frame.classId, { className, methods });
        }
        const value = classes.get(frame.classId)!;
        result.push({ ...frame, className: value.className, method: value.methods.get(frame.methodId) ?? null });
      }
      return result;
    },
  };
}

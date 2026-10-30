import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { createServer, createConnection, type Socket } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createQueueBusinessProbe, validateQueueBusinessArgs } from "../scripts/diagnostics/sdk/sdk-queue-business-probe";
import { readDiagnosticIdentity } from "../scripts/diagnostics/sdk/sdk-queue-bootstrap";
import { createQueueDeviceAdapters } from "../scripts/diagnostics/sdk/sdk-queue-device";
import type { ObservationTarget } from "../scripts/diagnostics/sdk/sdk-queue-observation";
import type { QueueEvent } from "../scripts/diagnostics/sdk/sdk-queue-observer";

type Dependencies = NonNullable<Parameters<typeof createQueueBusinessProbe>[1]>;
type Device = ReturnType<typeof createQueueDeviceAdapters>;
const target = { serial: "fixture", packageName: "example.app", pid: 42, startTicks: "12345",
  apkPath: "/trusted/business.apk", aarPath: "/trusted/sdk.aar" };
const processInstance = "22222222-2222-2222-2222-222222222222";
const build = { apkSha256: "a".repeat(64), aarSha256: "c".repeat(64), sourceSha256: "b".repeat(64),
  sdkVersion: `sdk-source-v1:${"b".repeat(64)}` };
const installed = { apkSha256: build.apkSha256, installedPath: "/data/app/fixture/base.apk" };
const int = (n: number) => { const data = Buffer.alloc(4); data.writeInt32BE(n); return data; };
const string = (s: string) => Buffer.concat([int(Buffer.byteLength(s)), Buffer.from(s)]);
const reply = (nonce: string) => `Result: Bundle[{result=ok, protocol=sdk-diagnostic-identity-v1, nonce=${nonce}, pid=42, processInstance=${processInstance}, sourceSha256=${build.sourceSha256}}]`;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const events: string[] = [], parent = new AbortController(), capture = deferred<void>();
  const devices: Device[] = [], targets: ObservationTarget[] = [];
  let stateReads = 0, captureCalls = 0, suspended = 0, hostMs = 110;
  let patch: ((set: number, command: number) => void) | undefined;
  const event = (actual: Pick<ObservationTarget, "requestId" | "pid" | "processInstance">, change: Partial<QueueEvent> = {}): QueueEvent => ({
    event: "tree-queue", protocol: "tree-queue-v1", phase: "state", kind: "classic", requestId: actual.requestId,
    pid: actual.pid, processInstance: actual.processInstance, postedMs: 100000, observedMs: 100620,
    enteredMs: -1, endedMs: -1, settledMs: -1, ...change,
  });
  const request = async (set: number, command: number, data?: Buffer) => {
    events.push(`jdwp:${set}/${command}`);
    if (set === 11 && command === 2) suspended++;
    if (set === 11 && command === 3) suspended--;
    if (set === 1 && command === 6) suspended = 0;
    patch?.(set, command);
    if (set === 1 && command === 7) return Buffer.concat(Array(5).fill(int(4)));
    if (set === 1 && command === 4) return Buffer.concat([int(1), int(7)]);
    if (set === 11 && command === 1) return string("main");
    if (set === 11 && command === 12) return int(suspended);
    if (set === 11 && command === 7) return int(100);
    if (set === 11 && command === 6) {
      assert.equal(data?.readInt32BE(8), 32);
      return Buffer.concat([int(1), int(9), Buffer.from([1]), int(10), int(11), Buffer.alloc(8)]);
    }
    if (set === 2 && command === 1) return string("Lexample/Initializer;");
    if (set === 2 && command === 5) return Buffer.concat([int(1), int(11), string("wait"), string("()V"), int(1)]);
    return Buffer.alloc(0);
  };
  const dependencies: Dependencies = {
    bootstrap: {
      verifyLocal: async () => { events.push("bootstrap-local"); return { ...build }; },
      verifyInstalled: async () => { events.push("bootstrap-installed"); return { ...installed }; },
      verifyProcess: async () => { events.push("bootstrap-process"); return { pid: 42, startTicks: "12345" }; },
      readIdentity: (query, signal) => readDiagnosticIdentity(query, signal, async args => {
        events.push("identity-query"); assert.equal(args[args.indexOf("--method") + 1], "read-diagnostic-identity");
        return reply(query.nonce);
      }),
    },
    device: (actual, role) => {
      events.push(`create-${role}`); targets.push(actual); let closed = false;
      const device: Device = {
        prepareCapture: async (selected, signal) => {
          assert.deepEqual(selected, actual); signal.throwIfAborted(); events.push(`prepare-${role}`);
        },
        closeCapture: async () => { if (!closed) { events.push(`close-${role}`); closed = true; } },
        forward: {
          open: async () => { events.push("jdwp-open"); return 12345; },
          remove: async port => { assert.equal(port, 12345); events.push("jdwp-remove"); },
          connect: () => ({ ready: Promise.resolve(), request, close: () => { events.push("jdwp-close"); } }),
        },
        readRuntime: async selected => {
          assert.equal(role, "reader"); assert.equal(selected.processInstance, processInstance);
          events.push("runtime-reader"); return { pid: 42, processInstance, sdkVersion: build.sdkVersion };
        },
        readState: async selected => {
          assert.equal(role, "reader"); assert.equal(selected.identity.requestId, actual.requestId);
          events.push("state-reader");
          if (++stateReads === 1) return event(actual);
          if (stateReads === 2) { capture.resolve(); return event(actual, { observedMs: 100700 }); }
          return event(actual, { observedMs: 103100, enteredMs: 100800, endedMs: 100900, settledMs: 103000 });
        },
        captureOnce: async (selected, options, signal) => {
          assert.equal(role, "capture"); assert.equal(selected.requestId, actual.requestId);
          assert.equal(options.identity.requestId, actual.requestId); assert.equal(options.treeQueueDiagnostics, true);
          captureCalls++; events.push("capture-once");
          const abort = () => capture.reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          try { await capture.promise; } finally { signal.removeEventListener("abort", abort); }
        },
      };
      devices.push(device); return device;
    },
    observation: {
      now: () => hostMs,
      artifacts: async () => { events.push("observation-local"); return { ...build }; },
      installed: async () => { events.push("observation-installed"); return { ...installed }; },
      process: async () => { events.push("observation-process"); return { pid: 42, startTicks: "12345" }; },
      subscribe: async actual => {
        events.push("subscribe"); return { json: JSON.stringify(event(actual.identity, { phase: "queued", observedMs: 100600 })), receivedHostMs: 100 };
      },
    },
  };
  return { dependencies, events, devices, targets, parent, capture, event, request,
    patchRequest: (fn: typeof patch) => { patch = fn; }, advance: (ms: number) => { hostMs = ms; },
    count: () => ({ captureCalls, suspended }), create: () => createQueueBusinessProbe(target, dependencies) };
}
function clean(f: ReturnType<typeof fixture>) {
  assert.equal(f.count().suspended, 0);
  assert.ok(f.count().captureCalls <= 1);
  assert.equal(getEventListeners(f.parent.signal, "abort").length, 0);
}

test("explicit arguments require run, a pinned existing process and absolute trusted artifacts", () => {
  const args = [target.serial, target.packageName, "42", "12345", target.apkPath, target.aarPath, "--run"];
  assert.deepEqual(validateQueueBusinessArgs(args), target);
  for (const bad of [args.slice(0, -1), [...args, "extra"], args.map((v, i) => i === 6 ? "--launch" : v),
    args.map((v, i) => i === 2 ? "0042" : v), args.map((v, i) => i === 3 ? "0" : v),
    args.map((v, i) => i === 1 ? "bad" : v), args.map((v, i) => i === 4 ? "relative.apk" : v)])
    assert.throws(() => validateQueueBusinessArgs(bad));
  assert.throws(() => createQueueBusinessProbe(target, { timeoutMs: 15001 }), /budget/);
});

test("business entry bootstraps without a tree, binds one fresh request and uses separate reader/capture", async () => {
  const f = fixture(), entry = f.create(); assert.equal(f.events.length, 0);
  const report = await entry.run(f.parent.signal);
  assert.equal(report.status, "queue-covered"); assert.equal(report.observation?.frames.length, 1);
  assert.deepEqual(report.attempts, { bootstrap: 1, preparatoryTree: 0, captureCalls: 1 });
  assert.equal(report.bootstrap?.processInstance, processInstance); assert.equal(f.targets.length, 2);
  assert.equal(f.targets[0], f.targets[1]); assert.ok(Object.isFrozen(f.targets[0]));
  assert.match(report.target!.requestId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.ok(f.events.indexOf("identity-query") < f.events.indexOf("prepare-reader"));
  assert.ok(f.events.indexOf("prepare-reader") < f.events.indexOf("prepare-capture"));
  assert.ok(f.events.indexOf("subscribe") < f.events.indexOf("capture-once"));
  assert.ok(f.events.indexOf("jdwp:11/3") < f.events.lastIndexOf("state-reader"));
  assert.equal(f.events.at(-1), "close-reader");
  assert.equal(f.events.filter(v => v === "capture-once").length, 1);
  assert.deepEqual(report.cleanup, { captureConnectionClosed: true, readerConnectionClosed: true });
  await assert.rejects(entry.run(f.parent.signal), /consumed/); clean(f);
});

test("old SDK, wrong source, changed process or pre-cancel cannot create a connection or issue capture", async () => {
  for (const failure of ["old-sdk", "source", "process", "cancel"]) {
    const f = fixture();
    if (failure === "old-sdk") f.dependencies.bootstrap!.readIdentity = (query, signal) =>
      readDiagnosticIdentity(query, signal, async () => "Result: Bundle[{error=unsupported}]");
    if (failure === "source") f.dependencies.bootstrap!.verifyLocal = async () => ({ ...build, sourceSha256: "unknown" });
    if (failure === "process") f.dependencies.bootstrap!.verifyProcess = async () => ({ pid: 99, startTicks: "12345" });
    if (failure === "cancel") f.parent.abort(Error("cancelled before run"));
    const entry = f.create(), report = await entry.run(f.parent.signal);
    assert.equal(report.status, "identity-failed"); assert.equal(report.target, undefined);
    assert.equal(f.devices.length, 0); assert.equal(report.attempts.captureCalls, 0);
    await assert.rejects(entry.run(new AbortController().signal), /consumed/); clean(f);
  }
});

test("identity command failures retain bounded exit evidence without retry or new resources", async () => {
  for (const failure of [
    Object.assign(Error("identity command failed"), { code: 1, killed: false, signal: null, stdout: "", stderr: "Permission denied" }),
    Object.assign(Error("identity command interrupted"), { code: null, killed: true, signal: "SIGTERM", stdout: Buffer.from("partial reply"), stderr: Buffer.alloc(0) }),
    Object.assign(Error("identity command output exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "a".repeat(5000), stderr: "b".repeat(5000) }),
    Object.assign(Error("unknown identity failure"), { code: {}, killed: "true", signal: 9, stdout: 42, stderr: { secret: "must not serialize" } }),
  ]) {
    const f = fixture(); let queries = 0;
    f.dependencies.bootstrap!.readIdentity = async () => { queries++; throw failure; };
    const entry = f.create(), report = await entry.run(f.parent.signal);
    assert.equal(report.status, "identity-failed"); assert.equal(report.error, failure.message);
    assert.equal(queries, 1); assert.equal(f.devices.length, 0); assert.equal(report.attempts.captureCalls, 0);
    const details = report.errorDetails;
    if (failure.message.includes("unknown")) assert.equal(details, undefined);
    else if (failure.message.includes("exceeded")) assert.deepEqual(details, {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "a".repeat(4096), stderr: "b".repeat(4096), outputTruncated: true,
    });
    else if (failure.message.includes("interrupted")) assert.deepEqual(details, {
      code: null, killed: true, signal: "SIGTERM", stdout: "partial reply", stderr: "",
    });
    else assert.deepEqual(details, { code: 1, killed: false, signal: null, stdout: "", stderr: "Permission denied" });
    const saved = JSON.stringify(report);
    (failure as any).stdout = "late mutation";
    assert.equal(JSON.stringify(report), saved);
    await assert.rejects(entry.run(new AbortController().signal), /consumed/); clean(f);
  }
});

test("completed but invalid identity replies preserve command evidence and never create SDK or JDWP resources", async () => {
  for (const large of [false, true]) {
    const f = fixture(); let queries = 0;
    const output = { stdout: large ? "x".repeat(5000) : "", stderr: large ? "y".repeat(5000) : "Error while accessing provider" };
    f.dependencies.bootstrap!.readIdentity = (query, signal) => readDiagnosticIdentity(query, signal, async () => {
      queries++; return output;
    });
    const entry = f.create(), report = await entry.run(f.parent.signal);
    assert.equal(report.status, "identity-failed"); assert.equal(queries, 1);
    assert.equal(report.errorDetails?.code, 0); assert.equal(report.errorDetails?.killed, false);
    assert.equal(report.errorDetails?.signal, null);
    assert.equal(report.errorDetails?.stdout, output.stdout.slice(0, 4096));
    assert.equal(report.errorDetails?.stderr, output.stderr.slice(0, 4096));
    if (large) assert.equal(report.errorDetails?.outputTruncated, true);
    assert.equal(report.attempts.captureCalls, 0); assert.equal(f.devices.length, 0);
    await assert.rejects(entry.run(new AbortController().signal), /consumed/); clean(f);
  }
});

test("real local child-process exit and timeout survive identity failure reports; no adb", async () => {
  for (const timeout of [false, true]) {
    const f = fixture(); let original: any;
    f.dependencies.bootstrap!.readIdentity = async () => {
      try {
        await promisify(execFile)(process.execPath, ["-e", timeout ? "setInterval(() => {}, 1000)"
          : "process.stdout.write('partial'); process.stderr.write('denied'); process.exit(7)"], {
          timeout: timeout ? 200 : 2000, encoding: "utf8", maxBuffer: 4096,
        });
      } catch (error) { original = error; throw error; }
      throw Error("Child unexpectedly succeeded");
    };
    const report = await f.create().run(f.parent.signal);
    assert.ok(original); assert.equal(report.status, "identity-failed");
    const details = report.errorDetails;
    assert.ok(details); assert.equal(details.killed, original.killed); assert.equal(details.signal, original.signal);
    assert.equal(details.code, original.code);
    assert.equal(details.stdout, original.stdout); assert.equal(details.stderr, original.stderr);
    if (timeout) { assert.equal(details.killed, true); assert.equal(details.signal, "SIGTERM"); }
    else { assert.equal(details.code, 7); assert.equal(details.stdout, "partial"); assert.equal(details.stderr, "denied"); }
    assert.equal(f.devices.length, 0); assert.equal(report.attempts.captureCalls, 0); clean(f);
  }
});

test("cancel/deadline during an uncooperative identity read returns boundedly and ignores the late reply", async () => {
  for (const timeout of [false, true]) {
    const f = fixture(), pending = deferred<Awaited<ReturnType<typeof readDiagnosticIdentity>>>();
    f.dependencies.bootstrap!.readIdentity = async () => {
      f.events.push("identity-pending"); if (!timeout) f.parent.abort(Error("identity cancelled")); return pending.promise;
    };
    if (timeout) f.dependencies.timeoutMs = 20;
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, "identity-failed"); assert.match(report.error ?? "", timeout ? /deadline/ : /cancelled/);
    const saved = JSON.stringify(report);
    pending.resolve({ pid: 42, processInstance, sdkVersion: build.sdkVersion, sourceSha256: build.sourceSha256 });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(JSON.stringify(report), saved); assert.equal(f.devices.length, 0); clean(f);
  }
});

test("reader/capture setup failures clean only owned resources and never issue a diagnostic request", async () => {
  for (const role of ["reader", "capture"] as const) {
    const f = fixture(), create = f.dependencies.device!;
    f.dependencies.device = (actual, selected) => {
      const device = create(actual, selected);
      if (selected === role) device.prepareCapture = async () => { throw Error(`${role} setup failure`); };
      return device;
    };
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, "observation-failed"); assert.match(report.error ?? "", /setup failure/);
    assert.equal(report.attempts.captureCalls, 0); assert.equal(f.events.includes("subscribe"), false);
    assert.equal(report.cleanup.readerConnectionClosed, true);
    if (role === "capture") assert.equal(report.cleanup.captureConnectionClosed, true);
    clean(f);
  }
});

test("cancellation during reader resource setup waits for its bounded teardown before returning", async () => {
  const f = fixture(), setup = deferred<void>(), entered = deferred<void>(), create = f.dependencies.device!;
  f.dependencies.device = (actual, role) => {
    const device = create(actual, role);
    if (role === "reader") device.prepareCapture = async () => { entered.resolve(); await setup.promise; };
    return device;
  };
  let returned = false;
  const pending = f.create().run(f.parent.signal).then(report => { returned = true; return report; });
  await entered.promise; f.parent.abort(Error("cancel during setup"));
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(returned, false);
  setup.resolve(); const report = await pending;
  assert.equal(report.status, "observation-failed"); assert.match(report.error ?? "", /cancel during setup/);
  assert.equal(report.attempts.captureCalls, 0); assert.equal(f.devices.length, 1);
  assert.equal(report.cleanup.readerConnectionClosed, true); clean(f);
});

test("one adapter cannot be reused as both scalar reader and capture client", async () => {
  const f = fixture(), create = f.dependencies.device!; let shared: Device | undefined;
  f.dependencies.device = (actual, role) => shared ??= create(actual, role);
  const report = await f.create().run(f.parent.signal);
  assert.equal(report.status, "observation-failed"); assert.match(report.error ?? "", /Independent/);
  assert.equal(report.attempts.captureCalls, 0); assert.equal(f.events.includes("subscribe"), false); clean(f);
});

test("changed artifact bytes or installed path after bootstrap refuse observation before capture/JDWP", async () => {
  for (const change of ["apk", "aar", "source", "installed-path", "process"]) {
    const f = fixture();
    if (change === "apk") f.dependencies.observation!.artifacts = async () => ({ ...build, apkSha256: "d".repeat(64) });
    if (change === "aar") f.dependencies.observation!.artifacts = async () => ({ ...build, aarSha256: "d".repeat(64) });
    if (change === "source") f.dependencies.observation!.artifacts = async () => ({ ...build, sourceSha256: "d".repeat(64) });
    if (change === "installed-path") f.dependencies.observation!.installed = async () => ({ ...installed, installedPath: "/data/app/replaced/base.apk" });
    if (change === "process") f.dependencies.observation!.process = async () => ({ pid: 99, startTicks: "12345" });
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, "observation-failed"); assert.match(report.error ?? "", /changed/);
    assert.equal(report.attempts.captureCalls, 0); assert.equal(f.events.includes("jdwp-open"), false); clean(f);
  }
});

test("expired or already-entered task cannot suspend; failed capture remains in the report", async () => {
  for (const failure of ["stale", "entered", "capture"]) {
    const f = fixture(), create = f.dependencies.device!;
    f.dependencies.device = (actual, role) => {
      const device = create(actual, role);
      if (role === "reader" && failure !== "capture") device.readState = async () => {
        if (failure === "stale") f.advance(400);
        return f.event(actual, failure === "entered" ? { enteredMs: 100610 } : {});
      };
      return device;
    };
    if (failure === "capture") f.capture.reject(Error("SDK tree timeout"));
    const report = await f.create().run(f.parent.signal);
    if (failure === "capture") assert.equal(report.observation?.capture?.status, "failed");
    else { assert.equal(report.status, "no-stack"); assert.equal(f.events.includes("jdwp:11/2"), false); }
    assert.equal(report.cleanup.readerConnectionClosed, true); clean(f);
  }
});

test("cancellation during paused frames restores before closing both SDK clients and preserves one request", async () => {
  const f = fixture(); f.patchRequest((set, command) => {
    if (set === 11 && command === 6) f.parent.abort(Error("cancelled during frames"));
  });
  const report = await f.create().run(f.parent.signal);
  assert.equal(report.status, "observation-failed"); assert.equal(report.observation?.cleanup.resumeVerified, true);
  assert.ok(f.events.indexOf("jdwp:11/3") < f.events.indexOf("close-capture"));
  assert.ok(f.events.indexOf("jdwp:11/3") < f.events.indexOf("close-reader"));
  assert.equal(report.attempts.captureCalls, 1); clean(f);
});

test("reader cleanup failure cannot retain a successful diagnostic status or hide the inner report", async () => {
  const f = fixture(), create = f.dependencies.device!;
  f.dependencies.device = (actual, role) => {
    const device = create(actual, role);
    if (role === "reader") device.closeCapture = async () => { throw Error("reader close unconfirmed"); };
    return device;
  };
  const report = await f.create().run(f.parent.signal);
  assert.equal(report.observation?.status, "queue-covered"); assert.equal(report.status, "observation-failed");
  assert.equal(report.cleanup.readerConnectionClosed, false); assert.match(report.cleanup.readerError ?? "", /unconfirmed/);
  assert.equal(report.cleanup.captureConnectionClosed, true); clean(f);
});

test("capture or JDWP cleanup failure still closes the scalar reader and cannot report coverage", async () => {
  for (const failure of ["capture", "jdwp"]) {
    const f = fixture(), create = f.dependencies.device!; let removals = 0;
    f.dependencies.device = (actual, role) => {
      const device = create(actual, role);
      if (role === "capture" && failure === "capture") device.closeCapture = async () => { throw Error("capture close unconfirmed"); };
      if (role === "capture" && failure === "jdwp") device.forward.remove = async () => {
        removals++; throw Error("JDWP forward removal unconfirmed");
      };
      return device;
    };
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(report.cleanup.readerConnectionClosed, true);
    if (failure === "capture") assert.equal(report.cleanup.captureConnectionClosed, false);
    else {
      assert.equal(removals, 1); assert.notEqual(report.observation?.cleanup.forwardRemoved, true);
      assert.match(report.observation?.cleanup.forwardError ?? "", /unconfirmed/);
    }
    assert.equal(report.observation?.cleanup.resumeVerified, true); clean(f);
  }
});

test("business composition uses two production SDK TCP clients and owned forwards without a preparatory tree", async () => {
  const f = fixture(), requests: Array<{ method: string; arg: string | null; extras: Record<string, unknown> }> = [];
  const sockets = new Set<Socket>(), mappings = new Map<number, string>(), commands: string[][] = [];
  let readCount = 0, tcpPort = 0, port = 12000, activeTarget: ObservationTarget | undefined;
  let captureSocket: Socket | undefined, maxClients = 0;
  const server = createServer(socket => {
    sockets.add(socket); maxClients = Math.max(maxClients, sockets.size); socket.setEncoding("utf8");
    socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer = "";
    socket.on("data", data => {
      buffer += data; let at: number;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); requests.push(request);
        if (request.method === "session-probe") socket.write("Result: Bundle[{error=Unknown session method}]\n");
        else if (request.method === "read-sdk-build") socket.write(`Result: Bundle[{result=ok, protocol=sdk-source-v1, sourceSha256=${build.sourceSha256}, pid=42, processInstance=${processInstance}}]\n`);
        else if (request.method === "read-tree-task") {
          assert.ok(activeTarget);
          const state = ++readCount === 1 ? f.event(activeTarget) : readCount === 2
            ? f.event(activeTarget, { observedMs: 100700 })
            : f.event(activeTarget, { observedMs: 103100, enteredMs: 100800, endedMs: 100900, settledMs: 103000 });
          socket.write(`Result: Bundle[{result=ok, diagnostic=${JSON.stringify(state)}}]\n`);
          if (readCount === 2) captureSocket!.write("Result: Bundle[{result=ok}]\n");
        } else if (request.method === "capture") captureSocket = socket;
        else assert.fail(`unexpected SDK request ${request.method}`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); tcpPort = address.port;
  f.dependencies.device = (actual, role) => {
    activeTarget = actual;
    const adapter = createQueueDeviceAdapters(actual, {
      choosePort: async () => ++port,
      connect: () => createConnection({ host: "127.0.0.1", port: tcpPort }),
      execute: async args => {
        commands.push(args);
        if (args.includes("open-session")) return "Result: Bundle[{result=ok, socket=example.app.inspector.session}]";
        assert.equal(args[2], "forward");
        if (args[3] === "--list") return [...mappings].map(([p, remote]) => `fixture tcp:${p} ${remote}`).join("\n");
        if (args[3] === "--remove") { mappings.delete(Number(args[4].slice(4))); return ""; }
        const at = args[3] === "--no-rebind" ? 4 : 3;
        mappings.set(Number(args[at].slice(4)), args[at + 1]); return "";
      },
    });
    if (role === "capture") adapter.forward.connect = () => ({ ready: Promise.resolve(), request: f.request, close: () => {} });
    return adapter;
  };
  try {
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, "queue-covered"); assert.equal(report.attempts.preparatoryTree, 0);
    assert.equal(requests.filter(request => request.method === "capture").length, 1);
    assert.equal(maxClients, 2); assert.equal(mappings.size, 0);
    assert.ok(requests.filter(request => request.method !== "session-probe").every(request => request.extras.processInstance === processInstance));
    assert.ok(commands.every(args => args.includes("open-session") || args[2] === "forward"));
    assert.equal(report.cleanup.readerConnectionClosed, true); assert.equal(report.cleanup.captureConnectionClosed, true);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(sockets.size, 0); clean(f);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

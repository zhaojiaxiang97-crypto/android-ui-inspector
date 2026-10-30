import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createCaptureAttemptContext, createCaptureRunContext, withCaptureSignal, notifyViewTreeReady, type CaptureRunContext } from "../electron/capture/run-context";
import { makeNode } from "../benchmarks/fixtures";
import { readSdkCapture } from "../electron/capture/sdk-images";
import type { InspectionOptions } from "../electron/capture/types";
import { commandSignal, withCommandSignal, withoutCommandSignal } from "../electron/device/command-context";
import { delay, runCommand, type CommandResult } from "../electron/device/runtime";
import { createProviderSessionPool, type ProviderClient, type ProviderSocket } from "../electron/sdk/provider-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const evidence = { nodeCount: 20, verified: true, visibleStream: "2", uiWake: "1", hardwareAccelerated: "true" };
const result = (text = ""): CommandResult => ({ code: 0, stdout: Buffer.from(text), stderr: "" });

test("attempts retain the request's first component and reset route decisions without mutating caller options", () => {
  const onProgress = () => {}, onPreview = () => {};
  const options: InspectionOptions = Object.freeze({ pinFirstComponent: null, priorityViewRef: "view@1", layerPreviewPolling: false,
    allowAppRestart: false, onProgress, onPreview });
  const request = createCaptureRunContext(options);
  const first = createCaptureAttemptContext(request);
  first.request.pinFirstComponent = "sample.app/First";
  assert.equal(first.plan.acceptVerifiedSdk(evidence), true);
  const retry = createCaptureAttemptContext(request, { startupRetry: true });
  assert.equal(retry.request, first.request);
  assert.equal(retry.request.pinFirstComponent, "sample.app/First");
  assert.notEqual(retry.plan, first.plan);
  assert.equal(retry.plan.preferVisibleSdk, undefined);
  assert.equal(retry.plan.startupRetry, true);
  assert.equal(first.plan.startupRetry, false);
  assert.equal(request.plan.preferVisibleSdk, undefined);
  assert.equal(options.pinFirstComponent, null);
  assert.equal(options.preferVisibleSdk, undefined);
  assert.notEqual(first.options, options);
  assert.notEqual(first.options, retry.options);
  assert.equal(retry.options.onProgress, onProgress);
  assert.equal(retry.options.onPreview, onPreview);
  assert.equal(retry.options.priorityViewRef, "view@1");
  assert.equal(retry.options.layerPreviewPolling, false);
  assert.equal(retry.options.allowAppRestart, false);
});

test("caller route preference survives retries and separate requests never share mutable identity or plan", () => {
  for (const preferVisibleSdk of [false, true, undefined]) {
    const first = createCaptureRunContext({ preferVisibleSdk, pinFirstComponent: null });
    first.plan.acceptVerifiedSdk(evidence); first.request.pinFirstComponent = "sample.app/First";
    const retry = createCaptureAttemptContext(first), other = createCaptureRunContext({ preferVisibleSdk, pinFirstComponent: null });
    assert.equal(retry.plan.preferVisibleSdk, preferVisibleSdk);
    assert.equal(other.plan.preferVisibleSdk, preferVisibleSdk);
    assert.equal(other.request.pinFirstComponent, null);
    assert.notEqual(other.request, first.request);
    assert.notEqual(other.plan, first.plan);
    assert.equal(first.options.preferVisibleSdk, preferVisibleSdk);
  }
});

test("stage cancellation changes only the signal and shares this attempt's route and callbacks", () => {
  const requestSignal = new AbortController().signal, stageSignal = new AbortController().signal;
  const context = createCaptureRunContext({ signal: requestSignal, startupRetry: true });
  const stage = withCaptureSignal(context, stageSignal);
  assert.equal(stage.signal, stageSignal);
  assert.equal(context.signal, requestSignal);
  assert.equal(stage.options, context.options);
  assert.equal(stage.request, context.request);
  assert.equal(stage.plan, context.plan);
  stage.plan.acceptVerifiedSdk(evidence);
  assert.equal(context.plan.preferVisibleSdk, true);
  assert.equal(withCaptureSignal(context, undefined).signal, undefined);
  assert.equal(createCaptureAttemptContext(context).plan.startupRetry, true);
});

test("parallel command scopes and nested stages retain only their own cancellation signal", async () => {
  const first = new AbortController(), second = new AbortController(), child = new AbortController();
  const barrier = deferred<void>();
  await Promise.all([
    withCommandSignal(first.signal, async () => {
      assert.equal(commandSignal(), first.signal); await barrier.promise;
      await withCommandSignal(child.signal, async () => { await Promise.resolve(); assert.equal(commandSignal(), child.signal); });
      assert.equal(commandSignal(), first.signal);
    }),
    withCommandSignal(second.signal, async () => {
      assert.equal(commandSignal(), second.signal); barrier.resolve(); await Promise.resolve();
      assert.equal(commandSignal(), second.signal);
    }),
  ]);
  assert.equal(commandSignal(), undefined);
});

test("cancelled commands reject before spawning while cleanup can run and restores the enclosing scope", async () => {
  const controller = new AbortController(), reason = new Error("request cancelled"); controller.abort(reason);
  await withCommandSignal(controller.signal, async () => {
    await assert.rejects(runCommand("must-not-spawn-after-cancellation", []), error => error === reason);
    await withoutCommandSignal(async () => {
      assert.equal(commandSignal(), undefined);
      await delay(1);
      const cleanup = await runCommand(process.execPath, ["-e", "process.stdout.write('cleaned')"]);
      assert.equal(cleanup.stdout.toString(), "cleaned");
    });
    assert.equal(commandSignal(), controller.signal);
  });
  assert.equal(commandSignal(), undefined);
});

test("in-flight command delays observe cancellation with the original cause", async () => {
  const controller = new AbortController(), reason = new Error("stop stage");
  const waiting = withCommandSignal(controller.signal, () => delay(60_000));
  controller.abort(reason);
  await assert.rejects(waiting, error => error instanceof Error && error.name === "AbortError" && "cause" in error && error.cause === reason);
});

test("SDK tree requests consume explicit single-attempt policy and signal instead of the ambient caller", async () => {
  const ambient = new AbortController().signal;
  for (const singleAttempt of [true, false]) {
    const signal = new AbortController().signal, context = createCaptureRunContext({ signal, singleAttempt });
    let calls = 0;
    const provider: ProviderClient = { open: async () => assert.fail("tree request does not open a session directly"),
      call: async (_adb, _serial, _package, method, _arg, _extras, _timeout, _quoted, suppliedSignal) => {
        calls++; assert.equal(method, "capture"); assert.equal(commandSignal(), signal); assert.equal(suppliedSignal, signal);
        return result("Result: Bundle[{error=View tree timed out}]");
      } };
    await withCommandSignal(ambient, async () => {
      await assert.rejects(readSdkCapture(provider, "must-not-run-adb", "fixture", "sample.app", context), /SDK 控件树(?:连续)?超时/);
      assert.equal(commandSignal(), ambient);
    });
    assert.equal(calls, singleAttempt ? 1 : 2);
  }
});

test("SDK cancellation before a tree request preserves its reason and makes no provider call", async () => {
  const controller = new AbortController(), reason = new Error("cancel SDK request"); controller.abort(reason);
  const provider: ProviderClient = { open: async () => assert.fail("cancelled"), call: async () => assert.fail("cancelled") };
  await assert.rejects(readSdkCapture(provider, "must-not-run-adb", "fixture", "sample.app", createCaptureRunContext({ signal: controller.signal })), error => error === reason);
});

class ProbeSocket extends EventEmitter implements ProviderSocket {
  destroyed = false;
  methods: string[] = [];
  setNoDelay() {}
  write(line: string) {
    const { method } = JSON.parse(line); this.methods.push(method);
    queueMicrotask(() => this.emit("data", Buffer.from("Result: Bundle[{error=Unknown session method}]\n")));
  }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}

test("provider forwarding finishes outside request cancellation and still removes its allocated port", async () => {
  const controller = new AbortController(), reason = new Error("cancel while allocating forward");
  const opening = deferred<void>(), forwarded = deferred<CommandResult>(), commands: string[][] = [], sockets: ProbeSocket[] = [];
  const pool = createProviderSessionPool({
    runDeviceAdb: async (_adb, _serial, args) => {
      commands.push(args); assert.equal(commandSignal(), undefined, "forward ownership must outlive request cancellation");
      if (args[1] === "tcp:0") { opening.resolve(); return forwarded.promise; }
      return result();
    },
    runCommand: async () => assert.fail("cancelled call must not fall back to content"),
    connect: () => { const socket = new ProbeSocket(); sockets.push(socket); queueMicrotask(() => socket.emit("connect")); return socket; },
  });
  try {
    const call = withCommandSignal(controller.signal, () => pool.call("fake-adb", "fixture", "sample.app", "capture-refs", null, null, 1_000));
    const rejected = assert.rejects(call, error => error === reason);
    await opening.promise; controller.abort(reason); forwarded.resolve(result("2913"));
    await rejected;
  } finally { await withoutCommandSignal(() => pool.dispose()); }
  assert.equal(commands.filter(args => args[1] === "tcp:0").length, 1);
  assert.equal(commands.filter(args => args[1] === "--remove" && args[2] === "tcp:2913").length, 1);
  assert.equal(sockets.some(socket => socket.methods.includes("capture-refs")), false);
  assert.equal(commandSignal(), undefined);
});

test("tree verification receives the active stage deadline and original tree while external callbacks stay compatible", async () => {
  const requestSignal = new AbortController().signal, stageController = new AbortController(), root = makeNode("root");
  let external = 0, internal = 0;
  const request = createCaptureRunContext({ signal: requestSignal, singleAttempt: true, onViewTreeReady: async (packageName, tree) => {
    external++; assert.equal(packageName, "sample.app"); assert.equal(tree, root); assert.equal(commandSignal(), requestSignal);
  } });
  await notifyViewTreeReady(request, "sample.app", root);
  const attempt: CaptureRunContext = { ...createCaptureAttemptContext(request), treeVerifier: async (active, packageName, tree) => {
    internal++; assert.equal(active.signal, stageController.signal); assert.equal(commandSignal(), stageController.signal);
    assert.equal(tree, root); assert.equal(active.plan, attempt.plan);
    const provider: ProviderClient = { open: async () => assert.fail("not used"), call: async (...args) => {
      assert.equal(args[8], stageController.signal); assert.equal(commandSignal(), stageController.signal);
      return result("Result: Bundle[{error=View tree timed out}]");
    } };
    await assert.rejects(readSdkCapture(provider, "must-not-run-adb", "fixture", packageName, active), /SDK 控件树超时/);
  } };
  await notifyViewTreeReady(withCaptureSignal(attempt, stageController.signal), "sample.app", root);
  assert.equal(external, 1); assert.equal(internal, 1);
  assert.equal(commandSignal(), undefined);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { createAccessibilityHelperSession } from "../electron/capture/helper-session";
import { HelperInputError } from "../electron/capture/helper-input";
import { HelperCaptureError } from "../electron/capture/accessibility-helper";
import type { HelperInputRequest, HelperInputReply } from "../shared/helper-input";
import type { HelperTargetProbeRequest } from "../shared/helper-target-probe";
import { helperCapabilities, helperFrame, helperPackage, helperPayload, helperSerial, helperToken } from "./fixtures/helper-protocol";

const receipt = (input: HelperInputRequest): HelperInputReply => {
  const { action: _, target: _target, ...identity } = input;
  return { ...identity, status: "completed", dispatchState: "sent", startedAtMs: 150, finishedAtMs: 160,
    method: input.target ? "accessibility-click" : input.action.kind === "back" ? "global-back" : "gesture" };
};
async function setup(supportsInput = true) {
  const png = (await sharp({ create: { ...helperFrame, channels: 4, background: "white" } }).png().toBuffer()).toString("base64");
  const lifetime = new AbortController(); let token = helperToken, mapping: string | undefined, counter = 0;
  const requests: string[] = [], commands: string[][] = [];
  let onInput: (input: HelperInputRequest, signal: AbortSignal) => Promise<Response> = async input => new Response(JSON.stringify(receipt(input)));
  let onProbe: (input: HelperTargetProbeRequest) => Response = () => { throw new Error("Unexpected target probe"); };
  let snapshotStart: number | undefined;
  let transformSnapshot: ((payload: ReturnType<typeof helperPayload>) => void) | undefined;
  const session = createAccessibilityHelperSession({ sessionId: randomUUID(), serial: helperSerial, signal: lifetime.signal }, {
    readToken: () => token, choosePort: async () => 12345,
    execute: async args => {
      commands.push(args); assert.deepEqual(args.slice(0, 2), ["-s", helperSerial]);
      const a = args.slice(2);
      if (a.join(" ") === "forward --list") return mapping ? `${helperSerial} tcp:12345 ${mapping}\n` : "";
      if (a[0] === "forward" && a[1] === "--no-rebind") { assert.equal(mapping, undefined); mapping = a[3]; return ""; }
      if (a[0] === "forward" && a[1] === "tcp:12345") { mapping = a[2]; return ""; }
      if (a.join(" ") === "forward --remove tcp:12345") { mapping = undefined; return ""; }
      throw Error("Unexpected command: no input, install or backend fallback is allowed");
    },
    fetch: (async (url, options) => {
      const path = new URL(String(url)).pathname; requests.push(path);
      assert.equal((options!.headers as Record<string, string>)["X-Artemis-Token"], helperToken);
      if (path === "/inspector/capabilities") return new Response(JSON.stringify({ ...helperCapabilities,
        capabilities: { ...helperCapabilities.capabilities, ...(supportsInput ? { guardedInput: true } : {}) } }));
      if (path === "/inspector/snapshot") {
        const payload = helperPayload(png, snapshotStart ?? ++counter * 100); transformSnapshot?.(payload);
        return new Response(JSON.stringify(payload));
      }
      if (path === "/inspector/target-probe") return onProbe(JSON.parse(String(options!.body)));
      assert.equal(path, "/inspector/input"); assert.equal(options!.method, "POST");
      return onInput(JSON.parse(String(options!.body)), options!.signal as AbortSignal);
    }) as typeof fetch,
  });
  const read = () => session.read("/fixture/adb", helperPackage, helperFrame, new AbortController().signal);
  const input = (evidence: Awaited<ReturnType<typeof read>>["helperObservation"], signal = new AbortController().signal, target?: HelperInputRequest["target"]) =>
    session.input!("/fixture/adb", helperPackage, helperFrame, evidence, { kind: "tap", x: 1, y: 2 }, signal, target);
  return { session, lifetime, requests, commands, read, input, mapping: () => mapping,
    setProbe: (value: typeof onProbe) => { onProbe = value; },
    setInput: (value: typeof onInput) => { onInput = value; }, setToken: () => { token = "changed_private_token_fixture"; },
    setSnapshotStart: (value: number) => { snapshotStart = value; }, takeover: () => { mapping = "tcp:19999"; },
    setSnapshotTransform: (value?: typeof transformSnapshot) => { transformSnapshot = value; },
    close: () => session.close().catch(() => undefined) };
}
const unknown = (error: unknown) => error instanceof HelperInputError && error.dispatchState === "unknown" && Boolean(error.requestId);

test("read-only session probe binds a current capture and blocks subsequent input from that capture", async () => {
  const f = await setup();
  const target = { resourceId: helperPackage + ":id/button", className: "android.widget.Button", bounds: { left: 0, top: 0, right: 10, bottom: 20 } };
  try {
    const observation = await f.read();
    f.setProbe(input => {
      const { target: _, ...identity } = input;
      assert.deepEqual(input.target, target);
      return new Response(JSON.stringify({ ...identity, readOnly: true, dispatchState: "not_sent", status: "timeout", errorCode: "timeout",
        startedAtMs: 150, mainStartedAtMs: 151, finishedAtMs: 1150, preflightStage: "target_scan", preflightStageStartedAtMs: 152,
        scanDiagnostics: { version: 1, operation: "child", scanStartedAtMs: 152, operationStartedAtMs: 153,
          nodesVisited: 1, childReadsStarted: 1, childReadsCompleted: 0, childReadTotalMs: 0, childReadMaxMs: 0 } }));
    });
    const result = await f.session.probeTarget!("/fixture/adb", helperPackage, helperFrame, observation.helperObservation, target, new AbortController().signal);
    assert.equal(result.readOnly, true);
    await assert.rejects(f.input(observation.helperObservation));
    await assert.rejects(f.session.probeTarget!("/fixture/adb", helperPackage, helperFrame, observation.helperObservation, target, new AbortController().signal));
    assert.equal(f.requests.filter(x => x === "/inspector/target-probe").length, 1);
    assert.equal(f.requests.includes("/inspector/input"), false);
  } finally { await f.close(); }
});

test("read-only probe rejects changed evidence, pairing and revoked sessions before its POST", async () => {
  const target = { resourceId: helperPackage + ":id/button", className: "android.widget.Button", bounds: { left: 0, top: 0, right: 10, bottom: 20 } };
  for (const change of ["evidence", "pairing", "revoked"] as const) {
    const f = await setup();
    try {
      const observation = await f.read();
      const evidence = { ...observation.helperObservation };
      if (change === "evidence") evidence.captureId = randomUUID();
      if (change === "pairing") f.setToken();
      if (change === "revoked") f.lifetime.abort();
      await assert.rejects(f.session.probeTarget!("/fixture/adb", helperPackage, helperFrame, evidence, target, new AbortController().signal));
      assert.equal(f.requests.includes("/inspector/target-probe"), false);
      assert.equal(f.requests.includes("/inspector/input"), false);
    } finally { await f.close(); }
  }
});

test("session sends the exact descriptor once and preserves semantic method in its receipt", async () => {
  const f = await setup();
  const target = { resourceId: helperPackage + ":id/button", className: "android.widget.Button", text: "Start", contentDesc: "",
    bounds: { left: 0, top: 0, right: 10, bottom: 20 } };
  try {
    const observed = await f.read();
    f.setInput(async input => { assert.deepEqual(input.target, target); return new Response(JSON.stringify(receipt(input))); });
    const result = await f.input(observed.helperObservation, new AbortController().signal, target);
    assert.equal(result.method, "accessibility-click");
    assert.equal(f.requests.filter(path => path === "/inspector/input").length, 1);
  } finally { await f.close(); }
});

test("the real empty-identity system gap is retained only after sent input, never before input or after unknown input", async () => {
  for (const mode of ["before", "sent", "unknown"] as const) {
    const f = await setup();
    try {
      const observed = await f.read();
      if (mode === "unknown") f.setInput(async input => new Response(JSON.stringify({ ...receipt(input), status: "cancelled", dispatchState: "unknown", errorCode: "cancelled" })));
      if (mode !== "before") await f.input(observed.helperObservation);
      f.setSnapshotTransform(payload => {
        const e = payload.helperObservation;
        Object.assign(e, { packageName: "", windowId: "", complete: false, diagnostics: { version: 1, reasons: [{ code: "focus_invalid", count: 1 }] } });
        e.windowsBefore = [{ ...e.windowsBefore[0], id: "91", type: "system", packageName: "com.android.systemui", active: false, focused: false }];
        e.windowsAfter = structuredClone(e.windowsBefore);
      });
      await assert.rejects(f.read(), (error: unknown) => error instanceof HelperCaptureError && error.code === "helper-incomplete"
        && (mode === "sent" ? error.recoveryEvidence?.packageName === "" && error.recoveryEvidence?.windowId === "" : !error.recoveryEvidence)
        && error.recoveryDiagnostics?.session === (mode === "sent" ? "accepted" : "sent_receipt_required"));
      f.setSnapshotTransform();
      assert.equal((await f.read()).helperObservation.packageName, helperPackage);
      assert.equal(f.requests.filter(path => path === "/inspector/input").length, mode === "before" ? 0 : 1);
    } finally { await f.close(); }
  }
});

test("session validates both app/system transition directions and rejects a foreign app after empty metadata", async () => {
  for (const shape of ["app-system", "system-app", "system-foreign"] as const) {
    const f = await setup();
    try {
      const observed = await f.read(); await f.input(observed.helperObservation);
      f.setSnapshotTransform(payload => {
        const e = payload.helperObservation, app = structuredClone(e.windowsBefore[0]);
        const system = { ...app, id: "91", type: "system" as const, packageName: "com.android.systemui", active: false, focused: false };
        Object.assign(e, { complete: false, diagnostics: { version: 1, reasons: [
          { code: "window_inventory_changed", count: 1 }, { code: "focus_invalid", count: 1 }] } });
        if (shape === "app-system") e.windowsAfter = [system];
        else {
          e.packageName = ""; e.windowId = ""; e.windowsBefore = [system];
          e.windowsAfter = [{ ...app, id: "8", packageName: shape === "system-foreign" ? "com.foreign.app" : helperPackage }];
        }
      });
      await assert.rejects(f.read(), (error: unknown) => error instanceof HelperCaptureError && error.code === "helper-incomplete"
        && (shape === "system-foreign" ? !error.recoveryEvidence : Boolean(error.recoveryEvidence)));
      assert.equal(f.requests.filter(path => path === "/inspector/input").length, 1);
      if (shape !== "system-foreign") { f.setSnapshotTransform(); assert.equal((await f.read()).helperObservation.packageName, helperPackage); }
    } finally { await f.close(); }
  }
});

test("horizontal motion and full-display expansion are retained only after confirmed sent input", async () => {
  for (const animation of ["horizontal", "expand"] as const) {
  for (const mode of ["before", "sent", "unknown"] as const) {
    const f = await setup();
    try {
      const observed = await f.read();
      if (mode === "unknown") f.setInput(async input => new Response(JSON.stringify({ ...receipt(input), status: "cancelled", dispatchState: "unknown", errorCode: "cancelled" })));
      if (mode !== "before") await f.input(observed.helperObservation);
      f.setSnapshotTransform(payload => {
        const e = payload.helperObservation;
        Object.assign(e, { complete: false, diagnostics: { version: 1, reasons: [{ code: "window_inventory_changed", count: 1 }] } });
        e.windowsBefore[0].bounds = animation === "horizontal" ? { x: -3, y: 0, width: 9, height: 20 } : { x: 3, y: 5, width: 8, height: 15 };
        e.windowsAfter[0].bounds = animation === "horizontal" ? { x: -1, y: 0, width: 9, height: 20 } : { x: 0, y: 0, width: 10, height: 20 };
      });
      await assert.rejects(f.read(), (error: unknown) => error instanceof HelperCaptureError && error.code === "helper-incomplete"
        && (mode === "sent" ? error.recoveryEvidence?.windowsAfter[0].bounds.x === (animation === "horizontal" ? -1 : 0) : !error.recoveryEvidence)
        && error.recoveryDiagnostics?.session === (mode === "sent" ? "accepted" : "sent_receipt_required"));
      f.setSnapshotTransform(); assert.equal((await f.read()).helperObservation.packageName, helperPackage);
      assert.equal(f.requests.filter(path => path === "/inspector/input").length, mode === "before" ? 0 : 1);
    } finally { await f.close(); }
  }
  }
});

test("session rejects invalid descriptors before HTTP and method mismatch locks later input", async () => {
  for (const mismatch of [false, true]) {
    const f = await setup();
    const target = { resourceId: helperPackage + ":id/button", className: "android.widget.Button",
      bounds: { left: 0, top: 0, right: mismatch ? 10 : 11, bottom: 20 } };
    try {
      const observed = await f.read();
      f.setInput(async input => new Response(JSON.stringify({ ...receipt(input), method: "gesture" })));
      await assert.rejects(f.input(observed.helperObservation, new AbortController().signal, target), (error: unknown) =>
        error instanceof HelperInputError && error.dispatchState === (mismatch ? "unknown" : "not_sent"));
      if (mismatch) {
        const current = await f.read(); await assert.rejects(f.input(current.helperObservation), /只允许继续观察/);
      }
      assert.equal(f.requests.filter(path => path === "/inspector/input").length, mismatch ? 1 : 0);
    } finally { await f.close(); }
  }
});

test("session consumes a complete capture once and only a new full observation permits another input", async () => {
  const f = await setup();
  try {
    const first = await f.read(); assert.equal((await f.input(structuredClone(first.helperObservation))).status, "completed");
    await assert.rejects(f.input(first.helperObservation), (error: unknown) => error instanceof HelperInputError && error.dispatchState === "not_sent");
    assert.equal(f.requests.filter(path => path === "/inspector/input").length, 1);
    const second = await f.read();
    f.setInput(async input => new Response(JSON.stringify({ ...receipt(input), startedAtMs: 250, finishedAtMs: 260 })));
    assert.equal((await f.input(second.helperObservation)).dispatchState, "sent");
    assert.equal(f.requests.filter(path => path === "/inspector/input").length, 2);
    assert.ok(f.commands.every(args => args[2] === "forward"));
  } finally { await f.close(); }
});

test("old, modified and foreign evidence and changed token are rejected before HTTP", async () => {
  for (const scenario of ["old", "modified", "returned-reference", "service", "token"]) {
    const f = await setup();
    try {
      const observed = await f.read(), evidence = scenario === "returned-reference" ? observed.helperObservation : structuredClone(observed.helperObservation);
      if (scenario === "old") await f.read();
      if (scenario === "modified" || scenario === "returned-reference") evidence.timing.completedAtMs++;
      if (scenario === "service") evidence.serviceInstanceId = randomUUID();
      if (scenario === "token") f.setToken();
      await assert.rejects(f.input(evidence), (error: unknown) => error instanceof HelperInputError && error.dispatchState === "not_sent");
      assert.equal(f.requests.filter(path => path === "/inspector/input").length, 0);
    } finally { await f.close(); }
  }
});

test("older read-only Helper capabilities reject input before probing any input endpoint", async () => {
  const f = await setup(false);
  try {
    const observed = await f.read();
    await assert.rejects(f.input(observed.helperObservation), (error: unknown) => error instanceof HelperInputError && error.dispatchState === "not_sent");
    assert.equal(f.requests.filter(path => path === "/inspector/input").length, 0);
    assert.ok(f.commands.every(args => args[2] === "forward"));
  } finally { await f.close(); }
});

test("post-receipt token and forward changes stay unknown, preserving the device request and receipt", async () => {
  for (const change of ["token", "forward"]) {
    const f = await setup();
    try {
      const observed = await f.read();
      f.setInput(async input => { if (change === "token") f.setToken(); else f.takeover();
        return new Response(JSON.stringify({ ...receipt(input), status: "rejected", dispatchState: "not_sent", errorCode: "busy" })); });
      await assert.rejects(f.input(observed.helperObservation), (error: unknown) => unknown(error)
        && (error as HelperInputError).reply?.dispatchState === "not_sent");
      assert.equal(f.requests.filter(path => path === "/inspector/input").length, 1);
      if (change === "forward") assert.equal(f.mapping(), "tcp:19999");
    } finally { await f.close(); }
  }
});

test("response mismatch, 404 and early receipt never retry and consumed evidence cannot dispatch again", async () => {
  for (const scenario of ["mismatch", "404", "early"]) {
    const f = await setup();
    try {
      const observed = await f.read();
      f.setInput(async input => new Response(JSON.stringify({ ...receipt(input), ...(scenario === "mismatch" ? { captureId: randomUUID() }
        : scenario === "early" ? { startedAtMs: 1, finishedAtMs: 2 } : {}) }), { status: scenario === "404" ? 404 : 200 }));
      await assert.rejects(f.input(observed.helperObservation), unknown);
      await assert.rejects(f.input(observed.helperObservation));
      assert.equal(f.requests.filter(path => path === "/inspector/input").length, 1);
    } finally { await f.close(); }
  }
});

test("following observations must start after the device input finished", async () => {
  const f = await setup();
  try {
    const observed = await f.read(); await f.input(observed.helperObservation); f.setSnapshotStart(155);
    await assert.rejects(f.read(), /未晚于设备输入/);
  } finally { await f.close(); }
});

test("an unknown device input keeps this grant read-only even after a newer complete capture", async () => {
  const f = await setup();
  try {
    const observed = await f.read();
    f.setInput(async () => { throw Error("connection lost"); });
    await assert.rejects(f.input(observed.helperObservation), unknown);
    const current = await f.read();
    await assert.rejects(f.input(current.helperObservation), (error: unknown) => error instanceof HelperInputError && error.dispatchState === "not_sent");
    assert.equal(f.requests.filter(path => path === "/inspector/input").length, 1);
  } finally { await f.close(); }
});

test("input shares read/wait mutual exclusion and grant close joins cancelled response cleanup", async () => {
  const f = await setup(); let reached!: () => void, cancelled = false;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  try {
    const observed = await f.read();
    f.setInput(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); reached(); },
      cancel() { cancelled = true; } })));
    const pending = f.input(observed.helperObservation); await entered;
    await assert.rejects(f.read(), /仍有观察/); await assert.rejects(f.input(observed.helperObservation), /仍有观察/);
    await assert.rejects(f.session.wait("/fixture/adb", helperPackage, helperFrame, { selector: { text: "END" }, state: "visible", timeoutMs: 1000 },
      new AbortController().signal), /仍有观察/);
    f.lifetime.abort(Error("grant ended")); const closing = f.session.close();
    await assert.rejects(pending, unknown); await closing;
    assert.equal(cancelled, true); assert.equal(f.mapping(), undefined);
    await assert.rejects(f.input(observed.helperObservation), (error: unknown) => error instanceof HelperInputError && error.dispatchState === "not_sent");
  } finally { await f.close(); }
});

test("window transition recovery metadata is retained only immediately after a confirmed sent input", async () => {
  for (const afterInput of [false, true]) {
    const f = await setup();
    try {
      const observed = await f.read(); if (afterInput) await f.input(observed.helperObservation);
      f.setSnapshotTransform(payload => {
        Object.assign(payload.helperObservation, { complete: false, diagnostics: { version: 1,
          reasons: [{ code: "window_inventory_changed", count: 1 }, { code: "focus_invalid", count: 1 }] } });
        payload.helperObservation.windowsAfter[0].id = "8"; payload.helperObservation.windowsAfter[0].focused = false;
      });
      await assert.rejects(f.read(), (error: unknown) => error instanceof HelperCaptureError && error.code === "helper-incomplete"
        && Boolean(error.recoveryEvidence) === afterInput);
      assert.equal(f.requests.filter(path => path === "/inspector/input").length, afterInput ? 1 : 0);
      f.setSnapshotTransform();
      const current = await f.read(); assert.equal(current.helperObservation.timing.startedAtMs, 300);
    } finally { await f.close(); }
  }
});

test("a transition recovery cursor rejects a repeated failed capture time", async () => {
  const f = await setup();
  try {
    const observed = await f.read(); await f.input(observed.helperObservation);
    f.setSnapshotTransform(payload => {
      Object.assign(payload.helperObservation, { complete: false, diagnostics: { version: 1,
        reasons: [{ code: "window_inventory_changed", count: 1 }, { code: "focus_invalid", count: 1 }] } });
      payload.helperObservation.windowsAfter[0].id = "8"; payload.helperObservation.windowsAfter[0].focused = false;
    });
    await assert.rejects(f.read(), (error: unknown) => error instanceof HelperCaptureError && Boolean(error.recoveryEvidence));
    f.setSnapshotTransform(); f.setSnapshotStart(200);
    await assert.rejects(f.read(), /未晚于上次失败读取/);
    assert.equal(f.requests.filter(path => path === "/inspector/input").length, 1);
  } finally { await f.close(); }
});

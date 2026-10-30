import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import sharp from "sharp";
import { HelperCaptureError } from "../electron/capture/accessibility-helper";
import { createAccessibilityHelperSession } from "../electron/capture/helper-session";
import { readHelperObservation } from "../electron/capture/helper-observation";
import { assertActionableHelperSnapshot, assertSameHelperObservationSource, assertSameHelperServiceEvidence,
  hasActionableHelperEvidence, hasCompleteHelperTree, isHelperObservationEvidence } from "../shared/helper-observation";
import type { UiSnapshot } from "../shared/types";
import type { HelperConditionWaitRequest } from "../shared/helper-condition-wait";
import { helperCapabilities, helperEvidence, helperFrame, helperPackage, helperPayload, helperSerial, helperToken, helperXml } from "./fixtures/helper-protocol";

const png = () => sharp({ create: { ...helperFrame, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
type Fixture = Awaited<ReturnType<typeof setup>>;
async function setup() {
  const image = (await png()).toString("base64"), lifetime = new AbortController();
  let mapping: { local: string; remote: string } | undefined, token = helperToken, counter = 0;
  let capture: (res: ServerResponse) => void = res => { res.end(JSON.stringify(helperPayload(image, ++counter * 100))); };
  let capability = structuredClone(helperCapabilities);
  let wait: ((request: HelperConditionWaitRequest, response: ServerResponse) => void) | undefined;
  const requests: string[] = [], commands: string[][] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    assert.equal(req.method, req.url === "/inspector/wait" ? "POST" : "GET"); assert.equal(req.headers["x-artemis-token"], token);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/inspector/capabilities") res.end(JSON.stringify(capability));
    else if (req.url === "/inspector/snapshot") capture(res);
    else if (req.url === "/inspector/wait" && wait) {
      let body = ""; req.on("data", data => { body += data; }); req.on("end", () => wait!(JSON.parse(body), res));
    }
    else res.writeHead(404).end();
  });
  const port = await new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  let beforeCommand: ((args: string[]) => Promise<void>) | undefined;
  const client = createAccessibilityHelperSession({ serial: helperSerial, sessionId: randomUUID(), signal: lifetime.signal }, {
    readToken: () => token, choosePort: async () => port,
    execute: async args => {
      commands.push(args); assert.equal(args[0], "-s"); assert.equal(args[1], helperSerial);
      await beforeCommand?.(args);
      const action = args.slice(2);
      if (action.join(" ") === "forward --list") return mapping ? `${helperSerial} ${mapping.local} ${mapping.remote}\n` : "";
      if (action[0] === "forward" && action[1] === "--no-rebind") { assert.equal(mapping, undefined); mapping = { local: action[2], remote: action[3] }; return ""; }
      if (action[0] === "forward" && action[1] === "--remove") { assert.equal(action[2], mapping?.local); mapping = undefined; return ""; }
      if (action[0] === "forward" && action[1] === mapping?.local && action[2] === "tcp:18888") { mapping.remote = action[2]; return ""; }
      throw Error("Unexpected fixture command");
    },
  });
  return { client, lifetime, requests, commands, image, port,
    read: (signal = new AbortController().signal) => client.read("/fake/adb", helperPackage, helperFrame, signal),
    wait: (signal = new AbortController().signal) => client.wait("/fake/adb", helperPackage, helperFrame,
      { selector: { text: "END" }, state: "visible", timeoutMs: 1000 }, signal),
    mapping: () => mapping, takeover: () => { mapping!.remote = "tcp:19999"; },
    setToken: (value: string) => { token = value; },
    setCapabilities: (value: typeof helperCapabilities) => { capability = value; },
    setCapture: (handler: typeof capture) => { capture = handler; },
    setWait: (handler: typeof wait) => { wait = handler; },
    setCommand: (handler: typeof beforeCommand) => { beforeCommand = handler; },
    cleanup: async () => { await client.close().catch(() => undefined); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
const asSnapshot = (read: Awaited<ReturnType<Fixture["read"]>>): UiSnapshot => ({ serial: helperSerial, root: read.root, nodeCount: read.nodeCount,
  rawXml: read.xml, xmlSize: Buffer.byteLength(read.xml), screenshotDataUrl: read.screenshotDataUrl, error: null, warning: null,
  inspectionSource: "accessibility-helper", captureGeometry: read.captureGeometry, helperObservation: read.helperObservation });

test("session reuses its owned forward and capability handshake while each read remains fresh", async () => {
  const f = await setup();
  try {
    assert.equal(f.commands.length, 0); assert.equal(f.requests.length, 0);
    const first = asSnapshot(await f.read()), second = asSnapshot(await f.read());
    assert.deepEqual(f.requests, ["/inspector/capabilities", "/inspector/snapshot", "/inspector/snapshot"]);
    assert.equal(f.commands.filter(a => a.includes("--no-rebind")).length, 1);
    assert.notEqual(first.helperObservation!.captureId, second.helperObservation!.captureId);
    assertActionableHelperSnapshot(first); assertSameHelperObservationSource(first, second);
    assert.equal(hasActionableHelperEvidence({ ...first, screenshotDataUrl: null }), true);
    await f.client.close(); assert.equal(f.mapping(), undefined);
    assert.equal(f.commands.filter(a => a.includes("--remove")).length, 1);
    await assert.rejects(f.read(), /授权已结束/);
    assert.ok(!f.commands.some(a => a.includes("--remove-all") || a.includes("input") || a.includes("install")));
  } finally { await f.cleanup(); }
});

function conditionHint(request: HelperConditionWaitRequest, start = 150) {
  return { success: true, protocolVersion: 1, sessionId: request.sessionId, requestId: request.requestId,
    serviceInstanceId: request.serviceInstanceId, packageName: request.packageName, windowId: "7", display: request.display,
    status: "ready", matchCount: 1, attempts: 1, startedAtMs: start, finishedAtMs: start + 1 };
}

test("post-response overlap still checks token and forward ownership before accepting the observation", async () => {
  for (const change of ["token", "forward"] as const) {
    const f = await setup();
    try {
      await assert.rejects(f.client.read("/fake/adb", helperPackage, helperFrame, new AbortController().signal, async () => {
        if (change === "token") f.setToken("changed_pairing_token_123456");
        else f.takeover();
      }), /配对|转发|归属/);
      if (change === "forward") assert.equal(f.mapping()?.remote, "tcp:19999", "foreign mapping must not be removed");
      else assert.equal(f.mapping(), undefined);
    } finally { await f.cleanup(); }
  }
});

test("session close joins unfinished post-response checks before releasing its owned forward", async () => {
  const f = await setup();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => finish = resolve);
  const read = f.client.read("/fake/adb", helperPackage, helperFrame, new AbortController().signal, async () => {
    entered(); await gate;
  }).then(() => { throw Error("closed session accepted"); }, () => undefined);
  try {
    await started; const closing = f.client.close();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert(f.mapping(), "owned forward must remain until the check is joined");
    finish(); await read; await closing; assert.equal(f.mapping(), undefined);
  } finally { finish(); await read; await f.cleanup(); }
});

test("wait reuses the grant's forward and its hint never replaces a complete observation", async () => {
  const f = await setup();
  try {
    await assert.rejects(f.wait(), /缺少当前授权观察/); assert.equal(f.requests.length, 0);
    await f.read(); f.setWait((request, response) => response.end(JSON.stringify(conditionHint(request))));
    assert.equal((await f.wait())!.status, "ready");
    const next = await f.read(); assert.equal(next.helperObservation.timing.startedAtMs, 200);
    assert.deepEqual(f.requests, ["/inspector/capabilities", "/inspector/snapshot", "/inspector/wait", "/inspector/snapshot"]);
    assert.equal(f.commands.filter(args => args.includes("--no-rebind")).length, 1);
  } finally { await f.cleanup(); }
});

test("unsupported wait is remembered once for the same Helper service", async () => {
  for (const envelope of [false, true]) {
    const f = await setup();
    try {
      await f.read();
      if (envelope) f.setWait((_request, response) => response.end(JSON.stringify({ success: false, errorCode: "unsupported" })));
      assert.equal(await f.wait(), null); assert.equal(await f.wait(), null);
      assert.equal(f.requests.filter(path => path === "/inspector/wait").length, 1);
      await f.read(); assert.ok(f.mapping());
    } finally { await f.cleanup(); }
  }
});

test("wait rejects foreign windows, replayed hints and later snapshots predating the hint", async () => {
  for (const scenario of ["window", "replayed", "old-snapshot", "token"] as const) {
    const f = await setup();
    try {
      await f.read();
      f.setWait((request, response) => {
        const hint = conditionHint(request, scenario === "replayed" ? 1 : scenario === "old-snapshot" ? 500 : 150);
        if (scenario === "window") hint.windowId = "999";
        if (scenario === "token") f.setToken("new_private_token_for_test");
        response.end(JSON.stringify(hint));
      });
      if (scenario === "old-snapshot") { await f.wait(); await assert.rejects(f.read(), /未晚于设备等待/); }
      else await assert.rejects(f.wait());
      assert.equal(f.mapping(), undefined);
    } finally { await f.cleanup(); }
  }
});

test("in-flight wait shares read mutual exclusion and grant revocation joins body cleanup", async () => {
  const f = await setup();
  try {
    await f.read(); let reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    f.setWait((_request, response) => { response.write("{"); reached(); });
    const pending = f.wait(); await entered;
    await assert.rejects(f.read(), /仍有观察/); await assert.rejects(f.wait(), /仍有观察/);
    f.lifetime.abort(Error("revoke gate")); await assert.rejects(pending, /revoke|授权|abort/i); await f.client.close();
    assert.equal(f.mapping(), undefined); await assert.rejects(f.wait(), /授权已结束/);
  } finally { await f.cleanup(); }
});

test("failed complete-observation reads cannot move recovery behind the device-wait watermark", async () => {
  const f = await setup();
  try {
    await f.read(); f.setWait((request, response) => response.end(JSON.stringify(conditionHint(request, 500)))); await f.wait();
    f.setCapture(response => {
      const payload = helperPayload(f.image, 200);
      Object.assign(payload.helperObservation, { complete: false, diagnostics: { version: 1, reasons: [{ code: "child_unavailable", count: 1 }] } });
      response.end(JSON.stringify(payload));
    });
    await assert.rejects(f.read(), (error: unknown) => error instanceof HelperCaptureError && error.code === "helper-session" && !error.recoveryEvidence
      && error.recoveryDiagnostics?.session === "before_wait_receipt");
    assert.equal(f.mapping(), undefined);
  } finally { await f.cleanup(); }
});

test("revocation cancels HTTP/body work and removes only this grant's forward", async () => {
  const f = await setup();
  try {
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    f.setCapture(res => { res.write("{"); entered(); });
    const pending = f.read(); await reached; f.lifetime.abort(Error("grant revoked"));
    await assert.rejects(pending, /授权|revoked|abort/i); await f.client.close();
    assert.equal(f.mapping(), undefined); await assert.rejects(f.read(), /授权已结束/);
  } finally { await f.cleanup(); }
});

test("caller cancellation releases the forward and an explicit fresh read may recover", async () => {
  const f = await setup();
  try {
    const cancel = new AbortController(); let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    f.setCapture(res => { res.write("{"); entered(); });
    const pending = f.read(cancel.signal); await reached; cancel.abort(Error("cancel this read"));
    await assert.rejects(pending, /cancel|abort/i); assert.equal(f.mapping(), undefined);
    f.setCapture(res => res.end(JSON.stringify(helperPayload(f.image, 500))));
    assertActionableHelperSnapshot(asSnapshot(await f.read()));
    assert.equal(f.commands.filter(a => a.includes("--no-rebind")).length, 2);
  } finally { await f.cleanup(); }
});

test("closing while the forward starts waits for cleanup and prevents publication", async () => {
  const f = await setup();
  try {
    let entered!: () => void, resume!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
    f.setCommand(async args => { if (args.includes("--no-rebind")) { entered(); await gate; } });
    const pending = f.read(); await reached;
    const closing = f.client.close(); resume(); await assert.rejects(pending); await closing;
    assert.equal(f.mapping(), undefined); assert.equal(f.requests.length, 0);
  } finally { await f.cleanup(); }
});

test("a changed forward is never removed and never used for a new HTTP read", async () => {
  const f = await setup();
  try {
    await f.read(); f.takeover(); const requests = f.requests.length;
    await assert.rejects(f.read(), /归属|绑定/);
    assert.equal(f.requests.length, requests); assert.equal(f.mapping()?.remote, "tcp:19999");
    assert.equal(f.commands.filter(a => a.includes("--remove")).length, 0);
  } finally { await f.cleanup(); }
});

for (const scenario of ["service-restart", "token-change", "inflight-token-change", "replayed-capture", "time-regression", "foreign-package", "capability-incomplete"] as const) {
  test(`session fails closed on ${scenario}`, async () => {
    const f = await setup();
    try {
      const first = await f.read();
      if (scenario === "token-change") f.setToken("another_private_session_token");
      else if (scenario === "capability-incomplete") {
        await f.client.release(); const caps = structuredClone(helperCapabilities); caps.capabilities.visibleBounds = false; f.setCapabilities(caps);
      } else f.setCapture(res => {
        const payload = helperPayload(f.image, scenario === "time-regression" ? 1 : 500);
        if (scenario === "service-restart") payload.helperObservation.serviceInstanceId = randomUUID();
        if (scenario === "replayed-capture") payload.helperObservation = first.helperObservation;
        if (scenario === "foreign-package") payload.helperObservation.packageName = "other.package";
        if (scenario === "inflight-token-change") f.setToken("another_private_session_token");
        res.end(JSON.stringify(payload));
      });
      await assert.rejects(f.read()); assert.equal(f.mapping(), undefined);
    } finally { await f.cleanup(); }
  });
}

test("parallel reads are rejected before a second observation is dispatched", async () => {
  const f = await setup();
  try {
    const first = f.read(); await assert.rejects(f.read(), /仍有观察/); await first;
    assert.equal(f.requests.filter(p => p === "/inspector/snapshot").length, 1);
  } finally { await f.cleanup(); }
});

test("explicit invisible nodes remain diagnostic only and unknown fields never become visible", async () => {
  const f = await setup();
  try {
    f.setCapture(res => { const p = helperPayload(f.image); p.xml = helperXml(true); res.end(JSON.stringify(p)); });
    const snapshot = asSnapshot(await f.read());
    assert.equal(snapshot.root!.children[0].visibleToUser, false);
    assert.equal(snapshot.root!.children[0].visibilityEvidence, "hidden");
    assertActionableHelperSnapshot(snapshot);
    for (const mutate of [(s: UiSnapshot) => { delete s.root!.attributes!["visible-to-user"]; },
      (s: UiSnapshot) => { s.root!.attributes!.enabled = "unknown"; },
      (s: UiSnapshot) => { s.root!.attributes!["visible-bounds"] = "[0,0][11,20]"; },
      (s: UiSnapshot) => { s.root!.attributes!["window-id"] = "8"; },
      (s: UiSnapshot) => { s.root!.children[0].visibleToUser = true; },
      (s: UiSnapshot) => { s.captureGeometry!.afterScreenshot = { ...helperFrame, rotation: 1 }; }]) {
      const changed = structuredClone(snapshot); mutate(changed); assert.equal(hasActionableHelperEvidence(changed), false);
      assert.throws(() => assertActionableHelperSnapshot(changed));
    }
    const noImage = { ...snapshot, screenshotDataUrl: null };
    assert.equal(hasCompleteHelperTree(noImage), true); assert.throws(() => assertActionableHelperSnapshot(noImage));
  } finally { await f.cleanup(); }
});

test("overlay evidence stays readable but blocks actions; service-only comparison permits navigation", async () => {
  const f = await setup();
  try {
    const snapshot = asSnapshot(await f.read()), changed = structuredClone(snapshot);
    const overlay = { id: "8", type: "input_method" as const, layer: 3, focused: false, active: false, bounds: { x: 0, y: 10, width: 10, height: 10 },
      rootAvailable: true, packageName: "keyboard.package" };
    changed.helperObservation!.windowsBefore.push(overlay); changed.helperObservation!.windowsAfter.push(structuredClone(overlay));
    assert.equal(isHelperObservationEvidence(changed.helperObservation), true);
    assert.equal(hasCompleteHelperTree(changed), true); assert.equal(hasActionableHelperEvidence(changed), false);
    const next = helperEvidence(500); next.windowId = "9"; next.windowsBefore[0].id = next.windowsAfter[0].id = "9";
    assertSameHelperServiceEvidence(snapshot.helperObservation!, next);
    assert.throws(() => assertSameHelperObservationSource(snapshot, { ...snapshot, helperObservation: next }), /窗口/);
    assert.throws(() => assertSameHelperObservationSource(snapshot, { ...snapshot, inspectionSource: "uiautomator" }), /来源/);
  } finally { await f.cleanup(); }
});

for (const scenario of ["rotation", "window-change", "unknown-visibility", "false-node-count", "foreign-node", "invalid-png", "jpeg", "truncated-png", "oversize", "unauthorized"] as const) {
  test(`v1 transport rejects ${scenario} and releases its forward`, async () => {
    const f = await setup();
    try {
      f.setCapture(res => {
        const p = helperPayload(f.image);
        if (scenario === "rotation") p.helperObservation.displayAfter.rotation = 1;
        if (scenario === "window-change") p.helperObservation.windowsAfter[0].id = "8";
        if (scenario === "unknown-visibility") p.xml = p.xml.replace('visible-to-user="true"', 'visible-to-user="unknown"');
        if (scenario === "false-node-count") p.node_count = 3;
        if (scenario === "foreign-node") p.xml = p.xml.replace('package="com.example.helper"', 'package="other.package"');
        if (scenario === "invalid-png") p.screenshot_base64 = Buffer.from("not PNG").toString("base64");
        if (scenario === "jpeg") p.screenshot_format = "jpeg";
        if (scenario === "truncated-png") p.screenshot_base64 = Buffer.from(f.image, "base64").subarray(0, 40).toString("base64");
        if (scenario === "oversize") { res.end(" ".repeat(33 * 1024 * 1024)); return; }
        if (scenario === "unauthorized") { res.writeHead(401).end(); return; }
        res.end(JSON.stringify(p));
      });
      await assert.rejects(f.read()); assert.equal(f.mapping(), undefined);
    } finally { await f.cleanup(); }
  });
}

test("metadata-only PNG dimensions do not bypass complete decode", async () => {
  const image = await png();
  const payload = helperPayload(image.subarray(0, 40).toString("base64"));
  await assert.rejects(readHelperObservation(1234, helperToken, helperPackage, helperFrame, new AbortController().signal,
    (async () => new Response(JSON.stringify(payload))) as typeof fetch), /PNG/);
});

test("a rejected read retains only validated recovery evidence, cleans its forward and never sends input", async () => {
  const f = await setup();
  try {
    const first = await f.read();
    const rejected = { ...helperPayload(f.image, 300), helperObservation: { ...helperEvidence(300), complete: false,
      diagnostics: { version: 1, reasons: [{ code: "child_unavailable", count: 1 }] } } };
    f.setCapture(res => res.end(JSON.stringify(rejected)));
    await assert.rejects(f.read(), error => {
      assert.ok(error instanceof HelperCaptureError);
      assert.equal(error.code, "helper-incomplete"); assert.ok(error.recoveryEvidence);
      assert.equal(error.recoveryEvidence.serviceInstanceId, first.helperObservation.serviceInstanceId);
      assert.equal(error.recoveryDiagnostics?.transport, "accepted"); assert.equal(error.recoveryDiagnostics?.candidate, "accepted");
      assert.equal(error.recoveryDiagnostics?.session, "accepted"); assert.equal(error.recoveryDiagnostics?.source, "accepted");
      return true;
    });
    assert.equal(f.mapping(), undefined);
    assert.equal(f.requests.filter(path => path === "/inspector/snapshot").length, 2);
    f.setCapture(res => res.end(JSON.stringify(helperPayload(f.image, 500))));
    assertActionableHelperSnapshot(asSnapshot(await f.read()));
    assert.equal(f.requests.filter(path => path === "/inspector/capabilities").length, 2);
    assert.ok(!f.commands.some(args => args.includes("input")));
  } finally { await f.cleanup(); }
});

for (const scenario of ["service-changed", "capture-replayed", "time-regressed", "token-changed", "forward-changed", "service-and-forward-changed"] as const) {
  test(`failed observations cannot expose a recovery candidate when ${scenario}`, async () => {
    const f = await setup();
    try {
      const first = await f.read();
      f.setCapture(res => {
        const evidence = { ...helperEvidence(scenario === "time-regressed" ? 1 : 300), complete: false,
          diagnostics: { version: 1, reasons: [{ code: "child_unavailable", count: 1 }] } };
        if (scenario === "service-changed" || scenario === "service-and-forward-changed") evidence.serviceInstanceId = randomUUID();
        if (scenario === "capture-replayed") evidence.captureId = first.helperObservation.captureId;
        if (scenario === "token-changed") f.setToken("changed_private_session_token");
        if (scenario === "forward-changed" || scenario === "service-and-forward-changed") f.takeover();
        res.end(JSON.stringify({ ...helperPayload(f.image, 300), helperObservation: evidence }));
      });
      await assert.rejects(f.read(), error => {
        assert.ok(error instanceof HelperCaptureError);
        assert.equal(error.recoveryEvidence, undefined);
        assert.ok(["helper-session", "helper-cleanup"].includes(error.code));
        assert.equal(error.recoveryDiagnostics?.session, scenario === "service-changed" || scenario === "service-and-forward-changed" ? "service_changed"
          : scenario === "capture-replayed" || scenario === "time-regressed" ? "source_rejected"
            : "binding_check_failed");
        assert.equal(error.recoveryDiagnostics?.cleanupFailed, scenario === "forward-changed" || scenario === "service-and-forward-changed" ? true : undefined);
        if (scenario === "capture-replayed" || scenario === "time-regressed") assert.equal(error.recoveryDiagnostics?.source,
          scenario === "capture-replayed" ? "capture_reused" : "capture_time_regressed");
        assert.ok(!JSON.stringify(error.recoveryDiagnostics).includes("changed_private_session_token"));
        return true;
      });
    } finally { await f.cleanup(); }
  });
}

for (const scenario of ["failed-capture-replayed", "failed-time-regressed", "success-capture-replayed", "success-time-regressed"] as const) {
  test(`the rejected-read cursor blocks ${scenario}`, async () => {
    const f = await setup();
    try {
      await f.read();
      const evidence = { ...helperEvidence(300), complete: false, diagnostics: { version: 1, reasons: [{ code: "child_unavailable", count: 1 }] } };
      f.setCapture(res => res.end(JSON.stringify({ ...helperPayload(f.image, 300), helperObservation: evidence })));
      await assert.rejects(f.read(), error => error instanceof HelperCaptureError && !!error.recoveryEvidence);
      f.setCapture(res => {
        const next = helperPayload(f.image, scenario.endsWith("regressed") ? 200 : 500);
        if (scenario.endsWith("replayed")) next.helperObservation.captureId = evidence.captureId;
        res.end(JSON.stringify(scenario.startsWith("failed") ? { ...next,
          helperObservation: { ...next.helperObservation, complete: false, diagnostics: evidence.diagnostics } } : next));
      });
      await assert.rejects(f.read(), error => error instanceof HelperCaptureError
        && error.code === "helper-session" && !error.recoveryEvidence);
    } finally { await f.cleanup(); }
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import sharp from "sharp";
import { createAccessibilityHelperSession } from "../electron/capture/helper-session";
import { readHelperObservation } from "../electron/capture/helper-observation";
import { assertActionableHelperSnapshot, assertSameHelperObservationSource, assertSameHelperServiceEvidence,
  hasActionableHelperEvidence, hasCompleteHelperTree, isHelperObservationEvidence } from "../shared/helper-observation";
import type { UiSnapshot } from "../shared/types";
import { helperCapabilities, helperEvidence, helperFrame, helperPackage, helperPayload, helperSerial, helperToken, helperXml } from "./fixtures/helper-protocol";

const png = () => sharp({ create: { ...helperFrame, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
type Fixture = Awaited<ReturnType<typeof setup>>;
async function setup() {
  const image = (await png()).toString("base64"), lifetime = new AbortController();
  let mapping: { local: string; remote: string } | undefined, token = helperToken, counter = 0;
  let capture: (res: ServerResponse) => void = res => { res.end(JSON.stringify(helperPayload(image, ++counter * 100))); };
  let capability = structuredClone(helperCapabilities);
  const requests: string[] = [], commands: string[][] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    assert.equal(req.method, "GET"); assert.equal(req.headers["x-artemis-token"], token);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/inspector/capabilities") res.end(JSON.stringify(capability));
    else if (req.url === "/inspector/snapshot") capture(res);
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
    mapping: () => mapping, takeover: () => { mapping!.remote = "tcp:19999"; },
    setToken: (value: string) => { token = value; },
    setCapabilities: (value: typeof helperCapabilities) => { capability = value; },
    setCapture: (handler: typeof capture) => { capture = handler; },
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

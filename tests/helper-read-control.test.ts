import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import sharp from "sharp";
import { readControlledHelperObservation } from "../electron/capture/helper-read-control";
import { helperPayload, helperToken, helperPackage, helperFrame, helperServiceId } from "./fixtures/helper-protocol";

async function setup() {
  const image = (await sharp({ create: { ...helperFrame, channels: 4, background: "#123456" } }).png().toBuffer()).toString("base64");
  const binding = { sessionId: randomUUID(), serviceInstanceId: helperServiceId, packageName: helperPackage };
  const requests: Array<{ path: string; method: string; body?: any }> = [];
  let capability: any = { success: true, protocolVersion: 1, serviceInstanceId: helperServiceId, maxTimeoutMs: 30000 };
  let unsupported = false, holdCancel = false;
  let capture = (res: ServerResponse, body: any) => res.end(JSON.stringify({ requestId: body.requestId, snapshot: helperPayload(image, 100) }));
  const server = createServer((req, res) => {
    assert.equal(req.headers["x-artemis-token"], helperToken);
    const row = { path: req.url!, method: req.method! } as typeof requests[number]; requests.push(row);
    let text = ""; req.on("data", data => { text += data; }); req.on("end", () => {
      row.body = text ? JSON.parse(text) : undefined;
      if (req.url === "/inspector/read-capabilities") {
        if (unsupported) res.writeHead(404).end(); else res.end(JSON.stringify(capability));
      } else if (req.url === "/inspector/read") capture(res, row.body);
      else if (req.url === "/inspector/snapshot") res.end(JSON.stringify(helperPayload(image, 200)));
      else if (req.url === "/inspector/cancel-read") { if (!holdCancel) res.end(JSON.stringify({ success: true, requestId: row.body.requestId, state: "cancelled" })); }
      else res.writeHead(404).end();
    });
  });
  const port = await new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return { requests, image, binding,
    read: (signal = new AbortController().signal, budget = 1000, after?: () => Promise<void>) =>
      readControlledHelperObservation(port, helperToken, binding, helperFrame, signal, budget, fetch, after),
    capture: (fn: typeof capture) => { capture = fn; }, capability: (value: any) => { capability = value; },
    unsupported: () => { unsupported = true; }, holdCancel: () => { holdCancel = true; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("controlled response keeps full tree/PNG validation and binds the request identity", async () => {
  const f = await setup();
  try {
    const result = await f.read(); assert.equal(result.helperObservation.packageName, helperPackage);
    assert.deepEqual(f.requests.map(r => r.method + " " + r.path), ["GET /inspector/read-capabilities", "POST /inspector/read"]);
    const body = f.requests[1].body; assert.equal(body.sessionId, f.binding.sessionId); assert.equal(body.serviceInstanceId, helperServiceId);
    assert(body.timeoutMs > 0 && body.timeoutMs <= 1000);
  } finally { await f.close(); }
});

test("only a missing controlled endpoint falls back to the existing observation path", async () => {
  const f = await setup();
  try { f.unsupported(); await f.read(); assert.deepEqual(f.requests.map(r => r.path), ["/inspector/read-capabilities", "/inspector/snapshot"]); }
  finally { await f.close(); }
});

for (const point of ["headers", "postcheck"] as const) test(`cancel during ${point} sends one bound cancel before rejecting and never retries`, async () => {
  const f = await setup(), abort = new AbortController();
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  try {
    f.capture((res, body) => {
      if (point === "headers") reached();
      else res.end(JSON.stringify({ requestId: body.requestId, snapshot: helperPayload(f.image, 100) }));
      return res;
    });
    const pending = f.read(abort.signal, 2000, point === "postcheck" ? async () => { reached(); await gate; } : undefined);
    const rejected = assert.rejects(pending, /cancel|abort/i);
    await entered; abort.abort(Error("cancel controlled read")); release(); await rejected;
    const reads = f.requests.filter(r => r.path === "/inspector/read"), cancels = f.requests.filter(r => r.path === "/inspector/cancel-read");
    assert.equal(reads.length, 1); assert.equal(cancels.length, 1); assert.deepEqual(cancels[0].body, reads[0].body);
    assert.equal(f.requests.some(r => r.path.includes("input") || r.path.includes("snapshot")), false);
  } finally { release?.(); await f.close(); }
});

test("foreign service never starts a controlled read", async () => {
  const f = await setup();
  try { f.capability({ success: true, protocolVersion: 1, serviceInstanceId: randomUUID(), maxTimeoutMs: 30000 });
    await assert.rejects(f.read()); assert.equal(f.requests.length, 1); }
  finally { await f.close(); }
});

for (const kind of ["request", "png"] as const) test(`invalid ${kind} evidence is rejected and only its original read is cancelled`, async () => {
  const f = await setup();
  try {
    f.capture((res, body) => {
      const snapshot = helperPayload(f.image, 100); if (kind === "png") snapshot.screenshot_base64 = "invalid";
      return res.end(JSON.stringify({ requestId: kind === "request" ? randomUUID() : body.requestId, snapshot }));
    });
    await assert.rejects(f.read()); assert.equal(f.requests.filter(r => r.path === "/inspector/read").length, 1);
    assert.equal(f.requests.filter(r => r.path === "/inspector/cancel-read").length, 1);
  } finally { await f.close(); }
});

test("a missing cancellation reply cannot keep the owned connection alive indefinitely", async () => {
  const f = await setup(), abort = new AbortController(); let reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  try {
    f.holdCancel(); f.capture(res => { reached(); return res; });
    const pending = f.read(abort.signal, 2000), rejected = assert.rejects(pending);
    await entered; const started = performance.now(); abort.abort(Error("cancel")); await rejected;
    assert(performance.now() - started < 2000); assert.equal(f.requests.filter(r => r.path === "/inspector/cancel-read").length, 1);
  } finally { await f.close(); }
});

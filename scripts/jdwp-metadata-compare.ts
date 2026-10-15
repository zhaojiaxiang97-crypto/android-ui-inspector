// Stable settings page, selected native leaves only. No restart/install/navigation.
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { captureViewBitmaps } from "../electron/capture/view-bitmaps";
import { probeWindowName } from "../electron/capture/view-debug";
import { businessSettingsPid } from "./business-process";
import { parseProcessLoad } from "./diagnostics/sdk/sdk-device-load";

const serial = process.argv[2];
assert.ok(serial && /^[\w.:-]+$/.test(serial), "Usage: bun scripts/jdwp-metadata-compare.ts SERIAL");
const pkg = "com.smile.gifmaker", uri = `content://${pkg}.inspector`;
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 15000, maxBuffer: 2000000 });
const asyncAdb = async (...args: string[]) => (await promisify(execFile)("adb", ["-s", serial, ...args], { timeout: 5000 })).stdout;
const field = (reply: string, key: string) => new RegExp(`\\b${key}=([^,}\\]]+)`).exec(reply)?.[1]?.trim();
mkdirSync(".benchmarks", { recursive: true });
const output = mkdtempSync(".benchmarks/jdwp-metadata-compare-");
const rows: any[] = [];
let port: string | undefined;
let instance: string | undefined, geometry: string | undefined, rootRef: string | undefined;
console.log(`Metadata comparison: ${output}`);
const save = (extra = {}) => writeFileSync(`${output}/report.json`, JSON.stringify({ rows, ...extra }, null, 2));
const page = () => assert.match(adb("shell", "dumpsys", "window"), /mCurrentFocus=.*com\.smile\.gifmaker\/com\.yxcorp\.plugin\.setting\.activity\.SettingsActivity/, "Settings main page required");
try {
  page();
  const pid = businessSettingsPid(adb, pkg);
  const ticks = parseProcessLoad(adb("exec-out", "run-as", pkg, "cat", `/proc/${pid}/stat`), pid).startTicks;
  const tree = () => {
    page(); assert.equal(businessSettingsPid(adb, pkg), pid);
    assert.equal(parseProcessLoad(adb("exec-out", "run-as", pkg, "cat", `/proc/${pid}/stat`), pid).startTicks, ticks);
    const reply = adb("shell", "content", "call", "--uri", uri, "--method", "capture");
    assert.equal(field(reply, "result"), "ok", reply);
    const data = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "no_backup/inspector-hierarchy.json"));
    assert.equal(data.pid, Number(pid)); instance ??= data.processInstance; assert.equal(data.processInstance, instance);
    rootRef ??= data.root.ref; assert.equal(data.root.ref, rootRef);
    assert.equal(data.uiWakeVersion, 1);
    const nodes: any[] = [], queue = [data.root];
    while (queue.length) { const node = queue.pop(); nodes.push(node); queue.push(...node.children); }
    const selected = ["设置", "隐私设置", "通知设置"].map(text => {
      const found = nodes.filter(n => n.text === text && n.visible && n.width > 0 && n.height > 0 && n.hardwareAccelerated === true && !n.children.length && n.className.endsWith("TextView"));
      assert.equal(found.length, 1, `Need one native visible leaf for ${text}`); return found[0];
    });
    const signature = JSON.stringify(selected.map(n => [n.ref, n.screenX, n.screenY, n.width, n.height, n.text]));
    geometry ??= signature; assert.equal(signature, geometry, "Object identity/geometry changed");
    return selected;
  };
  const selected = tree();
  port = adb("forward", "tcp:0", `jdwp:${pid}`).trim(); assert.match(port, /^\d+$/);
  const windowName = await probeWindowName(Number(port), [rootRef!], AbortSignal.timeout(5000));
  const target = { rootRef: rootRef!, windowName, hardwareAccelerated: true, wakeUi: async () => {
    const nonce = randomBytes(8).toString("hex");
    const reply = await asyncAdb("shell", "content", "call", "--uri", uri, "--method", "wake-ui", "--arg", nonce, "--extra", `processInstance:s:${instance}`);
    for (const [key, value] of Object.entries({ result: "ok", nonce, processInstance: instance!, pid })) assert.equal(field(reply, key), value);
  } };
  const refs = selected.map(n => ({ ref: n.ref, captureOwn: true }));
  let pixels: string | undefined, requests: number | undefined;
  const capture = async (batch: boolean, name: string) => {
    tree(); const started = performance.now();
    const result = await captureViewBitmaps(Number(port), { ...target, metadataBatch: batch }, refs, AbortSignal.timeout(15000));
    const durationMs = performance.now() - started;
    const images = [...result.images].map(([ref, image]) => {
      const bytes = Buffer.from(image.imageDataUrl.split(",")[1], "base64");
      writeFileSync(`${output}/${name}-${refs.findIndex(n => n.ref === ref)}.png`, bytes);
      const chunks: Buffer[] = []; let at = 8;
      while (at < bytes.length) { const size = bytes.readUInt32BE(at); if (bytes.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(bytes.subarray(at + 8, at + 8 + size)); at += size + 12; }
      const raw = inflateSync(Buffer.concat(chunks));
      assert.equal(raw.length, image.height * (image.width * 4 + 1));
      for (let y = 0; y < image.height; y++) assert.equal(raw[y * (image.width * 4 + 1)], 0, "Expected native encoder unfiltered RGBA");
      return { ref, width: image.width, height: image.height, kind: image.kind, empty: image.empty, sha256: createHash("sha256").update(raw).digest("hex") };
    }).sort((a, b) => a.ref.localeCompare(b.ref));
    const row = { name, batch, durationMs, timing: result.timing, images, failures: [...result.failures] };
    rows.push(row); save({ pid, instance, scope: "three native settings leaves, not whole-page performance" });
    assert.equal(result.failures.size, 0); assert.equal(images.length, refs.length);
    const signature = JSON.stringify(images); pixels ??= signature; assert.equal(signature, pixels, "Exact pixels differ");
    requests ??= result.timing.setupRequests; assert.equal(result.timing.setupRequests, requests, "Setup request count changed");
    tree(); return row;
  };
  for (const [i, batch] of [false, true, true, false].entries()) {
    const row = await capture(batch, `abba-${i}`);
    console.log(JSON.stringify({ block: i, batch, metadataMs: row.timing.metadataMs, setupMs: row.timing.setupMs, requests: row.timing.setupRequests }));
  }
  tree();
  const cancelledAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("metadata-comparison-cancel")), 300);
  try {
    await assert.rejects(captureViewBitmaps(Number(port), { ...target, metadataBatch: true }, refs, controller.signal), /metadata-comparison-cancel/);
  } finally { clearTimeout(timer); }
  const cancelMs = performance.now() - cancelledAt;
  tree();
  const recovery = await capture(true, "recovery");
  save({ passed: true, pid, instance, cancelMs, recoveryImages: recovery.images.length,
    cancellationPhase: "timer-based, exact request phase not established", scope: "ABBA on three native leaves; exact unfiltered RGBA and dimensions; not whole-page performance" });
  console.log(JSON.stringify({ passed: true, blocks: 4, imagesPerBlock: refs.length, cancelMs, sameProcessRecovery: true, output }));
} catch (error) { save({ passed: false, error: String(error) }); throw error; }
finally { if (port) adb("forward", "--remove", `tcp:${port}`); }

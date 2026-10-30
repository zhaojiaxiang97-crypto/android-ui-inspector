// Isolated Electron IPC + real SDK. Delay replies on the host, never block the app UI.
import assert from "node:assert/strict";
import net from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { awaitEndpoint, connectCdp, createWaits, evaluateValue, pageTarget, shutdownProbeElectron, spawnProbeElectron, waitForElectronApi, type CdpCall } from "../../lib/probe-harness";
const [serial, text] = process.argv.slice(2);
const workbench = process.argv.includes("--workbench");
const wakeProbe = process.argv.includes("--wake-ui");
const legacySoftware = process.argv.includes("--legacy-software");
const noSdkWake = process.argv.includes("--no-sdk-wake") || legacySoftware;
const fixturePackage = process.argv.find(arg => arg.startsWith("--fixture-package="))?.split("=")[1] ?? (legacySoftware ? "com.androiduiinspector.legacywindow" : "com.androiduiinspector.sample");
assert.ok(fixturePackage === "com.androiduiinspector.sample" || noSdkWake && fixturePackage === "com.androiduiinspector.sdkfree"
  || legacySoftware && fixturePackage === "com.androiduiinspector.legacywindow", "only known sample packages are allowed");
assert.ok(!(workbench && (wakeProbe || noSdkWake)) && !(wakeProbe && noSdkWake), "probe modes cannot be combined");
assert.ok(serial && /^[\w.-]+$/.test(serial) && text, "SERIAL TEXT required");
const project = fileURLToPath(new URL("../../../", import.meta.url));
const output = mkdtempSync(join(tmpdir(), "inspector-desktop-cancel-"));
const journal = join(output, "forwards.jsonl");
writeFileSync(journal, "");
const realAdb = execFileSync("which", ["adb"], { encoding: "utf8" }).trim();
const sockets = new Set<net.Socket>();
const timers = new Set<ReturnType<typeof setTimeout>>();
const events: Array<{ type: string; mode?: string; ok?: boolean }> = [];
let armed: "abort" | "timeout" | null = null;
const proxy = net.createServer(client => {
  sockets.add(client);
  const opened = readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.type === "open").at(-1);
  assert.ok(opened);
  const upstream = net.connect({ host: "127.0.0.1", port: opened.port });
  sockets.add(upstream);
  client.on("error", () => {}); upstream.on("error", () => client.destroy());
  client.on("close", () => { sockets.delete(client); upstream.destroy(); });
  upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
  let requestBuffer = "", replyBuffer = "";
  const queue: Array<"abort" | "timeout" | null> = [];
  client.on("data", chunk => {
    requestBuffer += chunk.toString();
    let at: number;
    while ((at = requestBuffer.indexOf("\n")) >= 0) {
      const line = requestBuffer.slice(0, at); requestBuffer = requestBuffer.slice(at + 1);
      const request = JSON.parse(line);
      const mode = (wakeProbe ? request.method === "wake-ui" : request.method === "capture-refs" && (request.extras?.debugCanvas === true || workbench)
        || workbench && request.method === "capture") ? armed : null;
      if (mode) { armed = null; events.push({ type: "request", mode }); }
      queue.push(mode); upstream.write(line + "\n");
    }
  });
  upstream.on("data", chunk => {
    replyBuffer += chunk.toString();
    let at: number;
    while ((at = replyBuffer.indexOf("\n")) >= 0) {
      const line = replyBuffer.slice(0, at); replyBuffer = replyBuffer.slice(at + 1);
      const mode = queue.shift();
      if (!mode) { client.write(line + "\n"); continue; }
      events.push({ type: "held", mode, ok: /\bresult=ok\b/.test(line) });
      const timer = setTimeout(() => {
        timers.delete(timer);
        events.push({ type: client.destroyed ? "late-dropped" : "released", mode });
        if (!client.destroyed) client.write(line + "\n");
      }, mode === "abort" ? 2500 : wakeProbe ? 5000 : 33000);
      timers.add(timer);
    }
  });
});
await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
const sdkHome = join(output, "sdk"); mkdirSync(join(sdkHome, "platform-tools"), { recursive: true });
symlinkSync(join(project, "scripts/lib/delayed-session-adb"), join(sdkHome, "platform-tools/adb"));
const { child, endpoint } = spawnProbeElectron({ project, userDataDir: join(output, "profile"), logDir: output, env: {
  ANDROID_HOME: sdkHome, ANDROID_SDK_ROOT: sdkHome, INSPECTOR_ENABLE_SDK_TEXT_REFRESH: wakeProbe || noSdkWake ? "0" : "1",
  INSPECTOR_PROBE_REAL_ADB: realAdb, INSPECTOR_PROBE_FORWARD_LOG: journal,
  INSPECTOR_PROBE_PROXY_PORT: String((proxy.address() as net.AddressInfo).port),
} });
let browser: CdpCall | undefined, page: CdpCall | undefined;
const waits = createWaits(child);
const evaluate = async <T>(expression: string): Promise<T> => {
  const reply = await evaluateValue<T>(page!, expression);
  assert.equal(reply.exceptionText, null, reply.exceptionText ?? "");
  return reply.value as T;
};
let packageName: string | undefined;
const checkCaptureFiles = () => {
  assert.ok(packageName && /^[\w.]+$/.test(packageName));
  for (const name of ["no_backup/inspector-ref-layers.bin", "no_backup/inspector-ref-layers.bin.tmp"]) {
    const result: ReturnType<typeof spawnSync> = spawnSync(realAdb, ["-s", serial, "shell", "run-as", packageName!, "test", "-e", name], { timeout: 10000 });
    assert.equal(result.status, 1, "SDK refresh output was not removed");
  }
};
console.log(`Private probe output: ${output}`);
try {
  const endpointUrl = await awaitEndpoint(endpoint, "Electron", 30000);
  browser = await connectCdp(endpointUrl);
  const pageUrl = await waits.waitForValue("app page", 30000, () => pageTarget(Number(new URL(endpointUrl).port)));
  page = await connectCdp(pageUrl); await waitForElectronApi(page);
  if (workbench) {
    const clickUi = async (selector: string) => {
      const point = await evaluate<{ x: number; y: number }>(`(() => {
        const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) throw Error('Unavailable UI: ' + ${JSON.stringify(selector)});
        e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); if (!r.width || !r.height) throw Error('Hidden UI');
        const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); if(hit!==e && !e.contains(hit)) throw Error('UI covered: '+${JSON.stringify(selector)}+' by '+hit?.className);
        return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      await page!.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await page!.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    await evaluate(`window.__workbenchProbe = { read: () => {
      const host = document.getElementById('root'); const key = Object.keys(host).find(k => k.startsWith('__reactContainer'));
      const queue = [host[key].stateNode.current]; while (queue.length) {
        const f = queue.pop(); if (f.child) queue.push(f.child); if (f.sibling) queue.push(f.sibling);
        let h = f.memoizedState; while (h && typeof h === 'object') { const s = h.memoizedState;
          if (s && s.root && typeof s.serial === 'string' && typeof s.nodeCount === 'number') return s; h=h.next; }
      } return null; } }; true`);
    await waits.waitForAsync("connected home", 30000, () => evaluate("!!document.querySelector('.home-connection-status .ready') && !document.querySelector('.home-primary-action').disabled"));
    await clickUi(".home-primary-action");
    await waits.waitForAsync("workbench capture", 90000, () => evaluate("!!window.__workbenchProbe.read()?.root && !!document.querySelector('.snapshot-summary') && Array.from(document.querySelectorAll('.snapshot-actions button')).some(b=>b.textContent==='保存快照' && !b.disabled)"));
    const ready = await evaluate<{ packageName: string; error: string | null; source: string }>(`(() => {const s=window.__workbenchProbe.read(); return {packageName:s.root.package,error:s.error,source:s.inspectionSource};})()`);
    assert.equal(ready.error, null); assert.equal(ready.source, "debug-hybrid"); packageName = ready.packageName;
    console.log(JSON.stringify({ phase: "workbench-capture", source: ready.source }));
    await clickUi(".inspector-close");
    await clickUi(".snapshot-drawer:not(.debug-drawer) > summary");
    // Find the visible save action by its label; data markers are test-only DOM metadata.
    await evaluate(`Array.from(document.querySelectorAll('.snapshot-actions button')).find(b=>b.textContent==='保存快照').dataset.probeSave='true'; true`);
    await clickUi('[data-probe-save="true"]');
    await waits.waitForAsync("saved history", 15000, () => evaluate("!!document.querySelector('.snapshot-history-item')"));
    await clickUi(".snapshot-drawer:not(.debug-drawer) > summary");
    await clickUi(".view-mode-toggle button:last-child");
    await waits.waitForAsync("real 3D workbench", 15000, () => evaluate("!!document.querySelector('.layer-scene')"));
    const chooseText = async () => {
      await clickUi(".tree-search"); await page!.send("Input.insertText", { text });
      await waits.waitForAsync("text row", 10000, () => evaluate(`Array.from(document.querySelectorAll('.tree-row')).some(e=>e.textContent.includes(${JSON.stringify(text)}))`));
      await evaluate(`const s=window.__workbenchProbe.read(); let parent; const visit=n=>{for(const c of n.children){if(c.text===${JSON.stringify(text)})parent=n;visit(c);}}; visit(s.root);
        if(!parent)throw Error('Text parent not found'); document.querySelector('[data-tree-id="'+parent.id+'"]').dataset.probeText='true'; true`);
      await clickUi('[data-probe-text="true"]');
      if (await evaluate("document.querySelector('.floating-inspector')?.hidden === true")) await clickUi(".inspector-toggle");
      await evaluate(`const details=document.querySelector('.inspector-image'); if(details) details.open=true; true`);
      await evaluate(`Array.from(document.querySelectorAll('.inspector-image-refresh')).find(b=>b.textContent==='刷新此分支').dataset.probeRefresh='true'; true`);
    };
    await chooseText();
    armed = "abort"; await clickUi('[data-probe-refresh="true"]');
    await waits.waitForAsync("real workbench reply held", 45000, async () => events.some(e=>e.type === "held"));
    assert.equal(events.find(e=>e.type === "held")?.ok, true);
    await clickUi(".snapshot-drawer:not(.debug-drawer) > summary");
    await clickUi(".snapshot-history-item");
    await waits.waitForAsync("history selection", 10000, () => evaluate("!document.querySelector('.inspector-image-refresh') && !!document.querySelector('.snapshot-status')?.textContent.includes('历史快照')"));
    // Switching history intentionally starts a new preview session in 2D.
    await waits.waitForAsync("history preview", 10000, () => evaluate("!!document.querySelector('.screenshot-frame') && !document.querySelector('.layer-scene')"));
    await evaluate(`const p=window.__workbenchProbe; p.history=p.read(); p.scene=document.querySelector('.screenshot-frame'); p.selected=document.querySelector('.floating-inspector')?.dataset.nodeId; true`);
    await waits.waitForAsync("history discarded old reply", 10000, async () => events.some(e=>e.type === "late-dropped"));
    const preserved = await evaluate<boolean>(`(() => {const p=window.__workbenchProbe; return p.read()===p.history && !!p.scene && document.querySelector('.screenshot-frame')===p.scene && !document.querySelector('.layer-scene') && document.querySelector('.floating-inspector')?.dataset.nodeId===p.selected && !document.querySelector('.inspector-image-note[role=status]');})()`);
    assert.equal(preserved, true); checkCaptureFiles();
    console.log(JSON.stringify({ passed: true, workbench: true, scope: "branch", actualMouseClicks: true, historyCancelsRefresh: true, snapshotSceneSelectionPreserved: true, filesCleaned: true }));
  } else {
  await evaluate(`window.__textProbe = { requestId: crypto.randomUUID() }; window.electronApi.probeAdb()`);
  const capture = await evaluate<{ error: string | null; source: string; matches: number; packageName: string }>(`(async () => {
    const p = window.__textProbe; p.snapshot = await window.electronApi.inspectDevice(${JSON.stringify(serial)}, p.requestId);
    const all = []; const walk = n => { all.push(n); n.children.forEach(walk); }; if (p.snapshot.root) walk(p.snapshot.root);
    const matches = all.filter(n => n.text === ${JSON.stringify(text)} && n.className.endsWith('TextView') && !n.children.length);
    p.node = matches[0]; p.original = JSON.stringify(p.node);
    p.pixels = async n => { const image = new Image(); image.src = n.layerImageDataUrl; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const hash = await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, canvas.width, canvas.height).data);
      return JSON.stringify({ w: canvas.width, h: canvas.height, bounds: n.bounds, sha: Array.from(new Uint8Array(hash)).map(v => v.toString(16).padStart(2, '0')).join('') }); };
    p.baseline = p.node && !${noSdkWake} ? await p.pixels(p.node) : null;
    if (${wakeProbe} || ${noSdkWake}) {
      if (p.snapshot.root?.package !== ${JSON.stringify(fixturePackage)}) throw Error('Wake probes are sample-only');
      if (p.snapshot.root.children[0].attributes['hardware-accelerated'] !== 'false') throw Error('Software window required');
      if (${wakeProbe} && p.snapshot.root.attributes['sdk-ui-wake-version'] !== '1') throw Error('New safe wake SDK required');
      if (${legacySoftware} && p.snapshot.root.attributes['sdk-ui-wake-version'] === '1') throw Error('Real old SDK required');
    }
    return { error: p.snapshot.error, source: p.snapshot.inspectionSource, matches: matches.length, packageName: p.snapshot.root?.package };
  })()`);
  packageName = capture.packageName;
  console.log(JSON.stringify({ phase: "capture", ...capture }));
  assert.equal(capture.error, null); assert.equal(capture.source, noSdkWake && !legacySoftware ? "debug-view" : "debug-hybrid"); assert.equal(capture.matches, 1);
  const begin = () => evaluate(`(() => { const p = window.__textProbe; p.result = null;
    p.pending = window.electronApi.refreshViewNode(p.requestId, p.node.id).then(r => p.result = { ok: true, failures: r.failures.length }, e => p.result = { ok: false, error: String(e) }); return true; })()`);
  if (noSdkWake) {
    await begin();
    await waits.waitForAsync("software window safely rejected", 15000, async () => !!await evaluate("window.__textProbe.result"));
    const rejected = await evaluate<{ ok: boolean; error: string }>("window.__textProbe.result");
    assert.equal(rejected.ok, false); assert.match(rejected.error, /软件窗口需要新版 SDK/);
    assert.equal(await evaluate("window.__textProbe.original === JSON.stringify(window.__textProbe.node)"), true);
    console.log(JSON.stringify({ passed: true, noSdkSoftwareSafelyRejected: true, rendererInputUnchanged: true }));
  } else {
  armed = "abort"; await begin();
  await waits.waitForAsync("real SDK abort reply", 45000, async () => events.some(e => e.type === "held" && e.mode === "abort"));
  assert.equal(events.find(e => e.type === "held" && e.mode === "abort")?.ok, true);
  console.log(JSON.stringify({ phase: "cancel", realReplyHeld: true }));
  const recovery = await evaluate<{ failures: number }>(`(async () => { const p = window.__textProbe;
    const r = await window.electronApi.refreshViewNode(p.requestId, p.node.id); await p.pending; return { failures: r.failures.length }; })()`);
  assert.equal(recovery.failures, 0);
  const cancelled = await evaluate<{ ok: boolean; error: string }>("window.__textProbe.result");
  assert.equal(cancelled.ok, false); assert.match(cancelled.error, /abort|取消/i);
  await waits.waitForAsync("late abort discarded", 10000, async () => events.some(e => e.type === "late-dropped" && e.mode === "abort"));
  checkCaptureFiles();
  armed = "timeout"; await begin();
  console.log(JSON.stringify({ phase: "timeout", waitingForProductionDeadline: true }));
  await waits.waitForAsync("timeout rejection", 45000, async () => !!await evaluate("window.__textProbe.result"));
  const timeout = await evaluate<{ ok: boolean; error: string }>("window.__textProbe.result");
  assert.equal(timeout.ok, false); assert.match(timeout.error, wakeProbe ? /会话调用超时：wake-ui/ : /会话调用超时：capture-refs/);
  checkCaptureFiles();
  await waits.waitForAsync("late timeout discarded", 10000, async () => events.some(e => e.type === "late-dropped" && e.mode === "timeout"));
  const restored = await evaluate<{ failures: number; unchanged: boolean; pixelsMatch: boolean }>(`(async () => { const p = window.__textProbe;
    const r = await window.electronApi.refreshViewNode(p.requestId, p.node.id);
    return { failures: r.failures.length, unchanged: p.original === JSON.stringify(p.node), pixelsMatch: p.baseline === await p.pixels(r.nodes[0]) }; })()`);
  assert.equal(restored.failures, 0); assert.equal(restored.unchanged, true); assert.equal(restored.pixelsMatch, true);
  checkCaptureFiles();
  console.log(JSON.stringify({ passed: true, wakeUi: wakeProbe, capture: { error: capture.error, source: capture.source, matches: capture.matches }, cancellation: true, timeout: true, lateDropped: true, recovery: true, rendererInputUnchanged: true, pixelsMatch: true, filesCleaned: true, events }));
  }
  }
} catch (error) {
  if (page) console.log(JSON.stringify({ phase: "failure", ui: await evaluate("({status:document.querySelector('.snapshot-status')?.textContent,storeError:document.querySelector('.snapshot-store-error')?.textContent})").catch(() => null) }));
  throw error;
} finally {
  page?.close();
  if (browser) await shutdownProbeElectron(child, browser); else child.kill();
  for (const timer of timers) clearTimeout(timer);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => proxy.close(() => resolve()));
  const owned = readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(e => e.type === "open");
  let forwards = execFileSync(realAdb, ["forward", "--list"], { encoding: "utf8" });
  for (const entry of owned) {
    if (forwards.split('\n').some(line => { const [device, local] = line.trim().split(/\s+/); return device === serial && local === `tcp:${entry.port}`; }))
      execFileSync(realAdb, ["-s", serial, "forward", "--remove", `tcp:${entry.port}`]);
  }
  forwards = execFileSync(realAdb, ["forward", "--list"], { encoding: "utf8" });
  for (const entry of owned) assert.equal(forwards.split('\n').some(line => { const [device, local] = line.trim().split(/\s+/); return device === serial && local === `tcp:${entry.port}`; }), false, "owned SDK forward leaked");
}

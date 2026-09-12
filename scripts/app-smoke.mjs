import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL("../", import.meta.url));
const packaged = process.argv.includes("--packaged");
const requireDevice = process.argv.includes("--require-device");
const expectLandscape = process.argv.includes("--expect-landscape");
if (process.argv.slice(2).some((value) => !["--packaged", "--require-device", "--expect-landscape"].includes(value))) throw new Error("Supported options: --packaged --require-device --expect-landscape");
require("./prepare-windows-runtime.cjs").prepareWindowsRuntime(packaged ? "Unpacked" : "Development");
const output = join(project, ".benchmarks", "app-smoke", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const executable = packaged ? join(project, "release/win-unpacked/Android UI Inspector.exe") : require("electron");
const args = [...(packaged ? [] : [project]), "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${join(output, "profile")}`];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
const child = spawn(executable, args, { cwd: project, env: environment, windowsHide: true });
console.log(`Smoke test output: ${output}`);
let stderr = "";
let stdout = "";
let endpoint = null;
let exited = false;
let launchError = null;
child.stdout.on("data", (value) => { stdout += String(value); appendFileSync(join(output, "stdout.log"), value); });
child.stderr.on("data", (value) => {
  stderr += String(value);
  appendFileSync(join(output, "stderr.log"), value);
  const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
  if (match) endpoint = match[1];
});
child.on("exit", () => { exited = true; });
child.on("error", (error) => { launchError = error; exited = true; });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(operation, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Application exited during ${label}: ${launchError || stderr.slice(-1500)}`);
    const result = await operation();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Timed out: debugger connection")); }, 5000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Debugger connection failed")); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown" || message.method === "Network.loadingFailed" || (message.method === "Log.entryAdded" && message.params.entry.level === "error")) errors.push(message);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("Application debugger disconnected")); }
    pending.clear();
  });
  return {
    errors,
    close: () => socket.close(),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 20_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    }),
  };
}

let connection;
const report = { generatedAt: new Date().toISOString(), packaged, success: false, checks: [] };
const recordCheck = (label) => { report.checks.push(label); console.log(`PASS: ${label}`); };
try {
  await until(() => endpoint, "debugger startup");
  const address = new URL(endpoint);
  const page = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${address.port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    return pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  }, "application window");
  connection = await connect(page.webSocketDebuggerUrl);
  await connection.send("Runtime.enable");
  await connection.send("Log.enable");
  await connection.send("Network.enable");
  const evaluate = async (expression) => {
    const result = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await until(() => evaluate("Boolean(document.querySelector('.app-shell') && window.electronApi)"), "React and preload");
  const runtime = await evaluate("({ ...window.electronApi.runtime, nodeExposed: typeof window.require !== 'undefined', heading: document.querySelector('h1')?.textContent })");
  assert.equal(runtime.sandboxed, true);
  assert.equal(runtime.contextIsolated, true);
  assert.equal(runtime.nodeExposed, false);
  assert.equal(runtime.heading, "UI Inspector");
  report.runtime = runtime;
  recordCheck("sandboxed React window and preload");
  await until(() => evaluate("!document.querySelector('.refresh-button').disabled"), "initial device probe");
  await evaluate("document.querySelector('.refresh-button').click()");
  await until(() => evaluate("!document.querySelector('.refresh-button').disabled"), "device refresh");
  recordCheck("device refresh button");
  const deviceCount = await evaluate("document.querySelectorAll('.inspect-button:not([disabled])').length");
  report.readyDevices = deviceCount;
  if (requireDevice) assert.ok(deviceCount > 0, "Expected a connected and authorized Android device");
  if (deviceCount > 0) {
    await evaluate("document.querySelector('.inspect-button:not([disabled])').click()");
    await until(() => evaluate("Boolean(document.querySelector('.tree-row') || document.querySelector('.error-placeholder'))"), "UIAutomator inspection", 60_000);
    const error = await evaluate("document.querySelector('.error-placeholder p')?.textContent");
    assert.ok(!error, error);
    const initialId = await evaluate("document.querySelector('.node-id')?.textContent");
    const rowCount = await evaluate("document.querySelectorAll('.tree-row').length");
    report.inspectionSummary = await evaluate("document.querySelector('.inspector-heading-meta > span').textContent");
    assert.match(report.inspectionSummary, /完整 hierarchy/, "Packaged inspection did not use full UI hierarchy mode");
    const hierarchyNote = await evaluate("document.querySelector('.hierarchy-note')?.textContent || ''");
    if (hierarchyNote) assert.match(hierarchyNote, /VirtualChild/, "Virtual accessibility note is incomplete");
    if (rowCount > 1) {
      await evaluate("document.querySelectorAll('.tree-row')[1].click()");
      await until(() => evaluate(`document.querySelector('.node-id').textContent !== ${JSON.stringify(initialId)}`), "tree selection");
    }
    assert.equal(await evaluate("document.querySelectorAll('.tree-row.selected').length"), 1);
    recordCheck("real-device hierarchy and tree selection");
    await evaluate("document.querySelector('.tree-expand-all').click()");
    await until(() => evaluate("document.querySelectorAll('.tree-row').length > 1"), "full hierarchy expansion");
    const virtualNode = await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.tree-row')).find((item) => item.querySelector('.tree-class')?.textContent?.includes('VirtualChild'));
      if (!row) return null;
      row.click();
      return row.dataset.treeId;
    })()`);
    if (virtualNode) {
      await until(() => evaluate("Boolean(document.querySelector('.node-source-note') && document.querySelector('.node-attributes'))"), "virtual node details");
      const attributeNames = await evaluate("Array.from(document.querySelectorAll('.node-attributes-list dt')).map((item) => item.textContent)");
      assert.ok(attributeNames.includes("long-clickable"), "Raw UIAutomator attributes are not shown");
      recordCheck("full hierarchy mode, virtual-node warning and raw attributes");
    }
    await evaluate("document.querySelector('.tree-collapse-all').click()");
    await until(() => evaluate("document.querySelectorAll('.tree-row').length === 1"), "collapse before screenshot reveal");
    await until(() => evaluate("document.querySelector('.screenshot-stage img')?.naturalWidth > 0 && Boolean(document.querySelector('.selection-overlay'))"), "screenshot and bounds");
    await evaluate("document.querySelector('.screenshot-stage').scrollIntoView({block:'center', behavior:'instant'})");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const point = await evaluate(`(() => {
      const image = document.querySelector('.screenshot-stage img');
      const rect = image.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, deviceX: image.naturalWidth / 2, deviceY: image.naturalHeight / 2, imageWidth: image.naturalWidth, imageHeight: image.naturalHeight };
    })()`);
    const clickScreenshot = async () => {
      await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    };
    const revealed = () => evaluate(`(() => {
      const selected = document.querySelector('.tree-row.selected');
      const viewport = document.querySelector('.ui-tree-scroll');
      if (!selected || selected.dataset.treeId !== document.querySelector('.node-id').textContent.slice(1)) return false;
      const row = selected.getBoundingClientRect(), frame = viewport.getBoundingClientRect();
      return row.top >= frame.top - 1 && row.bottom <= frame.bottom + 1;
    })()`);
    await clickScreenshot();
    await until(revealed, "screenshot selection reveals its tree row");
    await delay(150);
    const bounds = await evaluate("Array.from(document.querySelectorAll('.node-details dl div')).find(row => row.querySelector('dt').textContent === 'bounds')?.querySelector('dd').textContent");
    const values = bounds?.match(/-?\d+/g)?.map(Number);
    assert.equal(values?.length, 4, "Selected node has no bounds");
    assert.ok(values[0] <= point.deviceX && values[2] > point.deviceX && values[1] <= point.deviceY && values[3] > point.deviceY, "Screenshot reverse lookup bounds do not contain the clicked point");
    report.screenshot = { width: point.imageWidth, height: point.imageHeight };
    if (expectLandscape) assert.ok(point.imageWidth > point.imageHeight, "Expected a landscape device capture");
    recordCheck("screenshot bounds highlight and reverse lookup");
    const geometry = await evaluate(`(() => {
      const image = document.querySelector('.screenshot-stage img'), stage = document.querySelector('.screenshot-stage');
      const i = image.getBoundingClientRect(), s = stage.getBoundingClientRect(), o = document.querySelector('.selection-overlay').getBoundingClientRect();
      return { status: stage.dataset.coordinateStatus, message: document.querySelector('.screenshot-status').textContent,
        image: { left: i.left, top: i.top, width: i.width, height: i.height }, stage: { left: s.left, top: s.top, width: s.width, height: s.height },
        overlay: { left: o.left, top: o.top, right: o.right, bottom: o.bottom } };
    })()`);
    assert.ok(["checked", "unverified"].includes(geometry.status), "Capture geometry mismatch");
    if (expectLandscape) assert.equal(geometry.status, "checked", "Landscape acceptance requires display metadata");
    for (const field of ["left", "top", "width", "height"]) assert.ok(Math.abs(geometry.image[field] - geometry.stage[field]) < 0.08, `Image/stage ${field} differ`);
    const i = geometry.image;
    const expectedOverlay = { left: i.left + Math.max(0, values[0]) / point.imageWidth * i.width, top: i.top + Math.max(0, values[1]) / point.imageHeight * i.height,
      right: i.left + Math.min(point.imageWidth, values[2]) / point.imageWidth * i.width, bottom: i.top + Math.min(point.imageHeight, values[3]) / point.imageHeight * i.height };
    for (const edge of ["left", "top", "right", "bottom"]) assert.ok(Math.abs(geometry.overlay[edge] - expectedOverlay[edge]) < 0.08, `Projected overlay ${edge} differs`);
    assert.ok(Math.abs(i.height - i.width * point.imageHeight / point.imageWidth) < 0.08, "Screenshot aspect ratio differs from PNG");
    report.coordinates = geometry;
    recordCheck("capture geometry status, pixel-box fit and independently projected overlay");
    await evaluate("document.querySelector('.tree-search').focus()");
    await connection.send("Input.insertText", { text: "android" });
    await until(() => evaluate("document.querySelector('.tree-tools .tree-clear') && document.querySelectorAll('.tree-row').length > 0"), "node filtering");
    await evaluate("document.querySelector('.tree-tools .tree-clear').click()");
    await until(() => evaluate("document.querySelector('.tree-search').value === ''"), "clear node filter");
    recordCheck("node search and clear filter");
    await evaluate("document.querySelector('.tree-collapse-all').click(); document.querySelector('.tree-search').focus()");
    await connection.send("Input.insertText", { text: "inspector-smoke-no-such-node-9c81" });
    await until(() => evaluate("document.querySelectorAll('.tree-row').length === 0"), "empty node filter");
    await clickScreenshot();
    await until(() => evaluate("document.querySelector('.tree-search').value === ''"), "screenshot clears filter");
    await until(revealed, "repeated same-node screenshot selection");
    recordCheck("screenshot clears empty filter and reveals repeated selection");
    await evaluate("document.querySelector('.tree-expand-all').click(); document.querySelector('.ui-tree-scroll').focus({preventScroll:true})");
    await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 });
    await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35 });
    await until(() => evaluate(`(() => {
      const tree = document.querySelector('.ui-tree-scroll');
      const rows = tree.querySelectorAll('.tree-row');
      return tree.dataset.windowEnd === tree.dataset.rowCount && rows[rows.length - 1]?.classList.contains('selected');
    })()`), "keyboard End reaches last logical row");
    await until(revealed, "keyboard End selection");
    await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
    await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
    await until(() => evaluate("document.querySelector('.tree-row.selected')?.dataset.treeId === '0'"), "keyboard Home selection");
    recordCheck("expand-all and keyboard End/Home navigation");
    await evaluate("Array.from(document.querySelectorAll('.snapshot-actions button')).find(button => button.textContent === '保存快照').click()");
    await until(() => evaluate("document.querySelectorAll('.snapshot-history-item').length === 1"), "save isolated snapshot");
    const storedGeometry = await evaluate("window.electronApi.loadSnapshots().then(result => { if (result.error) throw new Error(result.error); return result.snapshots[0]?.snapshot.captureGeometry; })");
    assert.ok(storedGeometry, "Capture metadata was lost while saving/loading");
    assert.deepEqual(storedGeometry.screenshotSize, report.screenshot);
    await evaluate("document.querySelector('.snapshot-history-item').click()");
    await until(() => evaluate(`document.querySelector('.screenshot-stage')?.dataset.coordinateStatus === ${JSON.stringify(geometry.status)} && Boolean(document.querySelector('.selection-overlay'))`), "restored snapshot geometry");
    report.storedGeometry = storedGeometry;
    recordCheck("snapshot save/load and history preview retain capture geometry");
    await evaluate("document.querySelector('.inspector-panel').scrollIntoView({block:'start', behavior:'instant'})");
  } else {
    assert.equal(expectLandscape, false, "Landscape check requires an authorized device");
    report.deviceChecks = "skipped: no authorized device";
  }
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const screenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(output, "app.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(connection.errors.length, 0, "Renderer reported runtime or resource errors");
  report.success = true;
} catch (error) {
  report.error = String(error);
  report.applicationError = stderr.slice(-1500);
  process.exitCode = 1;
} finally {
  report.rendererErrors = connection?.errors ?? [];
  connection?.close();
  if (!exited) {
    child.kill();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2000)]);
  }
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(output, "stdout.log"), stdout);
  writeFileSync(join(output, "stderr.log"), stderr);
  console.log(JSON.stringify({ output, ...report }, null, 2));
}

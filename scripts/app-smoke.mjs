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
const reducedMotion = process.argv.includes("--reduced-motion");
const fixture = process.argv.includes("--fixture");
const dragOutside = process.argv.includes("--drag-outside");
const homeOnly = process.argv.includes("--home-only");
const viewportArgument = process.argv.find((value) => value.startsWith("--viewport="))?.slice("--viewport=".length);
const viewportMatch = viewportArgument?.match(/^(\d+)x(\d+)$/i);
const requestedViewport = viewportMatch ? { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) } : null;
const scaleArgument = process.argv.find((value) => value.startsWith("--scale-factor="))?.slice("--scale-factor=".length);
const requestedScaleFactor = scaleArgument ? Number(scaleArgument) : null;
const supportedOptions = ["--packaged", "--require-device", "--expect-landscape", "--reduced-motion", "--fixture", "--drag-outside", "--home-only"];
if (process.argv.slice(2).some((value) => !supportedOptions.includes(value) && !value.startsWith("--viewport=") && !value.startsWith("--scale-factor="))) throw new Error("Supported options: --packaged --require-device --expect-landscape --reduced-motion --fixture --drag-outside --home-only --viewport=WxH --scale-factor=N");
if (viewportArgument && (!viewportMatch || requestedViewport.width < 640 || requestedViewport.height < 480)) throw new Error(`Invalid viewport: ${viewportArgument}`);
if (requestedScaleFactor !== null && (!Number.isFinite(requestedScaleFactor) || requestedScaleFactor < 0.5 || requestedScaleFactor > 3)) throw new Error(`Invalid scale factor: ${scaleArgument}`);
if (fixture && packaged) throw new Error("The visual fixture is available in development mode only");
if (homeOnly && !fixture) throw new Error("--home-only requires --fixture so the home screen has deterministic device data");
require("./prepare-windows-runtime.cjs").prepareWindowsRuntime(packaged ? "Unpacked" : "Development");
const output = join(project, ".benchmarks", "app-smoke", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const executable = packaged ? join(project, "release/win-unpacked/Android UI Inspector.exe") : require("electron");
const args = [
  ...(fixture ? ["--visual-fixture"] : []),
  ...(requestedScaleFactor === null ? [] : [`--force-device-scale-factor=${requestedScaleFactor}`]),
  ...(requestedViewport ? [`--window-size=${requestedViewport.width + 16}x${requestedViewport.height + 65}`] : []),
  ...(packaged ? [] : [project]),
  "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${join(output, "profile")}`,
];
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
const report = { generatedAt: new Date().toISOString(), packaged, fixture, homeOnly, reducedMotion, dragOutside, requestedViewport, requestedScaleFactor, success: false, checks: [] };
const recordCheck = (label) => { report.checks.push(label); console.log(`PASS: ${label}`); };
try {
  await until(() => endpoint, "debugger startup");
  const address = new URL(endpoint);
  const page = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${address.port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    return pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  }, "application window");
  connection = await connect(page.webSocketDebuggerUrl);
  if (reducedMotion) await connection.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  if (requestedViewport) {
    await connection.send("Emulation.setDeviceMetricsOverride", {
      width: requestedViewport.width,
      height: requestedViewport.height,
      deviceScaleFactor: requestedScaleFactor ?? 1,
      mobile: false,
      screenWidth: requestedViewport.width,
      screenHeight: requestedViewport.height,
    });
  }
  await connection.send("Runtime.enable");
  await connection.send("Log.enable");
  await connection.send("Network.enable");
  const evaluate = async (expression) => {
    const result = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await until(() => evaluate("Boolean(document.querySelector('.app-shell') && window.electronApi)"), "React and preload");
  const runtime = await evaluate("({ ...window.electronApi.runtime, nodeExposed: typeof window.require !== 'undefined', heading: document.querySelector('h1')?.textContent, devicePixelRatio: window.devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } })");
  assert.equal(runtime.sandboxed, true);
  assert.equal(runtime.contextIsolated, true);
  assert.equal(runtime.nodeExposed, false);
  assert.equal(runtime.heading, "Android UI Inspector");
  report.runtime = runtime;
  if (fixture) assert.equal(runtime.fixtureMode, true, "Visual fixture mode did not reach the preload bridge");
  if (requestedViewport) {
    assert.equal(runtime.viewport.width, requestedViewport.width, "Requested visual viewport width was not applied");
    assert.equal(runtime.viewport.height, requestedViewport.height, "Requested visual viewport height was not applied");
  }
  if (requestedScaleFactor !== null) assert.ok(Math.abs(runtime.devicePixelRatio - requestedScaleFactor) < 0.06, `Requested scale factor ${requestedScaleFactor} was not applied`);
  recordCheck("sandboxed React window and preload");
  await until(() => evaluate("!document.querySelector('.refresh-button').disabled"), "initial device probe");
  await evaluate("document.querySelector('.refresh-button').click()");
  await until(() => evaluate("!document.querySelector('.refresh-button').disabled"), "device refresh");
  recordCheck("device refresh button");
  const captureButtonCount = await evaluate("document.querySelectorAll('.topbar .capture-button').length");
  assert.equal(captureButtonCount, 1, "Expected exactly one screenshot capture button in the top toolbar");
  assert.equal(await evaluate("document.querySelectorAll('.inspect-button').length"), 0, "Legacy inline inspect button must not return");
  recordCheck("single toolbar capture entry");
  const deviceCount = await evaluate("document.querySelectorAll('.device-select option[data-device-state=\\\"device\\\"]').length");
  report.readyDevices = deviceCount;
  if (requireDevice) assert.ok(deviceCount > 0, "Expected a connected and authorized Android device");
  if (homeOnly) {
    const homeState = await evaluate(`(() => {
      const box = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          color: style.color,
          background: style.backgroundColor,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        };
      };
      return {
        topbar: box('.topbar'),
        view: box('.home-view'),
        layout: box('.home-layout'),
        connected: box('.connected-device-card'),
        quickStart: box('.quick-start-card'),
        heading: box('.home-card h2'),
        step: box('.home-steps strong'),
        body: box('body'),
        oldHero: Boolean(document.querySelector('.hero-section')),
        oldMetrics: Boolean(document.querySelector('.metrics-grid')),
        oldStatus: Boolean(document.querySelector('.status-banner')),
        oldContentGrid: Boolean(document.querySelector('.content-grid')),
        captureButtons: document.querySelectorAll('.topbar .capture-button').length,
        overflowX: document.documentElement.scrollWidth - innerWidth,
      };
    })()`);
    assert.ok(homeState.view?.width > 0 && homeState.layout?.width > 0, "Minimal home layout is not visible");
    assert.ok(homeState.connected?.width > 0 && homeState.quickStart?.width > 0, "Home cards are not visible");
    assert.ok(Number.parseFloat(homeState.heading?.fontSize ?? "0") >= 24, "Home heading is still too small");
    assert.ok(Number.parseFloat(homeState.step?.fontSize ?? "0") >= 15, "Quick-start typography is still too small");
    assert.ok((homeState.topbar?.height ?? 0) <= 100, "Home toolbar wrapped into an oversized header");
    assert.equal(homeState.oldHero, false, "Legacy hero block remains in the home DOM");
    assert.equal(homeState.oldMetrics, false, "Legacy metrics grid remains in the home DOM");
    assert.equal(homeState.oldStatus, false, "Legacy status banner remains in the home DOM");
    assert.equal(homeState.oldContentGrid, false, "Legacy content grid remains in the home DOM");
    assert.equal(homeState.captureButtons, 1, "Home screen introduced a duplicate toolbar capture entry");
    assert.ok(homeState.overflowX <= 1, "Minimal home layout introduces horizontal overflow");
    report.homeLayout = homeState;
    const homeScreenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(output, "home.png"), Buffer.from(homeScreenshot.data, "base64"));
    recordCheck("minimal home layout keeps two readable cards and one toolbar capture action");
  } else if (deviceCount > 0) {
    await evaluate(`(() => {
      const select = document.querySelector('.device-select');
      const option = select?.querySelector('option[data-device-state="device"]');
      if (!select || !option) return false;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await until(() => evaluate("Boolean(document.querySelector('.capture-button:not([disabled])'))"), "device selection");
    await evaluate("document.querySelector('.capture-button:not([disabled])').click()");
    await until(() => evaluate("Boolean(document.querySelector('.tree-row') || document.querySelector('.error-placeholder'))"), "UIAutomator inspection", 60_000);
    const error = await evaluate("document.querySelector('.error-placeholder p')?.textContent");
    assert.ok(!error, error);
    const initialId = await evaluate("document.querySelector('.node-id')?.textContent");
    const rowCount = await evaluate("document.querySelectorAll('.tree-row').length");
    report.inspectionSummary = await evaluate("document.querySelector('.snapshot-summary').textContent");
    assert.match(report.inspectionSummary, /完整 hierarchy/, "Packaged inspection did not use full UI hierarchy mode");
    const hierarchyNote = await evaluate("document.querySelector('.hierarchy-note')?.textContent || ''");
    if (hierarchyNote) assert.match(hierarchyNote, /VirtualChild/, "Virtual accessibility note is incomplete");
    if (rowCount > 1) {
      await evaluate("document.querySelectorAll('.tree-row')[1].click()");
      await until(() => evaluate(`document.querySelector('.node-id').textContent !== ${JSON.stringify(initialId)}`), "tree selection");
    }
    assert.equal(await evaluate("document.querySelectorAll('.tree-row.selected').length"), 1);
    recordCheck("real-device hierarchy and tree selection");
    if (rowCount > 1) {
      await until(() => evaluate("Boolean(document.querySelector('.layer-scene'))"), "3D hierarchy expansion");
      const layerState = await evaluate(`(() => ({
        mode: document.querySelector('.layer-scene')?.dataset.viewMode,
        count: Number(document.querySelector('.layer-scene')?.dataset.layerCount || 0),
        selectedTreeId: document.querySelector('.tree-row.selected')?.dataset.treeId,
        selectedLayerId: document.querySelector('.layer-plane.selected')?.dataset.layerNodeId,
        hasZoomToolbar: Boolean(document.querySelector('.zoom-controls')),
        zoomPresetCount: document.querySelectorAll('.zoom-preset-select option').length,
        hasBreadcrumb: Boolean(document.querySelector('.layer-breadcrumb')),
        hasLayerOptions: Boolean(document.querySelector('.layer-options')),
        hasNodeProperties: Boolean(document.querySelector('.node-properties-panel')),
        hasBoxModel: Boolean(document.querySelector('.box-model-card')),
        orbitReadout: document.querySelector('.orbit-readout')?.textContent?.trim() || '',
        breadcrumbText: document.querySelector('.layer-breadcrumb')?.textContent?.trim() || '',
        breadcrumbRect: (() => { const rect = document.querySelector('.layer-breadcrumb')?.getBoundingClientRect(); return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null; })(),
        animationName: (() => { const plane = document.querySelector('.layer-plane'); return plane ? getComputedStyle(plane).animationName : null; })(),
        animationDuration: (() => { const plane = document.querySelector('.layer-plane'); return plane ? getComputedStyle(plane).animationDuration : null; })(),
      }))()`);
      assert.equal(layerState.mode, "layers3d");
      assert.ok(layerState.count > 0, "3D scene has no visible layer planes");
      assert.equal(layerState.selectedLayerId, layerState.selectedTreeId, "3D selected plane does not follow tree selection");
      assert.equal(layerState.hasZoomToolbar, true);
      assert.equal(layerState.zoomPresetCount, 7, "Zoom presets do not cover custom plus 50/100/200/400/800/1600");
      assert.equal(layerState.hasBreadcrumb, true);
      assert.equal(layerState.hasLayerOptions, true);
      assert.equal(layerState.hasNodeProperties, true);
      assert.equal(layerState.hasBoxModel, true);
      assert.match(layerState.orbitReadout, /Yaw/);
      assert.ok(layerState.breadcrumbText.length > 0, "3D breadcrumb has no hierarchy path");
      assert.ok(layerState.breadcrumbRect?.width > 0 && layerState.breadcrumbRect?.height > 0, "3D breadcrumb has no visible box");
      const workspaceLayout = await evaluate(`(() => {
        const box = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, background: style.backgroundColor, overflowX: style.overflowX, overflowY: style.overflowY };
        };
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          context: box('.inspector-heading'),
          hierarchy: box('.tree-pane'),
          preview: box('.preview-pane'),
          toolbar: box('.screenshot-view-toolbar'),
          snapshot: box('.snapshot-drawer'),
          frame: box('.screenshot-frame'),
          details: box('.node-details'),
          properties: box('.node-properties-panel'),
          grid: box('.viewport-grid'),
          gizmo: box('.viewport-gizmo'),
          layerSettings: box('.layer-settings'),
          documentOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        };
      })()`);
      assert.ok(workspaceLayout.frame?.height >= 250, "Screenshot viewport is too short for the light workspace layout");
      assert.ok(workspaceLayout.details?.height >= 200, "Node properties panel is not visible in the initial viewport");
      assert.ok(workspaceLayout.properties?.width > 0 && workspaceLayout.properties?.height > 0, "Node property columns have no visible layout box");
      assert.ok(workspaceLayout.grid?.width > 0 && workspaceLayout.gizmo?.width > 0, "3D viewport decorations are missing");
      assert.ok(workspaceLayout.layerSettings?.width > 0, "3D low-frequency settings control is missing");
      if (workspaceLayout.viewport.width >= 1100) assert.ok(workspaceLayout.toolbar?.height <= 56, "Wide inspector toolbar wrapped unexpectedly");
      assert.ok(workspaceLayout.documentOverflowX <= 1, "Inspector layout introduces horizontal document overflow");
      report.workspaceLayout = workspaceLayout;
      if (reducedMotion) {
        assert.equal(layerState.animationName, "none", "reduced-motion did not disable layer animation");
        assert.equal(layerState.animationDuration, "0s", "reduced-motion layer animation still has duration");
        recordCheck("prefers-reduced-motion removes 3D layer animation");
      }
      report.layerState = layerState;
      recordCheck("tree selection opens 3D layer scene and highlights selected plane");
      recordCheck("light workspace layout keeps canvas, properties and 3D viewport decorations visible");
      const alternateLayerId = await evaluate(`(() => {
        const selectedId = document.querySelector('.tree-row.selected')?.dataset.treeId;
        const rootId = document.querySelector('.tree-row')?.dataset.treeId;
        return Array.from(document.querySelectorAll('.layer-plane:not(.selected)'))
          .find((plane) => plane.dataset.layerNodeId && plane.dataset.layerNodeId !== selectedId && plane.dataset.layerNodeId !== rootId)
          ?.dataset.layerNodeId || null;
      })()`);
      if (alternateLayerId) {
        await evaluate(`(() => {
          const plane = Array.from(document.querySelectorAll('.layer-plane'))
            .find((item) => item.dataset.layerNodeId === ${JSON.stringify(alternateLayerId)});
          if (!plane) return false;
          plane.click();
          return true;
        })()`);
        await until(() => evaluate(`(() => {
          const selectedPlane = document.querySelector('.layer-plane.selected');
          const selectedTree = document.querySelector('.tree-row.selected');
          return selectedPlane?.dataset.layerNodeId === ${JSON.stringify(alternateLayerId)}
            && selectedTree?.dataset.treeId === ${JSON.stringify(alternateLayerId)};
        })()`), "3D layer fast switch");
        const switchedIds = await evaluate("Array.from(document.querySelectorAll('.layer-plane')).map((plane) => plane.dataset.layerNodeId)");
        assert.equal(new Set(switchedIds).size, switchedIds.length, "3D fast switch left duplicate layer planes");
        report.layerSwitch = { selectedId: alternateLayerId, count: switchedIds.length };
        recordCheck("3D layer click fast-switch replaces the selected layer set");
      } else {
        report.layerSwitch = "skipped: no alternate non-root layer in the captured scene";
      }
      await delay(500);
      const dragPoints = await evaluate(`(() => {
        const stage = document.querySelector('.screenshot-stage')?.getBoundingClientRect();
        const frame = document.querySelector('.screenshot-frame')?.getBoundingClientRect();
        if (!stage || !frame || stage.width <= 0 || stage.height <= 0) return null;
        return {
          start: { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 },
          end: { x: Math.max(frame.left + 2, frame.right - 3), y: Math.max(frame.top + 2, frame.bottom - 3) },
        };
      })()`);
      if (dragPoints) {
        const transformBeforeDrag = await evaluate("getComputedStyle(document.querySelector('.layer-scene-inner')).transform");
        await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: dragPoints.start.x, y: dragPoints.start.y, button: "left", buttons: 1, modifiers: 1, clickCount: 1 });
        await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragPoints.end.x, y: dragPoints.end.y, button: "none", buttons: 1, modifiers: 1 });
        await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragPoints.end.x, y: dragPoints.end.y, button: "left", buttons: 0, modifiers: 1, clickCount: 1 });
        await delay(600);
        const dragState = await evaluate("getComputedStyle(document.querySelector('.layer-scene-inner')).transform");
        report.drag = { points: dragPoints, transformBefore: transformBeforeDrag, transform: dragState };
        assert.notEqual(dragState, transformBeforeDrag, "3D edge drag did not rotate");
        recordCheck("3D Alt-drag rotates through the viewport edge and releases cleanly");

        if (dragOutside) {
          const outsideBefore = await evaluate("getComputedStyle(document.querySelector('.layer-scene-inner')).transform");
          const frame = await evaluate("(() => { const rect = document.querySelector('.screenshot-frame')?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; })()");
          const outsideX = (await evaluate("innerWidth")) + 180;
          const outsideY = Math.max(1, Math.min((await evaluate("innerHeight")) - 1, frame?.y ?? 1));
          await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: frame?.x ?? dragPoints.start.x, y: frame?.y ?? dragPoints.start.y, button: "left", buttons: 1, modifiers: 1, clickCount: 1 });
          await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (frame?.x ?? dragPoints.start.x) + 80, y: (frame?.y ?? dragPoints.start.y) + 24, button: "none", buttons: 1, modifiers: 1 });
          await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: outsideX, y: outsideY, button: "none", buttons: 1, modifiers: 1 });
          await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: outsideX, y: outsideY, button: "left", buttons: 0, modifiers: 1, clickCount: 1 });
          // Chrome's CDP input domain does not always deliver a release whose
          // coordinates are outside the emulated page. Re-enter once and send
          // an idempotent release so the harness matches the native pointer-up
          // path before continuing with the rest of the smoke checks.
          await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: frame?.x ?? dragPoints.start.x, y: frame?.y ?? dragPoints.start.y, button: "none", buttons: 0, modifiers: 0 });
          await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: frame?.x ?? dragPoints.start.x, y: frame?.y ?? dragPoints.start.y, button: "left", buttons: 0, modifiers: 0, clickCount: 1 });
          await delay(300);
          const outsideState = await evaluate(`(() => ({
            transform: getComputedStyle(document.querySelector('.layer-scene-inner')).transform,
            bodyTransform: getComputedStyle(document.body).transform,
            shellTransform: getComputedStyle(document.querySelector('.app-shell')).transform,
            documentOverflowX: document.documentElement.scrollWidth - innerWidth,
            frameFocused: document.activeElement === document.querySelector('.screenshot-frame'),
          }))()`);
          report.dragOutside = { outsidePoint: { x: outsideX, y: outsideY }, transformBefore: outsideBefore, ...outsideState };
          assert.equal(outsideState.bodyTransform, "none", "3D drag leaked a transform to document body");
          assert.equal(outsideState.shellTransform, "none", "3D drag leaked a transform to the app shell");
          assert.ok(outsideState.documentOverflowX <= 1, "Outside drag introduced horizontal document overflow");
          recordCheck("3D drag releases safely after leaving the application viewport");
        }
      }
      const cameraBefore = await evaluate("getComputedStyle(document.querySelector('.layer-scene-inner')).transform");
      await evaluate("document.querySelector('.screenshot-frame').focus()");
      await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
      await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
      await until(() => evaluate(`getComputedStyle(document.querySelector('.layer-scene-inner')).transform !== ${JSON.stringify(cameraBefore)}`), "3D keyboard rotation");
      await evaluate("document.querySelector('[aria-label=\"放大截图\"]').click()");
      await until(() => evaluate("document.querySelector('.zoom-readout')?.textContent === '125%'"), "screenshot zoom in");
      await evaluate(`(() => {
        const select = document.querySelector('.zoom-preset-select');
        if (!select) return false;
        select.value = '8';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await until(() => evaluate("document.querySelector('.zoom-readout')?.textContent === '800%'"), "high screenshot zoom preset");
      await evaluate("document.querySelector('.zoom-reset').click()");
      await until(() => evaluate("document.querySelector('.zoom-readout')?.textContent === '100%'"), "screenshot fit zoom");
      const layersScreenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(join(output, "layers3d.png"), Buffer.from(layersScreenshot.data, "base64"));
      report.visualBaseline = { screenshot: "layers3d.png", camera: "Yaw 0° · Pitch 0°", zoom: "100%" };
      recordCheck("screenshot zoom in and fit controls");
    }
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
    await evaluate("document.querySelector('.tree-expand-all').click()");
    await delay(150);
    await evaluate("document.querySelector('.ui-tree-scroll').focus({preventScroll:true})");
    await until(() => evaluate("document.activeElement === document.querySelector('.ui-tree-scroll')"), "tree keyboard focus");
    const keyboardBefore = await evaluate(`(() => {
      const tree = document.querySelector('.ui-tree-scroll');
      const selected = document.querySelector('.tree-row.selected');
      return {
        activeElement: document.activeElement?.className || document.activeElement?.tagName,
        rowCount: tree?.dataset.rowCount,
        windowEnd: tree?.dataset.windowEnd,
        activeDescendant: tree?.getAttribute('aria-activedescendant'),
        selectedId: selected?.dataset.treeId,
        selectedCount: document.querySelectorAll('.tree-row.selected').length,
        firstId: document.querySelector('.tree-row')?.dataset.treeId,
        lastId: document.querySelectorAll('.tree-row')[document.querySelectorAll('.tree-row').length - 1]?.dataset.treeId,
        selectedClass: selected?.className,
      };
    })()`);
    await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 });
    await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35 });
    await delay(150);
    const keyboardAfter = await evaluate(`(() => {
      const tree = document.querySelector('.ui-tree-scroll');
      const selected = document.querySelector('.tree-row.selected');
      return {
        activeElement: document.activeElement?.className || document.activeElement?.tagName,
        rowCount: tree?.dataset.rowCount,
        windowEnd: tree?.dataset.windowEnd,
        activeDescendant: tree?.getAttribute('aria-activedescendant'),
        selectedId: selected?.dataset.treeId,
        selectedCount: document.querySelectorAll('.tree-row.selected').length,
        firstId: document.querySelector('.tree-row')?.dataset.treeId,
        lastId: document.querySelectorAll('.tree-row')[document.querySelectorAll('.tree-row').length - 1]?.dataset.treeId,
        selectedClass: selected?.className,
      };
    })()`);
    report.keyboardEnd = { before: keyboardBefore, after: keyboardAfter };
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

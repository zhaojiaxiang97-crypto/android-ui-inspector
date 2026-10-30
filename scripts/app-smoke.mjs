import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { layerPreviewReadiness } from "./lib/layer-preview-readiness.mjs";
import { fixtureCaptureLifecycle } from "./lib/fixture-capture-lifecycle.mjs";
import { desktopDeviceLifecycle } from "./lib/desktop-device-lifecycle.mjs";
import { descendantPlaneIds, branchChildrenRemoved, visibleNativeBranchIds } from "./lib/layer-branch-check.mjs";

const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL("../", import.meta.url));
const packaged = process.argv.includes("--packaged");
const requireDevice = process.argv.includes("--require-device");
const requireLiveStyle = process.argv.includes("--require-live-style");
const expectLandscape = process.argv.includes("--expect-landscape");
const reducedMotion = process.argv.includes("--reduced-motion");
const fixture = process.argv.includes("--fixture");
const fixtureLifecycle = process.argv.includes("--fixture-capture-lifecycle");
const deviceLifecycle = process.argv.includes("--device-capture-lifecycle");
const dragOutside = process.argv.includes("--drag-outside");
const homeOnly = process.argv.includes("--home-only");
const workbenchOnly = process.argv.includes("--workbench-only");
const fixtureStateArgument = process.argv.find((value) => value.startsWith("--fixture-state="))?.slice("--fixture-state=".length);
const fixtureState = fixtureStateArgument ?? "connected";
const viewportArgument = process.argv.find((value) => value.startsWith("--viewport="))?.slice("--viewport=".length);
const viewportMatch = viewportArgument?.match(/^(\d+)x(\d+)$/i);
const requestedViewport = viewportMatch ? { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) } : null;
const scaleArgument = process.argv.find((value) => value.startsWith("--scale-factor="))?.slice("--scale-factor=".length);
const requestedScaleFactor = scaleArgument ? Number(scaleArgument) : null;
const supportedOptions = ["--packaged", "--require-device", "--require-live-style", "--expect-landscape", "--reduced-motion", "--fixture", "--fixture-capture-lifecycle", "--device-capture-lifecycle", "--drag-outside", "--home-only", "--workbench-only"];
if (deviceLifecycle && (!requireDevice || fixture || homeOnly || workbenchOnly || requireLiveStyle)) throw new Error("Device lifecycle requires a real authorized device only");
if (fixtureLifecycle && (!fixture || packaged || requireDevice || homeOnly || workbenchOnly || fixtureState !== "connected")) throw new Error("Capture lifecycle requires only the connected development fixture");
if (process.argv.slice(2).some((value) => !supportedOptions.includes(value) && !value.startsWith("--viewport=") && !value.startsWith("--scale-factor=") && !value.startsWith("--fixture-state="))) throw new Error("Supported options: --packaged --require-device --require-live-style --expect-landscape --reduced-motion --fixture --drag-outside --home-only --workbench-only --viewport=WxH --scale-factor=N --fixture-state=connected|loading|unauthorized|empty|adb-missing");
if (!["connected", "loading", "unauthorized", "empty", "adb-missing"].includes(fixtureState)) throw new Error(`Invalid fixture state: ${fixtureState}`);
if (viewportArgument && (!viewportMatch || requestedViewport.width < 640 || requestedViewport.height < 480)) throw new Error(`Invalid viewport: ${viewportArgument}`);
if (requestedScaleFactor !== null && (!Number.isFinite(requestedScaleFactor) || requestedScaleFactor < 0.5 || requestedScaleFactor > 3)) throw new Error(`Invalid scale factor: ${scaleArgument}`);
if (fixture && packaged) throw new Error("The visual fixture is available in development mode only");
if (requireLiveStyle && (!requireDevice || fixture)) throw new Error("--require-live-style requires a real authorized device");
if (homeOnly && !fixture) throw new Error("--home-only requires --fixture so the home screen has deterministic device data");
if (workbenchOnly && (!requireDevice || fixture)) throw new Error("--workbench-only requires a real authorized device");
require("./prepare-windows-runtime.cjs").prepareWindowsRuntime(packaged ? "Unpacked" : "Development");
const output = join(project, ".benchmarks", "app-smoke", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const executable = packaged ? process.env.INSPECTOR_PACKAGED_EXECUTABLE || (process.platform === "darwin"
  ? join(project, `release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/Android UI Inspector.app/Contents/MacOS/Android UI Inspector`)
  : join(project, "release/win-unpacked/Android UI Inspector.exe")) : require("electron");
const args = [
  ...(fixture ? ["--visual-fixture", `--visual-fixture-state=${fixtureState}`] : []),
  ...(fixtureLifecycle ? ["--visual-capture-lifecycle"] : []),
  ...(requestedScaleFactor === null ? [] : [`--force-device-scale-factor=${requestedScaleFactor}`]),
  ...(requestedViewport ? [`--window-size=${requestedViewport.width + 16}x${requestedViewport.height + 65}`] : []),
  ...(packaged ? [] : [project]),
  "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1",
  // Occluded windows stop painting and throttle timers, which stalls the renderer waits.
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  `--user-data-dir=${join(output, "profile")}`,
];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;
const child = spawn(executable, args, { cwd: project, env: environment, windowsHide: true, detached: process.platform !== "win32" });
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
    if (message.method === "Runtime.exceptionThrown" || (message.method === "Log.entryAdded" && message.params.entry.level === "error")) errors.push(message);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
  socket.addEventListener("close", (event) => {
    const detail = `code=${event.code}${event.reason ? ` reason=${JSON.stringify(String(event.reason).slice(0, 200))}` : ""}`;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(`Application debugger disconnected (${detail})`)); }
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
const report = { generatedAt: new Date().toISOString(), packaged, fixture, fixtureState: fixture ? fixtureState : null, homeOnly, workbenchOnly, reducedMotion, dragOutside, requestedViewport, requestedScaleFactor, success: false, checks: [] };
const recordCheck = (label) => { report.checks.push(label); console.log(`PASS: ${label}`); };
try {
  await until(() => endpoint, "debugger startup");
  const address = new URL(endpoint);
  const page = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${address.port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    return pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  }, "application window");
  connection = await connect(page.webSocketDebuggerUrl);
  await connection.send("Page.bringToFront");
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
  // Never enable the Network domain here. Screenshot and layer images are multi-MB data URLs;
  // Chromium then emits Network.requestWillBeSent/responseReceived events carrying the whole
  // data URL, and the built-in Node WebSocket (undici 6.x, cap ~4 MiB per message) kills the
  // connection with "Max decompressed message size exceeded" (close 1006) while the app keeps
  // running. Resource load failures still surface through Log.entryAdded below.
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
  const loadingFixture = homeOnly && fixtureState === "loading";
  if (loadingFixture) {
    await delay(120);
    recordCheck("initial loading state");
  } else {
    const refreshSelector = ".refresh-button, .home-secondary-actions > button:not([aria-haspopup]), .home-primary-action:not(.capture-button)";
    await until(() => evaluate(`document.querySelector(${JSON.stringify(refreshSelector)})?.disabled === false`), "initial device probe");
    await evaluate(`document.querySelector(${JSON.stringify(refreshSelector)}).click()`);
    await until(() => evaluate(`document.querySelector(${JSON.stringify(refreshSelector)})?.disabled === false`), "device refresh");
    recordCheck("device refresh button");
  }
  const captureButtonCount = await evaluate("document.querySelectorAll('.capture-button').length");
  const connectedHome = await evaluate("document.querySelector('.home-view')?.dataset.state === 'connected'");
  assert.equal(captureButtonCount, connectedHome ? 1 : 0, "Home must expose one capture entry only for an authorized device");
  assert.equal(await evaluate("document.querySelectorAll('.topbar .capture-button').length"), 0, "Home header duplicates the primary capture action");
  assert.equal(await evaluate("document.querySelectorAll('.inspect-button').length"), 0, "Legacy inline inspect button must not return");
  recordCheck("single authorized home capture entry");
  let deviceCount = 0;
  if (await evaluate("Boolean(document.querySelector('.home-secondary-actions button[aria-haspopup=dialog]:not([disabled])'))")) {
    await evaluate("document.querySelector('.home-secondary-actions button[aria-haspopup=dialog]').click()");
    await until(() => evaluate("Boolean(document.querySelector('.home-device-switcher[open]'))"), "device chooser");
    deviceCount = await evaluate("Array.from(document.querySelectorAll('.home-device-option')).filter(button => button.querySelector('.home-device-option-dot.device') && !button.disabled).length");
    await evaluate(homeOnly || deviceCount === 0 ? "document.querySelector('.home-device-switcher-close').click()"
      : "Array.from(document.querySelectorAll('.home-device-option')).find(button => button.querySelector('.home-device-option-dot.device') && !button.disabled).click()");
    await until(() => evaluate("!document.querySelector('.home-device-switcher')"), "close device chooser");
  }
  report.readyDevices = deviceCount;
  if (requireDevice) assert.ok(deviceCount > 0, "Expected a connected and authorized Android device");
  if (deviceLifecycle) {
    await desktopDeviceLifecycle({ evaluate, until, connection, output, report, recordCheck });
  } else if (fixtureLifecycle) {
    await fixtureCaptureLifecycle({ evaluate, until, connection, output, report, recordCheck });
  } else if (homeOnly) {
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
        state: box('.home-center-state'),
        art: box('.home-target-preview, .home-empty-symbol'),
        heading: box('.home-center-state h2'),
        platform: box('.home-device-platform'),
        primaryAction: box('.home-primary-action'),
        secondaryAction: box('.home-secondary-action'),
        stateClass: document.querySelector('.home-center-state')?.className || '',
        headingText: document.querySelector('.home-center-state h2')?.textContent?.trim() || '',
        platformText: document.querySelector('.home-device-platform')?.textContent?.trim() || '',
        primaryText: document.querySelector('.home-primary-action')?.textContent?.trim() || '',
        secondaryText: Array.from(document.querySelectorAll('.home-secondary-action')).map(button => button.textContent?.trim()).join(', '),
        help: box('.home-connection-help > summary'),
        body: box('body'),
        oldHero: Boolean(document.querySelector('.hero-section')),
        oldMetrics: Boolean(document.querySelector('.metrics-grid')),
        oldStatus: Boolean(document.querySelector('.status-banner')),
        oldContentGrid: Boolean(document.querySelector('.content-grid')),
        redundantHomeCopy: Boolean(document.querySelector('.home-launch-heading, .home-check-time')),
        captureButtons: document.querySelectorAll('.capture-button').length,
        captureVisible: Boolean(document.querySelector('.home-primary-action.capture-button')?.getClientRects().length),
        overflowX: document.documentElement.scrollWidth - innerWidth,
      };
    })()`);
    assert.ok(homeState.view?.width > 0 && homeState.state?.width > 0, "Reference home state is not visible");
    assert.ok(homeState.art?.width > 0 && homeState.primaryAction?.width > 0, "Home device preview or primary action is missing");
    assert.ok(homeState.help?.width > 0, "Home help affordance is missing");
    assert.equal(homeState.redundantHomeCopy, false, "Redundant home heading or check time remains");
    const expectedHomeState = fixtureState === "empty" ? "no-device" : fixtureState;
    assert.ok(homeState.stateClass.includes(`state-${expectedHomeState}`), `Home state class does not expose ${expectedHomeState}`);
    if (fixtureState === "connected") {
      assert.equal(homeState.heading, null, "Connected home should omit the device model heading");
      assert.equal(homeState.platform, null, "Connected home should omit the Android version");
      assert.ok(homeState.secondaryAction?.width > 0, "Connected home switch-device action is missing");
      assert.equal(homeState.secondaryText, "刷新设备, 切换设备");
      await evaluate("document.querySelector('.home-secondary-actions button[aria-haspopup=dialog]').click()");
      await until(() => evaluate("Boolean(document.querySelector('.home-device-switcher'))"), "home device switcher");
      assert.ok((await evaluate("document.querySelectorAll('.home-device-option').length")) >= 1, "Home device switcher has no device option");
      await evaluate("document.querySelector('.home-device-switcher-close').click()");
      await until(() => evaluate("!document.querySelector('.home-device-switcher')"), "close home device switcher");
    } else {
      assert.ok(Number.parseFloat(homeState.heading?.fontSize ?? "0") >= 18, "Home recovery heading is unreadable");
      assert.equal(homeState.platform, null, "Empty home state should not render a stale Android version");
      assert.equal(homeState.secondaryText, fixtureState === "unauthorized" ? "切换设备" : "", "Unavailable home state exposed an incorrect secondary action");
      assert.equal(homeState.primaryText, fixtureState === "loading" ? "正在检查…" : "刷新设备");
      assert.equal(await evaluate("document.querySelector('.home-primary-action').disabled"), fixtureState === "loading", "Home recovery action has an incorrect busy state");
    }
    assert.ok((homeState.topbar?.height ?? 0) <= 100, "Home toolbar wrapped into an oversized header");
    assert.equal(homeState.oldHero, false, "Legacy hero block remains in the home DOM");
    assert.equal(homeState.oldMetrics, false, "Legacy metrics grid remains in the home DOM");
    assert.equal(homeState.oldStatus, false, "Legacy status banner remains in the home DOM");
    assert.equal(homeState.oldContentGrid, false, "Legacy content grid remains in the home DOM");
    assert.equal(homeState.captureButtons, fixtureState === "connected" ? 1 : 0, "Home capture entry must be unique and require an authorized device");
    assert.equal(homeState.captureVisible, fixtureState === "connected", "Home capture action does not match the actual device state");
    assert.ok(homeState.overflowX <= 1, "Reference home state introduces horizontal overflow");
    await evaluate("document.querySelector('.home-connection-help > summary').click()");
    const helpText = await evaluate("document.querySelector('.home-connection-help > div')?.textContent?.trim() || ''");
    assert.match(helpText, /USB 调试/, "Home help did not show current connection guidance");
    assert.equal(await evaluate("document.querySelector('.home-connection-help').open"), true, "Home connection help did not open");
    await evaluate("document.querySelector('.home-connection-help > summary').click()");
    assert.equal(await evaluate("document.querySelector('.home-connection-help').open"), false, "Home connection help did not close");
    report.homeLayout = homeState;
    const homeScreenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(output, "home.png"), Buffer.from(homeScreenshot.data, "base64"));
    recordCheck("reference home state keeps one readable device action and no visual toolbar clutter");
    recordCheck("home help affordance opens and closes a readable popover");
  } else if (deviceCount > 0) {
    await until(() => evaluate("Boolean(document.querySelector('.capture-button:not([disabled])'))"), "device selection");
    await evaluate(`(() => {
      const events = [];
      const startedAt = performance.now();
      window.__appSmokeCaptureEvents = events;
      window.__appSmokeCaptureStartedAt = startedAt;
      window.__appSmokeLayerReadiness = ${layerPreviewReadiness.toString()};
      window.__appSmokeDescendants = ${descendantPlaneIds.toString()};
      window.electronApi.onInspectionProgress((progress) => events.push({ kind: "progress", atMs: Math.round(performance.now() - startedAt), stage: progress.stage, elapsedMs: progress.elapsedMs }));
      window.electronApi.onInspectionPreview((preview) => {
        if (preview.phase === "tree") {
          events.push({ kind: "tree", atMs: Math.round(performance.now() - startedAt), nodeCount: preview.snapshot.nodeCount, source: preview.snapshot.inspectionSource });
          return;
        }
        const imageCount = preview.updates.filter((update) => Boolean(update.layerImageDataUrl)).length;
        const imageIds = preview.updates.filter((update) => Boolean(update.layerImageDataUrl)).map(update => update.id);
        const layerEvent = { kind: "layers", atMs: Math.round(performance.now() - startedAt), updateCount: preview.updates.length, imageCount };
        events.push(layerEvent);
        if (imageCount && !window.__appSmokeFirstGpuProbeStarted) {
          window.__appSmokeFirstGpuProbeStarted = true;
          const showAndFlushFirstBatch = () => {
            const modeButton = document.querySelector('.view-mode-toggle button:nth-child(2)');
            if (modeButton?.disabled) {
              if (performance.now() - layerEvent.atMs < 15_000) setTimeout(showAndFlushFirstBatch, 25);
              else layerEvent.webglFailure = '3D mode remained unavailable for 15 seconds';
              return;
            }
            if (!modeButton?.classList.contains('active')) modeButton?.click();
            const waitForTextures = () => requestAnimationFrame(() => {
              const canvas = document.querySelector('.layer-webgl-canvas');
              const gl = canvas?.getContext('webgl');
              const textureCount = Number(canvas?.dataset.layerTextureCount || 0);
              const renderVersion = Number(canvas?.dataset.layerRenderVersion || 0);
              const expected = Array.from(document.querySelectorAll('.layer-plane[data-layer-texture-identity]')).map(plane => ({ id: plane.dataset.layerNodeId, key: plane.dataset.layerTextureIdentity }));
              const committed = JSON.parse(canvas?.dataset.layerCommittedNativeTextures || '[]');
              const readiness = window.__appSmokeLayerReadiness(imageIds, expected, committed);
              layerEvent.readiness = readiness;
              if (canvas && gl && !gl.isContextLost() && readiness.ready && renderVersion > 0) {
                gl.finish();
                layerEvent.webglFlushAtMs = Math.round(performance.now() - startedAt);
                layerEvent.webglRenderVersion = renderVersion;
                layerEvent.webglTextureCount = textureCount;
              } else if (performance.now() - layerEvent.atMs < 15_000) setTimeout(waitForTextures, 25);
              else layerEvent.webglFailure = 'No matching first-batch scene submission within 15 seconds';
            });
            waitForTextures();
          };
          showAndFlushFirstBatch();
        }
      });
      document.querySelector('.capture-button:not([disabled])').click();
      return true;
    })()`);
    await until(() => evaluate("Boolean(document.querySelector('.tree-row') || document.querySelector('.error-placeholder'))"), "UIAutomator inspection", 60_000);
    await until(() => evaluate("Boolean(document.querySelector('.capture-button:not([disabled])') || document.querySelector('.error-placeholder'))"), "complete inspection after early tree preview", 90_000);
    const error = await evaluate("document.querySelector('.error-placeholder p')?.textContent");
    assert.ok(!error, error);
    await until(() => evaluate("(window.__appSmokeCaptureEvents || []).some(event => event.kind === 'layers' && (event.webglFlushAtMs != null || event.webglFailure)) || !(window.__appSmokeCaptureEvents || []).some(event => event.kind === 'layers' && event.imageCount > 0)"), "first batch GPU diagnostic", 16_000);
    const captureEvents = await evaluate("window.__appSmokeCaptureEvents || []");
    const firstTreePreview = captureEvents.find((event) => event.kind === "tree");
    const firstLayerImage = captureEvents.find((event) => event.kind === "layers" && event.imageCount > 0);
    report.captureTiming = {
      treePreviewMs: firstTreePreview?.atMs ?? null,
      firstLayerImageMs: firstLayerImage?.atMs ?? null,
      firstLayerWebglFlushMs: firstLayerImage?.webglFlushAtMs ?? null,
      firstLayerImageToWebglFlushMs: firstLayerImage?.webglFlushAtMs == null ? null : firstLayerImage.webglFlushAtMs - firstLayerImage.atMs,
      firstLayerWebglRenderVersion: firstLayerImage?.webglRenderVersion ?? null,
      firstLayerWebglTextureCount: firstLayerImage?.webglTextureCount ?? null,
      firstLayerReadiness: firstLayerImage?.readiness ?? null,
      firstLayerWebglFailure: firstLayerImage?.webglFailure ?? null,
      completionMs: await evaluate("Math.round(performance.now() - window.__appSmokeCaptureStartedAt)"),
      previewBatches: captureEvents.filter((event) => event.kind === "layers").length,
      previewImages: captureEvents.filter((event) => event.kind === "layers").reduce((total, event) => total + event.imageCount, 0),
      stages: captureEvents.filter((event) => event.kind === "progress").map(({ stage, elapsedMs }) => ({ stage, elapsedMs })),
    };
    console.log(`Capture timing: ${JSON.stringify(report.captureTiming)}`);
    if (workbenchOnly && firstLayerImage) assert.ok(firstLayerImage.webglFlushAtMs != null, firstLayerImage.webglFailure || "First image batch has no eligible submitted scene evidence");
    const initialId = await evaluate("document.querySelector('.node-id')?.textContent");
    const rowCount = await evaluate("document.querySelectorAll('.tree-row').length");
    report.inspectionSummary = await evaluate("document.querySelector('.snapshot-summary').textContent");
    assert.match(report.inspectionSummary, /完整 hierarchy|QML Debug|View Debug|SDK 树/, "Inspection did not use a full UI hierarchy mode");
    if (workbenchOnly || fixture) {
      await evaluate("document.querySelector('.workbench-scene-tools > .snapshot-drawer').open = true");
      await evaluate("Array.from(document.querySelectorAll('.workbench-scene-tools > .snapshot-drawer .snapshot-actions button')).find(button => button.textContent === '保存快照').click()");
      await until(() => evaluate("document.querySelectorAll('.workbench-scene-tools > .snapshot-drawer .snapshot-history-item').length === 1"), "save capture before interaction assertions");
      report.captureSavedBeforeInteractions = true;
      await evaluate("document.querySelector('.workbench-scene-tools > .snapshot-drawer').open = false");
    }
    const hierarchyNote = await evaluate("document.querySelector('.hierarchy-note')?.textContent || ''");
    if (hierarchyNote) assert.match(hierarchyNote, /VirtualChild/, "Virtual accessibility note is incomplete");
    if (rowCount > 1) {
      await evaluate("document.querySelectorAll('.tree-row')[1].click()");
      await until(() => evaluate(`document.querySelector('.node-id').textContent !== ${JSON.stringify(initialId)}`), "tree selection");
    }
    assert.equal(await evaluate("document.querySelectorAll('.tree-row.selected').length"), 1);
    const treeVisualState = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.tree-row'));
      const selected = document.querySelector('.tree-row.selected');
      return {
        rowCount: rows.length,
        iconCount: rows.filter((row) => row.querySelector('.tree-node-icon')).length,
        duplicateLabelCount: rows.filter((row) => {
          const className = row.querySelector('.tree-class')?.textContent?.trim();
          const label = row.querySelector('.tree-label')?.textContent?.trim();
          return Boolean(label && label === className);
        }).length,
        selectedAccent: getComputedStyle(selected, '::before').backgroundColor,
      };
    })()`);
    assert.equal(treeVisualState.iconCount, treeVisualState.rowCount, "Tree rows are missing hierarchy icons");
    assert.equal(treeVisualState.duplicateLabelCount, 0, "Tree repeats class names as secondary labels");
    assert.notEqual(treeVisualState.selectedAccent, "rgba(0, 0, 0, 0)", "Tree selection has no leading marker");
    recordCheck("real-device hierarchy and tree selection");
    if (requireLiveStyle) {
      const previousSelection = await evaluate("document.querySelector('.tree-row.selected')?.dataset.treeId || null");
      await evaluate("document.querySelector('.tree-search').focus()");
      await connection.send("Input.insertText", { text: "首页" });
      await until(() => evaluate("Boolean(Array.from(document.querySelectorAll('.tree-row')).find(row => row.querySelector('.tree-primary')?.textContent.trim() === '首页' && row.querySelector('.tree-class')?.textContent.trim() === 'CheckedTextView'))"), "business home tab filter");
      const homeTabId = await evaluate("Array.from(document.querySelectorAll('.tree-row')).find(row => row.querySelector('.tree-primary')?.textContent.trim() === '首页' && row.querySelector('.tree-class')?.textContent.trim() === 'CheckedTextView')?.dataset.treeId || null");
      await evaluate(`document.querySelector('.tree-row[data-tree-id=${JSON.stringify(homeTabId)}]')?.click()`);
      await until(() => evaluate("Boolean(document.querySelector('.inspector-style-read')?.getClientRects().length)"), "live-style action for the selected home tab");
      await evaluate("document.querySelector('.inspector-style-read').click()");
      await until(() => evaluate("Array.from(document.querySelectorAll('.inspector-image-note')).some(note => note.textContent.includes('Debug SDK 实时读取'))"), "live style shown in property panel");
      report.liveStyle = await evaluate(`(() => {
        const panel = document.querySelector('.inspector-image');
        const values = Object.fromEntries(Array.from(panel.querySelectorAll('.inspector-property-list div')).map(row => [row.querySelector('dt')?.textContent.trim(), row.querySelector('dd')?.textContent.trim()]));
        return { nodeId: document.querySelector('.tree-row.selected')?.dataset.treeId, className: document.querySelector('.tree-row.selected .tree-class')?.textContent.trim(), values };
      })()`);
      assert.ok(report.liveStyle.values['背景类型'] && report.liveStyle.values['当前文字色'] && /px$/.test(report.liveStyle.values['文字大小'] ?? ''), "Live style fields were not rendered in the property panel");
      recordCheck("business Debug SDK live style renders in the property panel");
      await evaluate("document.querySelector('.tree-clear')?.click()");
      await until(() => evaluate("document.querySelector('.tree-search').value === ''"), "clear home-tab filter after live-style check");
      if (previousSelection) {
        await evaluate("document.querySelector('.ui-tree-scroll').scrollTop = 0");
        await until(() => evaluate(`Boolean(document.querySelector('.tree-row[data-tree-id=${JSON.stringify(previousSelection)}]'))`), "restore previous tree selection row");
        await evaluate(`document.querySelector('.tree-row[data-tree-id=${JSON.stringify(previousSelection)}]')?.click()`);
        await until(() => evaluate(`document.querySelector('.tree-row.selected')?.dataset.treeId === ${JSON.stringify(previousSelection)}`), "restore previous tree selection");
      }
    }
    if (rowCount > 1) {
      await until(() => evaluate("Boolean(document.querySelector('.layer-scene'))"), "3D hierarchy expansion");
      await until(() => evaluate("document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderer === 'webgl'"), "WebGL scene renderer");
      if (!await evaluate("Boolean(document.querySelector('.layer-plane.selected'))")) await evaluate("document.querySelector('.layer-plane')?.click()");
      await until(() => evaluate("Boolean(document.querySelector('.layer-plane.selected') && document.querySelector('.tree-row.selected') && document.querySelector('.layer-plane.selected').dataset.layerNodeId === document.querySelector('.tree-row.selected').dataset.treeId)"), "3D selection synchronization");
      // The screenshot zoom presets are rendered only while the zoom popup is open.
      await evaluate("document.querySelector('.zoom-continuous-toggle')?.click()");
      await until(() => evaluate("document.querySelectorAll('.zoom-preset-select option').length === 7"), "zoom presets popup");
      const layerState = await evaluate(`(() => {
        const canvas = document.querySelector('.layer-webgl-canvas');
        const selectedPlane = document.querySelector('.layer-plane.selected');
        const selectedLayer = selectedPlane;
        return {
        mode: document.querySelector('.layer-scene')?.dataset.viewMode,
        renderer: canvas?.dataset.layerRenderer,
        rendererError: canvas?.dataset.layerWebglError || null,
        canvasPixels: canvas?.dataset.layerCanvasPixels || null,
        count: Number(document.querySelector('.layer-scene')?.dataset.layerCount || 0),
        textureCount: Number(document.querySelector('.layer-scene')?.dataset.layerTextureCount || 0),
        outlineCount: Number(document.querySelector('.layer-scene')?.dataset.layerOutlineCount || 0),
        selectionCount: Number(document.querySelector('.layer-scene')?.dataset.layerSelectionCount || 0),
        texturedUnselectedCount: document.querySelectorAll('.layer-plane.surface:not(.selected)').length,
        expandedParentNonNativeCount: document.querySelectorAll('.layer-plane.surface[data-layer-expanded-parent="true"]:not([data-layer-texture-mode="native"])').length,
        expandedCompositeCount: document.querySelectorAll('.layer-plane[data-layer-texture-mode="composite"]').length,
        isolatedSurfaceCount: document.querySelectorAll('.layer-plane.surface[data-layer-texture-mode="isolated"]').length,
        nativeSurfaceCount: document.querySelectorAll('.layer-plane.surface[data-layer-texture-mode="native"]').length,
        selectedTreeId: document.querySelector('.tree-row.selected')?.dataset.treeId,
        selectedLayerId: selectedLayer?.dataset.layerNodeId,
        selectedLayerRole: selectedLayer?.dataset.layerRole,
        selectedLayerTexture: selectedLayer?.dataset.layerTexture,
        selectedLayerFocus: selectedLayer?.dataset.layerFocus,
        selectedLayerHitTestable: selectedLayer?.dataset.layerHitTestable,
        selectedPlaneCount: document.querySelectorAll('.layer-plane.selected').length,
        fullScreenSurfaceCount: (() => {
          const stage = document.querySelector('.screenshot-stage');
          if (!stage) return 0;
          const stageStyle = getComputedStyle(stage);
          const stageWidth = Number.parseFloat(stageStyle.width);
          const stageHeight = Number.parseFloat(stageStyle.height);
          return Array.from(document.querySelectorAll('.layer-plane[data-layer-role="surface"]')).filter((plane) => {
            const style = getComputedStyle(plane);
            const widthRatio = Number.parseFloat(style.width) / stageWidth;
            const heightRatio = Number.parseFloat(style.height) / stageHeight;
            return (widthRatio >= 0.9 && heightRatio >= 0.75) || (widthRatio >= 0.75 && heightRatio >= 0.9);
          }).length;
        })(),
        hasZoomToolbar: Boolean(document.querySelector('.zoom-controls')),
        zoomPresetCount: document.querySelectorAll('.zoom-preset-select option').length,
        stageOutline: getComputedStyle(document.querySelector('.screenshot-stage')).outlineStyle,
        stageBoxShadow: getComputedStyle(document.querySelector('.screenshot-stage')).boxShadow,
        stageBackground: getComputedStyle(document.querySelector('.screenshot-stage')).backgroundColor,
        hasLayerOptions: Boolean(document.querySelector('.layer-settings > summary')),
        hasNodeProperties: Boolean(document.querySelector('.node-properties-panel')),
        hasBoxModel: Boolean(document.querySelector('.box-model-card')),
        pivotZ: Number(document.querySelector('.layer-scene')?.dataset.layerPivotZ || 0),
        animationName: (() => { const canvas = document.querySelector('.layer-webgl-canvas'); return canvas ? getComputedStyle(canvas).animationName : null; })(),
        animationDuration: (() => { const canvas = document.querySelector('.layer-webgl-canvas'); return canvas ? getComputedStyle(canvas).animationDuration : null; })(),
      };
      })()`);
      assert.equal(layerState.mode, "layers3d");
      assert.equal(layerState.renderer, "webgl", `3D scene did not initialize WebGL: ${layerState.rendererError || 'unknown error'}`);
      if (!report.inspectionSummary.includes("QML Debug")) assert.equal(layerState.expandedParentNonNativeCount, 0, "Expanded parent layers must only use their own native image");
      assert.equal(layerState.expandedCompositeCount, 0, "Expanded controls must not retain flattened background pixels");
      assert.match(layerState.canvasPixels ?? "", /^\d+x\d+$/, "WebGL canvas has no backing store");
      assert.ok(layerState.count > 0, "3D scene has no visible layer planes");
      assert.ok(["surface", "outline"].includes(layerState.selectedLayerRole), "3D selected layer lost its visual role");
      assert.equal(layerState.selectedLayerTexture, layerState.selectedLayerRole === "surface" ? "true" : "false", "3D selected texture role is inconsistent");
      assert.equal(layerState.selectedLayerFocus, "true", "3D selected layer has no focus marker");
      assert.equal(layerState.selectedLayerHitTestable, "true", "Selected direct child must remain hoverable and clickable");
      assert.equal(layerState.selectedPlaneCount, 1, "3D selected layer lost its focus plane");
      assert.equal(layerState.selectionCount, 1, "3D scene must draw one focus highlight");
      assert.equal(layerState.stageOutline, "none", "3D stage still leaves a stationary outline behind the scene");
      assert.equal(layerState.stageBoxShadow, "none", "3D stage still leaves a stationary shadow behind the scene");
      assert.equal(layerState.stageBackground, "rgba(0, 0, 0, 0)", "3D stage still leaves a stationary backdrop behind the scene");
      if (!report.inspectionSummary.includes("QML Debug")) assert.equal(layerState.fullScreenSurfaceCount, 0, "3D scene still renders a full-screen container as a texture surface");
      assert.ok(layerState.textureCount >= 0 && layerState.textureCount <= layerState.count, "3D texture surface count is invalid");
      assert.ok(layerState.isolatedSurfaceCount + layerState.nativeSurfaceCount >= layerState.textureCount - 1 && layerState.isolatedSurfaceCount + layerState.nativeSurfaceCount <= layerState.textureCount, "Expanded texture surfaces must use isolated or independently captured pixels");
      if (fixture && layerState.textureCount > 0) assert.ok(layerState.texturedUnselectedCount > 0 || layerState.selectedLayerRole === "surface", "Styled direct children lost their screenshot appearance");
      assert.equal(layerState.selectedLayerId, layerState.selectedTreeId, "3D selected plane does not follow tree selection");
      assert.equal(layerState.hasZoomToolbar, true);
      assert.equal(layerState.zoomPresetCount, 7, "Zoom presets do not cover custom plus 50/100/200/400/800/1600");
      await evaluate("document.querySelector('.zoom-continuous-toggle')?.click()");
      await until(() => evaluate("!document.querySelector('.zoom-preset-select')"), "zoom popup dismiss");
      assert.equal(layerState.hasLayerOptions, true, "3D settings control is missing");
      await evaluate("document.querySelector('.layer-settings > summary')?.click()");
      await until(() => evaluate("Boolean(document.querySelector('.layer-options'))"), "3D options popup");
      assert.match(await evaluate("document.querySelector('.orbit-readout')?.textContent?.trim() || ''"), /水平.*俯仰/, "3D camera orientation readout missing");
      assert.equal(await evaluate("Boolean(document.querySelector('.window-stack-label')?.getClientRects().length)"), true, "3D window stack is unavailable in settings");
      await evaluate("document.querySelector('.layer-settings > summary')?.click()");
      await until(() => evaluate("!document.querySelector('.layer-options')"), "3D options popup close");
      assert.equal(layerState.hasNodeProperties, true);
      assert.equal(layerState.hasBoxModel, true);
      assert.ok(layerState.pivotZ < 0, "3D camera still orbits around the front layer instead of the layer stack center");
      await until(() => evaluate(`(() => {
        const panel = document.querySelector('.floating-inspector')?.getBoundingClientRect();
        const frame = document.querySelector('.screenshot-frame')?.getBoundingClientRect();
        return Boolean(panel && frame && panel.left >= frame.left && panel.bottom <= frame.bottom);
      })()`), "floating inspector layout to settle inside the canvas", 5000);
      const workspaceLayout = await evaluate(`(() => {
        const box = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, background: style.backgroundColor, overflowX: style.overflowX, overflowY: style.overflowY };
        };
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          topbar: box('.topbar'),
          header: box('.inspection-header'),
          deviceTools: box('.workbench-device-tools'),
          context: box('.inspector-heading'),
          hierarchy: box('.tree-pane'),
          preview: box('.preview-pane'),
          toolbar: box('.screenshot-view-toolbar'),
          toolbarHost: box('.scene-toolbar-host'),
          snapshot: box('.workbench-scene-tools > .snapshot-drawer'),
          frame: box('.screenshot-frame'),
          details: box('.floating-inspector'),
          properties: box('.inspector-geometry'),
          grid: box('.viewport-grid'),
          gizmo: box('.viewport-gizmo'),
          documentOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        };
      })()`);
      report.workspaceLayout = workspaceLayout;
      assert.ok(workspaceLayout.frame?.height >= 250, "Screenshot viewport is too short for the reference workspace layout");
      assert.ok(workspaceLayout.hierarchy?.width >= 280, "Hierarchy rail is too narrow for class and resource labels");
      assert.ok(workspaceLayout.details?.height >= 200, "Node properties panel is not visible in the initial viewport");
      assert.ok(workspaceLayout.properties?.width > 0 && workspaceLayout.properties?.height > 0, "Compact geometry has no visible layout box");
      assert.ok(workspaceLayout.details.left >= workspaceLayout.frame.left && workspaceLayout.details.bottom <= workspaceLayout.frame.bottom, "Floating inspector is outside the canvas");
      assert.ok(workspaceLayout.grid?.width > 0 && workspaceLayout.gizmo?.width > 0, "3D viewport decorations are missing");
      assert.ok(workspaceLayout.header?.height >= 56 && workspaceLayout.toolbarHost?.height >= 32, "Workbench toolbar has no reserved header space");
      assert.ok(workspaceLayout.toolbarHost.left >= workspaceLayout.deviceTools.right
        && workspaceLayout.toolbarHost.right <= workspaceLayout.header.right
        && workspaceLayout.toolbarHost.top >= workspaceLayout.header.top
        && workspaceLayout.toolbarHost.bottom <= workspaceLayout.header.bottom, "Canvas toolbar overlaps device controls or leaves the header");
      assert.ok(workspaceLayout.header.bottom <= workspaceLayout.frame.top + 1 && workspaceLayout.details.top >= workspaceLayout.frame.top, "Toolbar or inspector covers the wrong region");
      if (runtime.nativeMenu) assert.equal(workspaceLayout.topbar, null, "Home toolbar remains in the active workbench");
      if (workspaceLayout.viewport.width >= 1100) assert.ok(workspaceLayout.toolbar?.height <= 80, "Wide inspector toolbar wrapped unexpectedly");
      assert.ok(workspaceLayout.documentOverflowX <= 1, "Inspector layout introduces horizontal document overflow");
      const pivotLayout = await evaluate(`(() => {
        const canvas = document.querySelector('.layer-webgl-canvas');
        const stage = document.querySelector('.screenshot-stage');
        const scene = document.querySelector('.layer-scene');
        if (!canvas || !stage || !scene) return null;
        const canvasRect = canvas.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        return {
          pivotX: Number(scene.dataset.layerPivotX),
          pivotY: Number(scene.dataset.layerPivotY),
          expectedX: stageRect.left - canvasRect.left + stageRect.width / 2,
          expectedY: stageRect.top - canvasRect.top + stageRect.height / 2,
        };
      })()`);
      assert.ok(pivotLayout, "3D scene pivot metadata is missing");
      assert.ok(Math.abs(pivotLayout.pivotX - pivotLayout.expectedX) <= 2 && Math.abs(pivotLayout.pivotY - pivotLayout.expectedY) <= 2, "3D camera is not centered on the window hierarchy");
      if (reducedMotion) {
        assert.equal(layerState.animationName, "none", "reduced-motion did not disable layer animation");
        assert.equal(layerState.animationDuration, "0s", "reduced-motion layer animation still has duration");
        recordCheck("prefers-reduced-motion removes 3D layer animation");
      }
      report.layerState = layerState;
      recordCheck("tree selection opens 3D layer scene and highlights selected plane");
      recordCheck("dark reference workspace keeps canvas, properties and 3D viewport decorations visible");
      await evaluate("document.querySelector('.layer-settings').open = false");
      await evaluate("document.querySelector('.inspector-detach').click()");
      await until(() => evaluate("!document.querySelector('.floating-inspector').classList.contains('is-docked')"), "detach property panel before drag");
      await delay(250);
      const detailsDrag = await evaluate(`(() => {
        const handle = document.querySelector('.inspector-drag-handle');
        const details = document.querySelector('.floating-inspector');
        if (!handle || !details) return null;
        const rect = handle.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        return {
          left: details.getBoundingClientRect().left,
          top: details.getBoundingClientRect().top,
          frameHeight: document.querySelector('.screenshot-frame').getBoundingClientRect().height,
          x, y,
          exposed: handle.contains(document.elementFromPoint(x, y)),
        };
      })()`);
      assert.ok(detailsDrag, "Floating inspector drag handle is missing");
      assert.equal(detailsDrag.exposed, true, "Floating inspector drag handle is covered by another control");
      await connection.send("Page.bringToFront");
      await until(() => evaluate("document.hasFocus()"), "focus property panel drag");
      await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: detailsDrag.x, y: detailsDrag.y, button: "none", buttons: 0 });
      await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: detailsDrag.x, y: detailsDrag.y, button: "left", buttons: 1, modifiers: 0, clickCount: 1 });
      await until(() => evaluate("document.querySelector('.floating-inspector').classList.contains('is-dragging')"), "property panel pointer capture");
      await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: detailsDrag.x - 100, y: detailsDrag.y + 60, button: "left", buttons: 1, modifiers: 0 });
      await until(() => evaluate(`document.querySelector('.floating-inspector').getBoundingClientRect().left < ${detailsDrag.left - 80}`), "property panel drag");
      await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: detailsDrag.x - 100, y: detailsDrag.y + 60, button: "left", buttons: 0, modifiers: 0, clickCount: 1 });
      report.inspectorDrag = await evaluate(`({ before: ${JSON.stringify(detailsDrag)}, after: document.querySelector('.floating-inspector').getBoundingClientRect().toJSON(), focused: document.hasFocus() })`);
      await evaluate("document.querySelector('.inspector-collapse').click()");
      await until(() => evaluate("document.querySelector('.floating-inspector').getBoundingClientRect().height <= 48"), "property panel collapse");
      await evaluate("document.querySelector('.inspector-collapse').click()");
      await until(() => evaluate("document.querySelector('.floating-inspector').getBoundingClientRect().height > 200"), "property panel expand");
      await evaluate("document.querySelector('.inspector-close').click()");
      await until(() => evaluate("document.querySelector('.floating-inspector').hidden"), "property panel close");
      await evaluate("document.querySelector('.inspector-toggle').click()");
      await until(() => evaluate("!document.querySelector('.floating-inspector').hidden"), "property panel restore");
      await evaluate("document.querySelector('.inspector-drag-handle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))");
      await until(() => evaluate(`document.querySelector('.screenshot-frame').getBoundingClientRect().height === ${detailsDrag.frameHeight}`), "camera viewport to settle after floating inspector restoration");
      assert.equal(await evaluate("document.querySelector('.screenshot-frame').getBoundingClientRect().height"), detailsDrag.frameHeight, "Floating inspector changes resized the camera viewport");
      recordCheck("floating property tab drags, collapses, closes and restores without resizing the canvas");
      const inspectorScreenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(join(output, "inspector-groups.png"), Buffer.from(inspectorScreenshot.data, "base64"));
      await evaluate("document.querySelector('.inspector-type > summary').focus()");
      for (const key of [{ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " }]) {
        for (let repeat = 0; repeat < 2; repeat++) {
          const before = await evaluate("document.querySelector('.inspector-type').open");
          await connection.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
          await connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...key, text: undefined });
          await until(() => evaluate(`document.querySelector('.inspector-type').open === ${!before}`), "keyboard property group toggle");
        }
      }
      const propertyCardCountBeforeFilter = await evaluate("document.querySelectorAll('.inspector-card:not([hidden])').length");
      assert.ok(propertyCardCountBeforeFilter > 0, "Selected node has no visible property cards");
      await evaluate("document.querySelector('.inspector-search input').focus()");
      await connection.send("Input.insertText", { text: "bounds" });
      await until(() => evaluate("!document.querySelector('.inspector-layout').hidden && ['.inspector-type', '.inspector-relation', '.inspector-image'].every(selector => document.querySelector(selector).hidden)"), "property group filter");
      const filteredInspector = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(join(output, "inspector-filter.png"), Buffer.from(filteredInspector.data, "base64"));
      await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await until(() => evaluate(`!document.querySelector('.inspector-search input').value && !document.querySelector('.floating-inspector').hidden && document.querySelectorAll('.inspector-card:not([hidden])').length === ${propertyCardCountBeforeFilter}`), "property filter Escape");
      recordCheck("inspector groups support keyboard folding, live property search and Escape without closing the panel");
      const boxModel = await evaluate(`(() => {
        document.querySelector('.inspector-layout').open = true;
        document.querySelector('.inspector-padding').open = true;
        const card = document.querySelector('.box-model-card');
        const section = card.closest('section');
        section.scrollIntoView({ block: 'center' });
        const rect = section.getBoundingClientRect();
        return { text: section.textContent, overflow: card.scrollWidth - card.clientWidth, clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 2 } };
      })()`);
      assert.ok(boxModel.overflow <= 1, "Box model overflows the floating inspector");
      const boxScreenshot = await connection.send("Page.captureScreenshot", { format: "png", clip: boxModel.clip });
      writeFileSync(join(output, "box-model.png"), Buffer.from(boxScreenshot.data, "base64"));
      report.boxModel = { ...boxModel, screenshot: "box-model.png" };
      await evaluate("document.querySelector('.inspector-padding').open = false; document.querySelector('.inspector-body').scrollTop = 0");
      recordCheck("compact box model remains readable inside the floating inspector");
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const hoverPoints = () => evaluate(`(() => {
        const rect = document.querySelector('.layer-webgl-canvas')?.getBoundingClientRect();
        if (!rect) return [];
        const canvas = document.querySelector('.layer-webgl-canvas');
        const probeX = Number(canvas?.dataset.layerProbeX);
        const probeY = Number(canvas?.dataset.layerProbeY);
        const probe = Number.isFinite(probeX) && Number.isFinite(probeY) ? [{ x: rect.left + probeX, y: rect.top + probeY }] : [];
        return [...probe, ...[0.2, 0.5, 0.8].flatMap((x) => [0.2, 0.5, 0.8].map((y) => ({ x: rect.left + rect.width * x, y: rect.top + rect.height * y })))]
      })()`);
      let hoverResult = null;
      for (const point of await hoverPoints()) {
        // Keep this hit-test assertion in browser CSS pixels at every forced DPR.
        await evaluate(`document.querySelector('.layer-webgl-canvas')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${point.x}, clientY: ${point.y}, pointerId: 1, pointerType: 'mouse', isPrimary: true }))`);
        await delay(80);
        const hoveredId = await evaluate("document.querySelector('.layer-scene')?.dataset.layerHoveredId || null");
        if (hoveredId) {
          hoverResult = { point, hoveredId };
          break;
        }
      }
      if (fixture) assert.ok(hoverResult, "3D layer hover did not resolve a layer in the overview");
      if (hoverResult) {
        const hoverScreenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(join(output, "layers3d-hover.png"), Buffer.from(hoverScreenshot.data, "base64"));
        report.layerHover = { ...hoverResult, screenshot: "layers3d-hover.png" };
        recordCheck("3D layer hover resolves a blue-highlight target");
      } else {
        report.layerHover = "skipped: no overview layer intersects the fixed hover grid";
      }
      if (fixture) {
        await evaluate("document.querySelector('.inspector-close').click()");
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        await connection.send("Page.bringToFront");
        await until(() => evaluate("document.hasFocus()"), "measurement window focus");
        await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 40, button: "none", buttons: 0 });
        const anchorId = await evaluate("document.querySelector('.tree-row.selected').dataset.treeId");
        const measurementKey = async (key, code, windowsVirtualKeyCode) => {
          await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode });
          await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
        };
        const readMeasurement = () => evaluate(`(() => {
          // Current inspector exposes the fixed pair in the measurement card and status.
          const overlay = document.querySelector('.layer-measurement-status[data-measure-pinned="true"]');
          if (!overlay) return null;
          const label = document.querySelector('.layer-hover-label');
          return { anchor: overlay.dataset.measureAnchor, target: overlay.dataset.measureTarget, relation: overlay.dataset.measureRelation, text: overlay.textContent,
            pinned: overlay.dataset.measurePinned, path: document.querySelector('.measurement-card-guide')?.getAttribute('d'),
            values: document.querySelector('.measurement-card-values, .measurement-card-zero')?.textContent,
            hoverId: label?.dataset.nodeId, hoverText: label?.textContent, cursor: getComputedStyle(document.querySelector('.layer-webgl-canvas')).cursor };
        })()`);
        let candidate = null;
        for (const point of await hoverPoints()) {
          // Floating canvas tools/inspector can cover a geometrically valid
          // plane. A real click must hit an exposed part of the canvas.
          if (!await evaluate(`document.elementFromPoint(${point.x}, ${point.y}) === document.querySelector('.layer-webgl-canvas')`)) continue;
          await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
          await delay(80);
          assert.equal(await evaluate("Boolean(document.querySelector('.layer-measurement, .layer-measurement-status, .measurement-card, .screenshot-pinned-measurement'))"), false, "Ordinary hover showed measurement guides or values before explicit pinning");
          const result = await evaluate(`(() => {
            const label = document.querySelector('.layer-hover-label');
            const pin = document.querySelector('.pin-layer-measurement');
            return label?.dataset.nodeId && label.dataset.nodeId !== ${JSON.stringify(anchorId)} && pin && !pin.disabled && pin.getAttribute('aria-pressed') === 'false'
              ? { hoverId: label.dataset.nodeId, hoverText: label.textContent } : null;
          })()`);
          if (result) { candidate = { ...result, point }; break; }
        }
        assert.ok(candidate, "Real pointer hover did not offer a measurable target");
        await evaluate("document.querySelector('.screenshot-frame').focus({ preventScroll: true })");
        await measurementKey("m", "KeyM", 77);
        const measurement = { ...await until(async () => {
          const state = await readMeasurement();
          return state?.pinned === "true" && state.values ? state : null;
        }, "explicit M pins measurement guides and values"), point: candidate.point };
        assert.equal(measurement.anchor, anchorId, "Hover replaced the selected anchor");
        assert.equal(measurement.target, candidate.hoverId, "Pinning measured a different target than the real pointer hover");
        assert.equal(measurement.hoverId, measurement.target, "Hover label names a different node than the hit test");
        assert.ok(measurement.hoverText.includes("指向"), "Hover label does not distinguish the candidate from the selection");
        assert.equal(measurement.cursor, "crosshair", "Idle canvas shows a drag hand instead of a precise cursor");
        assert.match(measurement.text, /\d+(?:\.\d+)?\s*px/, "Pinned guides have no source pixel distances");
        assert.match(measurement.values, /\d+(?:\.\d+)?\s*px/, "Pinned measurement card has no source pixel distances");
        assert.equal(await evaluate("document.querySelector('.tree-row.selected').dataset.treeId"), anchorId, "Measurement changed the selected tree node");
        const screenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(join(output, "layers3d-measurement.png"), Buffer.from(screenshot.data, "base64"));
        const { x, y } = measurement.point;
        await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 40, button: "none", buttons: 0 });
        const fixedOnLeave = await readMeasurement();
        assert.ok(fixedOnLeave, "Leaving the canvas discarded the explicitly pinned measurement");
        assert.equal(fixedOnLeave.pinned, "true", "Leaving the canvas unpinned the measurement");
        assert.equal(fixedOnLeave.anchor, measurement.anchor, "Leaving the canvas changed the fixed anchor");
        assert.equal(fixedOnLeave.target, measurement.target, "Leaving the canvas changed the fixed target");
        assert.equal(fixedOnLeave.text, measurement.text, "Leaving the canvas changed source pixel distances");
        assert.equal(fixedOnLeave.values, measurement.values, "Leaving the canvas changed measurement card values");
        await connection.send("Page.bringToFront");
        await until(() => evaluate("document.hasFocus()"), "pinned measurement rotation focus");
        await evaluate("document.querySelector('.screenshot-frame').focus({ preventScroll: true })");
        const pinnedRenderBefore = await evaluate("Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderVersion || 0)");
        await measurementKey("ArrowRight", "ArrowRight", 39);
        const fixedAfterRotation = await until(async () => {
          const state = await readMeasurement();
          const render = await evaluate("Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderVersion || 0)");
          return state?.pinned === "true" && render > pinnedRenderBefore ? state : null;
        }, "fixed measurement survives 3D camera rotation");
        assert.equal(fixedAfterRotation.pinned, "true", "Rotation released the fixed measurement");
        assert.equal(fixedAfterRotation.anchor, measurement.anchor, "Rotation changed the fixed anchor");
        assert.equal(fixedAfterRotation.target, measurement.target, "Rotation changed the fixed target");
        assert.equal(fixedAfterRotation.text, measurement.text, "Rotation changed source pixel distances");
        assert.equal(fixedAfterRotation.values, measurement.values, "Rotation changed measurement card values");
        assert.equal(fixedAfterRotation.path, fixedOnLeave.path, "3D camera rotation must not distort the source-coordinate measurement diagram");
        assert.ok(await evaluate("Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderVersion || 0)") > pinnedRenderBefore, "Pinned camera rotation did not redraw the WebGL scene");
        assert.equal(await evaluate("document.querySelector('.tree-row.selected').dataset.treeId"), anchorId, "Pinned rotation changed the selected anchor");
        await measurementKey("ArrowLeft", "ArrowLeft", 37);
        await measurementKey("m", "KeyM", 77);
        await until(() => evaluate("!document.querySelector('.layer-measurement, .layer-measurement-status, .measurement-card, .screenshot-pinned-measurement') && document.querySelector('.pin-layer-measurement')?.getAttribute('aria-pressed') === 'false' && Boolean(document.querySelector('.layer-webgl-canvas'))"), "M clears fixed guides and values while retaining 3D");
        report.measurementClick = measurement;
        // A repeated CDP move at the same position may not dispatch pointermove
        // after screenshot capture cleared native hover. Re-enter explicitly.
        report.measurementClick.focusBefore = await evaluate(`({ focused: document.hasFocus(), hovered: document.querySelector('.layer-scene')?.dataset.layerHoveredId, hit: document.elementFromPoint(${x}, ${y})?.className })`);
        await connection.send("Page.bringToFront");
        await until(() => evaluate("document.hasFocus()"), "measurement click window focus");
        report.measurementClick.focusAfter = await evaluate(`({ focused: document.hasFocus(), hovered: document.querySelector('.layer-scene')?.dataset.layerHoveredId, hit: document.elementFromPoint(${x}, ${y})?.className })`);
        await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 40, button: "none", buttons: 0 });
        await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
        await until(async () => {
          const state = await evaluate(`({ focused: document.hasFocus(), hovered: document.querySelector('.layer-scene')?.dataset.layerHoveredId, hit: document.elementFromPoint(${x}, ${y})?.className, exposed: document.elementFromPoint(${x}, ${y}) === document.querySelector('.layer-webgl-canvas'), canvas: document.querySelector('.layer-webgl-canvas').getBoundingClientRect().toJSON() })`);
          report.measurementClick.beforeClick = state;
          return state.hovered === measurement.target && state.exposed;
        }, "measurement target remains exposed before click");
        await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
        await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
        await until(() => evaluate(`document.querySelector('.tree-row.selected').dataset.treeId === ${JSON.stringify(measurement.target)} && !document.querySelector('.layer-measurement')`), "click measurement target becomes anchor");
        // Selecting changes the orbit pivot: the stationary pointer may no
        // longer intersect this plane. Check selection, not an obsolete hover.
        await until(() => evaluate(`Array.from(document.querySelectorAll('.layer-plane')).some(plane => plane.dataset.layerNodeId === ${JSON.stringify(measurement.target)} && plane.dataset.layerSelected === 'true')`), "clicked target selected plane");
        await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 40, button: "none", buttons: 0 });
        assert.equal(await evaluate("Boolean(document.querySelector('.layer-measurement, .layer-measurement-status, .measurement-card, .screenshot-pinned-measurement'))"), false, "Leaving the canvas retained measurement guides or values after unpinning");
        await evaluate("document.querySelector('.inspector-toggle').click()");
        report.layerMeasurement = { ...measurement, screenshot: "layers3d-measurement.png" };
        recordCheck("real pointer hover offers measurement without guides or values; explicit M fixes the pair through leave/rotation, M clears it, click target replaces anchor and leave stays clear");
      }
      if (workbenchOnly) {
        const planes = await evaluate(`Array.from(document.querySelectorAll('.layer-plane')).map(plane => ({ id: plane.dataset.layerNodeId, mode: plane.dataset.layerTextureMode }))`);
        const candidates = visibleNativeBranchIds(planes);
        report.businessBranchCandidates = candidates;
        assert.ok(candidates.length, "Scene has no small branch with independent child images");
        await evaluate("document.querySelector('.tree-scroll').scrollTop = 0");
        await until(async () => {
          await delay(80); // React must mount the next virtualized row window.
          return evaluate(`(() => {
            const candidates = ${JSON.stringify(candidates)};
            if (Array.from(document.querySelectorAll('.tree-row')).some(row => candidates.includes(row.dataset.treeId) && row.getAttribute('aria-expanded') === 'true')) return true;
            const tree = document.querySelector('.tree-scroll');
            if (tree.scrollTop + tree.clientHeight >= tree.scrollHeight - 1) throw new Error('Native scene branches were not found in the expanded tree');
            tree.scrollTop += Math.max(28, tree.clientHeight * .75);
            return false;
          })()`);
        }, "reveal native branch in virtual tree");
      }
      const branchId = await evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll('.tree-row'));
        const rootId = rows[0]?.dataset.treeId;
        const planes = Array.from(document.querySelectorAll('.layer-plane')).map(plane => ({ id: plane.dataset.layerNodeId, mode: plane.dataset.layerTextureMode }));
        const row = ${fixture ? "rows.find((item) => item.querySelector('.tree-class')?.textContent?.includes('LinearLayout'))" : workbenchOnly ? "rows.find(item => { if (item.dataset.treeId === rootId || item.getAttribute('aria-expanded') !== 'true') return false; const children = window.__appSmokeDescendants(item.dataset.treeId, planes); return children.length >= 1 && children.length <= 6 && planes.some(plane => plane.id === item.dataset.treeId) && planes.some(plane => children.includes(plane.id) && plane.mode === 'native'); })" : "rows.find((item) => item.dataset.treeId !== rootId && item.hasAttribute('aria-expanded'))"};
        row?.click();
        return row?.dataset.treeId || null;
      })()`);
      if (fixture) assert.ok(branchId, "Fixture does not expose a branch node for 3D expansion");
      if (workbenchOnly) assert.ok(branchId, "No small expanded business branch is available");
      if (branchId) {
        await until(() => evaluate(`document.querySelector('.tree-row.selected')?.dataset.treeId === ${JSON.stringify(branchId)}`), "branch selection");
        await evaluate("document.querySelector('.layer-settings > summary')?.click()");
        await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"3D 层间距\"]'))"), "3D layer gap in settings");
        const branchSpread = await evaluate(`(() => ({
          mode: document.querySelector('.layer-scene')?.dataset.layerMode,
          parentId: document.querySelector('.layer-scene')?.dataset.layerParentId,
          rootId: document.querySelector('.tree-row')?.dataset.treeId,
          gap: Number(document.querySelector('[aria-label="3D 层间距"]')?.value || 0),
          clickableLayers: document.querySelectorAll('.layer-plane[data-layer-hit-testable="true"]').length,
          surfaceCount: document.querySelectorAll('.layer-plane[data-layer-role="surface"]').length,
          textOnlyCount: document.querySelectorAll('.layer-plane[data-layer-content="text"]').length,
          layers: Array.from(document.querySelectorAll('.layer-plane')).map((plane) => {
            const rect = plane.getBoundingClientRect();
            return { role: plane.dataset.layerRole, z: plane.dataset.layerZ, left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
          }),
          zOrderSources: Array.from(document.querySelectorAll('.layer-plane')).map((plane) => plane.dataset.layerZOrderSource),
        }))()`);
        await evaluate("document.querySelector('.layer-settings > summary')?.click()");
        await until(() => evaluate("!document.querySelector('.layer-options')"), "3D settings closed before visual evidence");
        await delay(600);
        const branchScreenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(join(output, "layers3d-branch.png"), Buffer.from(branchScreenshot.data, "base64"));
        report.branchSpread = { ...branchSpread, screenshot: "layers3d-branch.png" };
        if (fixture) {
          assert.equal(branchSpread.mode, "overview", "3D hierarchy must open as a full overview");
          assert.equal(branchSpread.parentId, branchSpread.rootId, "Selecting a container must not collapse the full overview");
          assert.ok(branchSpread.gap >= 64, "Default 3D layer gap is too small");
          assert.ok(branchSpread.clickableLayers > 0, "Overview layers are not directly clickable");
          assert.ok(branchSpread.surfaceCount > 0, "Overview has no independently textured controls");
          assert.ok(branchSpread.zOrderSources.every(Boolean), "Overview does not report its Z-order source");
        }
        recordCheck("full overview stays expanded while selecting a container");
        if (workbenchOnly || fixture) {
          const branchSelector = `.tree-row[data-tree-id=${JSON.stringify(branchId)}]`;
          const readBranch = () => evaluate(`(() => {
            const scene = document.querySelector('.layer-scene');
            const planes = Array.from(document.querySelectorAll('.layer-plane'));
            return { expanded: document.querySelector(${JSON.stringify(branchSelector)})?.getAttribute('aria-expanded'),
              composites: Number(scene?.dataset.layerCompositeCount || 0),
              provenance: planes.map(plane => ({ id: plane.dataset.layerNodeId, source: plane.dataset.layerImageSource, groupState: plane.dataset.layerGroupState })),
              planes: planes.map(plane => ({ id: plane.dataset.layerNodeId, mode: plane.dataset.layerTextureMode })) };
          })()`);
          const before = await readBranch();
          const childIds = descendantPlaneIds(branchId, before.planes);
          assert.ok(childIds.length > 0, "Selected branch has no displayed child planes");
          const expectsComposite = before.planes.some(plane => (plane.id === branchId || childIds.includes(plane.id)) && plane.mode === "native");
          if (workbenchOnly) assert.ok(expectsComposite, "Business branch has no independent image evidence");
          report.businessBranch = { id: branchId, childIds, expectsComposite, before, pixelOracle: "not measured" };
          await evaluate(`document.querySelector(${JSON.stringify(branchSelector)}).querySelector('.tree-chevron').click()`);
          await until(() => evaluate(`document.querySelector(${JSON.stringify(branchSelector)})?.getAttribute('aria-expanded') === 'false'`), "business branch folds");
          await until(async () => branchChildrenRemoved(childIds, (await readBranch()).planes), "fold removes child identities");
          if (expectsComposite) await until(async () => (await readBranch()).planes.some(plane => plane.id === branchId && plane.mode === "composite"), "folded parent has a composite surface");
          if (workbenchOnly && expectsComposite) {
            const started = performance.now();
            const request = { budgetMs: 30_000, elapsedMs: 0, settled: false, timedOut: false, source: null, state: null };
            report.businessBranch.groupRequest = request;
            try {
              await until(async () => {
                const pixels = (await readBranch()).provenance.find(plane => plane.id === branchId);
                request.elapsedMs = Math.round(performance.now() - started);
                request.source = pixels?.source ?? null; request.state = pixels?.groupState ?? null;
                return ["ready", "unavailable"].includes(request.state);
              }, "folded native group request settles", request.budgetMs);
              request.settled = true;
            } catch (error) {
              request.timedOut = request.elapsedMs >= request.budgetMs;
              report.businessBranch.folded = await readBranch();
              throw error;
            }
          } else await delay(600);
          const folded = await readBranch();
          if (expectsComposite) {
            const pixels = folded.provenance.find(plane => plane.id === branchId);
            assert.ok(pixels && ["live-group", "local-composite"].includes(pixels.source), "Folded pixels have no recorded source");
            assert.ok(["ready", "pending", "unavailable", "not-live", "not-requested", "hidden-descendants"].includes(pixels.groupState), "Folded group state is unknown");
            if (pixels.source === "live-group") assert.equal(pixels.groupState, "ready");
          }
          report.businessBranch.folded = folded;
          const foldedScreenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          writeFileSync(join(output, "business-branch-folded.png"), Buffer.from(foldedScreenshot.data, "base64"));
          await evaluate(`document.querySelector(${JSON.stringify(branchSelector)}).querySelector('.tree-chevron').click()`);
          const directChildIds = childIds.filter(id => !id.slice(branchId.length + 1).includes("/"));
          await until(async () => { const state = await readBranch(); return state.expanded === 'true' && directChildIds.every(id => state.planes.some(plane => plane.id === id)); }, "branch reopens direct child planes");
          const reopened = await readBranch();
          assert.ok(!reopened.planes.some(plane => plane.id === branchId && plane.mode === "composite"), "Reopened parent retains its child composite");
          assert.ok(!reopened.planes.some(plane => childIds.includes(plane.id) && !directChildIds.includes(plane.id)), "Reopening unexpectedly expands the entire descendant subtree");
          report.businessBranch.reopened = reopened;
          // Collapse intentionally closes descendants. Only expand-all restores
          // the original fully expanded overview, not reopening one parent.
          await evaluate("document.querySelector('.tree-expand-all').click()");
          await until(async () => { const state = await readBranch(); return state.expanded === 'true' && state.planes.length === before.planes.length; }, "expand-all restores original child planes");
          const expanded = await readBranch();
          assert.deepEqual(expanded.planes, before.planes, "Expansion did not restore the original plane identities and own texture modes");
          assert.ok(!expanded.planes.some(plane => plane.id === branchId && plane.mode === "composite"), "Expanded parent retains its child composite");
          report.businessBranch = { ...report.businessBranch, id: branchId, childIds, expectsComposite, before, folded, reopened, expanded, pixelOracle: "not measured" };
          recordCheck("branch collapse closes descendants, reopen shows one level, expand-all restores original identities");
        }
      }
      const alternateLayerId = await evaluate(`(() => {
        const selectedId = document.querySelector('.tree-row.selected')?.dataset.treeId;
        const rootId = document.querySelector('.tree-row')?.dataset.treeId;
        return Array.from(document.querySelectorAll('.layer-plane:not(.selected)[data-layer-hit-testable="true"]'))
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
          start: { x: frame.left + 28, y: frame.top + 28 },
          end: { x: Math.max(frame.left + 2, frame.right - 3), y: Math.max(frame.top + 2, frame.bottom - 3) },
        };
      })()`);
      if (dragPoints) {
        const selectionBeforeDrag = await evaluate("document.querySelector('.tree-row.selected')?.dataset.treeId");
        const renderBeforeDrag = await evaluate("Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderVersion || 0)");
        await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: dragPoints.start.x, y: dragPoints.start.y, button: "left", buttons: 1, modifiers: 0, clickCount: 1 });
        await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (dragPoints.start.x + dragPoints.end.x) / 2, y: (dragPoints.start.y + dragPoints.end.y) / 2, button: "left", buttons: 1, modifiers: 0 });
        await delay(16);
        await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragPoints.end.x, y: dragPoints.end.y, button: "left", buttons: 1, modifiers: 0 });
        await delay(32);
        const liveDrag = await until(() => evaluate(`(() => {
          const frame = document.querySelector('.screenshot-frame');
          const canvas = document.querySelector('.layer-webgl-canvas');
          const state = {
            dragging: frame?.classList.contains('is-3d-dragging'),
            renderer: canvas?.dataset.layerRenderer,
            renderVersion: Number(canvas?.dataset.layerRenderVersion || 0),
            cursor: canvas && getComputedStyle(canvas).cursor,
            hoverLabel: Boolean(document.querySelector('.layer-hover-label')),
          };
          return state.dragging && state.renderer === 'webgl' && state.renderVersion > ${JSON.stringify(renderBeforeDrag)} ? state : null;
        })()`), "3D live redraw", 5_000);
        assert.equal(liveDrag.dragging, true, "3D drag did not enter its lightweight rendering state");
        assert.equal(liveDrag.renderer, "webgl", "3D drag left the WebGL renderer");
        assert.equal(liveDrag.cursor, "move", "Orbit drag still shows a grab hand");
        assert.equal(liveDrag.hoverLabel, false, "Orbit drag retained a stale hover label");
        assert.ok(liveDrag.renderVersion > renderBeforeDrag, "3D drag did not redraw the WebGL scene");
        await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragPoints.end.x, y: dragPoints.end.y, button: "left", buttons: 0, modifiers: 0, clickCount: 1 });
        await delay(600);
        assert.equal(await evaluate("document.querySelector('.tree-row.selected')?.dataset.treeId"), selectionBeforeDrag, "Orbit drag changed the selected node");
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.layer-webgl-canvas')).cursor"), "crosshair", "Orbit release retained the drag cursor");
        const dragState = await evaluate("Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderVersion || 0)");
        const rotatedScreenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(join(output, "layers3d-rotated.png"), Buffer.from(rotatedScreenshot.data, "base64"));
        report.drag = { points: dragPoints, renderBefore: renderBeforeDrag, renderVersion: dragState, live: liveDrag };
        assert.ok(dragState > renderBeforeDrag, "3D edge drag did not redraw the WebGL scene");
        recordCheck("3D drag redraws the WebGL scene without DOM layer transforms");
        recordCheck("3D left-drag rotates through the viewport edge and releases cleanly");

        if (dragOutside) {
          const outsideBefore = await evaluate("Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderVersion || 0)");
          const frame = await evaluate("(() => { const rect = document.querySelector('.screenshot-frame')?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; })()");
          const outsideX = (await evaluate("innerWidth")) + 180;
          const outsideY = Math.max(1, Math.min((await evaluate("innerHeight")) - 1, frame?.y ?? 1));
          await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: frame?.x ?? dragPoints.start.x, y: frame?.y ?? dragPoints.start.y, button: "left", buttons: 1, modifiers: 0, clickCount: 1 });
          await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (frame?.x ?? dragPoints.start.x) + 80, y: (frame?.y ?? dragPoints.start.y) + 24, button: "none", buttons: 1, modifiers: 0 });
          await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: outsideX, y: outsideY, button: "none", buttons: 1, modifiers: 0 });
          await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: outsideX, y: outsideY, button: "left", buttons: 0, modifiers: 0, clickCount: 1 });
          // Chrome's CDP input domain does not always deliver a release whose
          // coordinates are outside the emulated page. Re-enter once and send
          // an idempotent release so the harness matches the native pointer-up
          // path before continuing with the rest of the smoke checks.
          await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: frame?.x ?? dragPoints.start.x, y: frame?.y ?? dragPoints.start.y, button: "none", buttons: 0, modifiers: 0 });
          await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: frame?.x ?? dragPoints.start.x, y: frame?.y ?? dragPoints.start.y, button: "left", buttons: 0, modifiers: 0, clickCount: 1 });
          await delay(300);
          const outsideState = await evaluate(`(() => ({
            renderVersion: Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderVersion || 0),
            bodyTransform: getComputedStyle(document.body).transform,
            shellTransform: getComputedStyle(document.querySelector('.app-shell')).transform,
            documentOverflowX: document.documentElement.scrollWidth - innerWidth,
            frameFocused: document.activeElement === document.querySelector('.screenshot-frame'),
          }))()`);
          report.dragOutside = { outsidePoint: { x: outsideX, y: outsideY }, renderBefore: outsideBefore, ...outsideState };
          assert.equal(outsideState.bodyTransform, "none", "3D drag leaked a transform to document body");
          assert.equal(outsideState.shellTransform, "none", "3D drag leaked a transform to the app shell");
          assert.ok(outsideState.documentOverflowX <= 1, "Outside drag introduced horizontal document overflow");
          recordCheck("3D drag releases safely after leaving the application viewport");
        }
      }
      const cameraBefore = await evaluate("Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderVersion || 0)");
      await evaluate("document.querySelector('.screenshot-frame').focus()");
      await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
      await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
      await until(() => evaluate(`Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderVersion || 0) > ${JSON.stringify(cameraBefore)}`), "3D keyboard rotation");
      const wheelPoint = await evaluate(`(() => {
        const rect = document.querySelector('.screenshot-frame')?.getBoundingClientRect();
        return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
      })()`);
      if (wheelPoint) {
        const zoomBeforeWheel = await evaluate("Number.parseFloat(document.querySelector('.zoom-readout')?.textContent || '')");
        const wheelHandled = await evaluate(`document.querySelector('.screenshot-frame')?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: ${wheelPoint.x}, clientY: ${wheelPoint.y}, deltaY: -120 })) === false`);
        assert.equal(wheelHandled, true, "Mouse wheel was not handled by the screenshot workspace");
        await until(() => evaluate(`Number.parseFloat(document.querySelector('.zoom-readout')?.textContent || '') > ${zoomBeforeWheel}`), "mouse wheel zoom in");
        const zoomAfterWheel = await evaluate("Number.parseFloat(document.querySelector('.zoom-readout')?.textContent || '')");
        assert.ok(Math.abs(zoomAfterWheel - zoomBeforeWheel * 1.25) <= 1, `Mouse wheel zoomed ${zoomBeforeWheel}% to ${zoomAfterWheel}%, expected 1.25×`);
        await evaluate(`document.querySelector('.screenshot-frame')?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: ${wheelPoint.x}, clientY: ${wheelPoint.y}, deltaY: 120 }))`);
        await until(() => evaluate(`Math.abs(Number.parseFloat(document.querySelector('.zoom-readout')?.textContent || '') - ${zoomBeforeWheel}) <= 1`), "mouse wheel zoom out");
        report.wheelZoom = { before: zoomBeforeWheel, after: zoomAfterWheel };
        recordCheck("mouse wheel zooms the screenshot workspace");
      }
      await evaluate("document.querySelector('.zoom-continuous-toggle')?.click()");
      await until(() => evaluate("Boolean(document.querySelector('.zoom-reset') && document.querySelector('.zoom-preset-select'))"), "zoom toolbar popup");
      await evaluate("document.querySelector('.zoom-reset').click()");
      await until(() => evaluate("document.querySelector('.zoom-readout')?.textContent === '100%'"), "zoom reset before toolbar controls");
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
      await delay(500);
      const layersScreenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(join(output, "layers3d.png"), Buffer.from(layersScreenshot.data, "base64"));
      await evaluate("document.querySelector('.layer-settings > summary')?.click()");
      await until(() => evaluate("Boolean(document.querySelector('.orbit-readout'))"), "3D camera readout for visual baseline");
      report.visualBaseline = { screenshot: "layers3d.png", camera: await evaluate("document.querySelector('.orbit-readout')?.textContent?.trim() || ''"), zoom: "100%" };
      await evaluate("document.querySelector('.layer-settings > summary')?.click()");
      recordCheck("screenshot zoom in and fit controls");
      // Switching to the 3D settings popover already dismissed zoom.
      await until(() => evaluate("!document.querySelector('.zoom-reset')"), "close zoom popup after preset");
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
    if (fixture) {
      await until(() => evaluate("document.querySelector('.layer-scene')?.dataset.layerRootComposite === 'true' && Number(document.querySelector('.layer-scene')?.dataset.layerCompositeCount || 0) >= 1"), "collapsed root composite layer");
      assert.equal(await evaluate("document.querySelectorAll('.layer-plane.surface').length"), 0, "A snapshot without independent bitmaps must not substitute a full-screen crop for its subtree");
      recordCheck("collapsed legacy snapshot avoids unrelated screenshot pixels when independent images are unavailable");
      await evaluate("document.querySelector('.zoom-continuous-toggle')?.click()");
      await until(() => evaluate("Boolean(document.querySelector('.zoom-reset'))"), "zoom popup before collapsed-layer check");
      await evaluate("document.querySelector('.zoom-reset').click()");
      await evaluate("document.querySelector('.zoom-continuous-toggle')?.click()");
      await until(() => evaluate("!document.querySelector('.zoom-reset')"), "zoom popup closed before layer picking");
      await evaluate("document.querySelector('.inspector-close').click()");
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      report.layerDoubleClick = { clicks: [] };
      const parentPoint = () => until(() => evaluate(`(() => {
        const c = document.querySelector('.layer-webgl-canvas');
        if (!c?.dataset.layerProbeX) return null;
        const r = c.getBoundingClientRect();
        return { x: r.left + Number(c.dataset.layerProbeX), y: r.top + Number(c.dataset.layerProbeY) };
      })()`), "collapsed parent hit point");
      for (const clickCount of [1, 2]) {
        const point = await parentPoint();
        await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none", buttons: 0 });
        await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount });
        await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount });
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        report.layerDoubleClick.clicks.push(await evaluate(`({ clickCount: ${clickCount}, point: ${JSON.stringify(point)}, selected: document.querySelector('.tree-row.selected')?.dataset.treeId, expanded: document.querySelector('.tree-row')?.getAttribute('aria-expanded'), action: document.querySelector('[aria-label="双击行为"]').value })`));
        if (clickCount === 1) {
          assert.equal(await evaluate("document.querySelector('.tree-row.selected')?.dataset.treeId === document.querySelector('.tree-row')?.dataset.treeId"), true, "Single click did not select the parent");
          assert.equal(await evaluate("document.querySelector('.tree-row').getAttribute('aria-expanded')"), "false", "Single click expanded the parent");
        }
      }
      await until(() => evaluate("document.querySelector('.tree-row')?.getAttribute('aria-expanded') === 'true' && document.querySelectorAll('.tree-row').length > 1 && document.querySelector('.layer-scene')?.dataset.layerRootComposite === 'false'"), "double-click expands the 3D parent and tree together");
      recordCheck("real pointer double-click expands a collapsed parent in both the 3D scene and tree; single click only selects");
      await evaluate("document.querySelector('.tree-collapse-all').click(); document.querySelector('.inspector-toggle').click()");
    }
    // In 3D a click intentionally picks the front-most projected layer. Switch
    // to 2D before checking source-image coordinate reverse lookup.
    await evaluate("document.querySelector('.view-mode-toggle button')?.click()");
    await until(() => evaluate("!document.querySelector('.screenshot-frame')?.classList.contains('layers3d-active')"), "2D mode before screenshot reverse lookup");
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
    try {
      await until(revealed, "screenshot selection reveals its tree row");
    } catch (error) {
      const revealDiagnostics = await evaluate(`(() => {
        const tree = document.querySelector('.ui-tree-scroll');
        const selected = document.querySelector('.tree-row.selected');
        const detailId = document.querySelector('.node-id')?.textContent || null;
        const rect = (element) => element ? (() => { const value = element.getBoundingClientRect(); return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height }; })() : null;
        return {
          detailId,
          selectedTreeId: selected?.dataset.treeId || null,
          selectedRect: rect(selected),
          treeRect: rect(tree),
          treeScrollTop: tree?.scrollTop ?? null,
          treeScrollHeight: tree?.scrollHeight ?? null,
          treeRowCount: tree?.dataset.rowCount ?? null,
          treeWindow: { start: tree?.dataset.windowStart ?? null, end: tree?.dataset.windowEnd ?? null },
          mountedTreeIds: Array.from(document.querySelectorAll('.tree-row')).map((row) => row.dataset.treeId).slice(0, 24),
          point: ${JSON.stringify(point)},
          imageRect: rect(document.querySelector('.screenshot-stage img')),
        };
      })()`);
      throw new Error(`${error.message}; screenshot reveal diagnostics=${JSON.stringify(revealDiagnostics)}`);
    }
    await delay(150);
    const bounds = await evaluate("Array.from(document.querySelectorAll('.floating-inspector dl div')).find(row => row.querySelector('dt').textContent === 'bounds')?.querySelector('dd').textContent");
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
    await evaluate("document.querySelector('.workbench-scene-tools > .snapshot-drawer > summary').click()");
    const historyBounds = await evaluate(`(() => {
      const drawer = document.querySelector('.workbench-scene-tools > .snapshot-drawer'), body = drawer.querySelector('.snapshot-drawer-body');
      const bounds = body.getBoundingClientRect();
      return { ...bounds.toJSON(), innerWidth, innerHeight, open: drawer.open,
        exposed: body.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + Math.min(16, bounds.height / 2))) };
    })()`);
    report.historyPopover = historyBounds;
    assert.ok(historyBounds.open && historyBounds.width > 0 && historyBounds.height > 0 && historyBounds.exposed, "History popover did not open visibly");
    assert.ok(historyBounds.left >= 0 && historyBounds.right <= historyBounds.innerWidth && historyBounds.bottom <= historyBounds.innerHeight, "History popover is clipped after moving into the header");
    if (!report.captureSavedBeforeInteractions) await evaluate("Array.from(document.querySelectorAll('.workbench-scene-tools > .snapshot-drawer .snapshot-actions button')).find(button => button.textContent === '保存快照').click()");
    await until(() => evaluate("document.querySelectorAll('.workbench-scene-tools > .snapshot-drawer .snapshot-history-item').length === 1"), "save isolated snapshot");
    const storedGeometry = await evaluate("window.electronApi.loadSnapshots().then(result => { if (result.error) throw new Error(result.error); return result.snapshots[0]?.snapshot.captureGeometry; })");
    assert.ok(storedGeometry, "Capture metadata was lost while saving/loading");
    assert.deepEqual(storedGeometry.screenshotSize, report.screenshot);
    await evaluate("document.querySelector('.workbench-scene-tools > .snapshot-drawer .snapshot-history-item').click()");
    await until(() => evaluate(`document.querySelector('.screenshot-stage')?.dataset.coordinateStatus === ${JSON.stringify(geometry.status)} && Boolean(document.querySelector('.selection-overlay'))`), "restored snapshot geometry");
    await until(() => evaluate("document.querySelector('.floating-inspector').getBoundingClientRect().height >= 200"), "inspector follows restored snapshot canvas");
    report.storedGeometry = storedGeometry;
    await evaluate("document.querySelector('.workbench-scene-tools > .snapshot-drawer').open = false");
    recordCheck("snapshot save/load and history preview retain capture geometry");

    if (!workbenchOnly && report.inspectionSummary.includes("SDK 树")) {
      // Feed rows recycle between the two captures, so pick a control that survives: the
      // shallowest visible text control fully inside the screen (persistent chrome), read
      // from the restored snapshot instead of the virtualised tree markup.
      const priorityTarget = await evaluate(`window.electronApi.loadSnapshots().then(result => {
        if (result.error) throw new Error(result.error);
        const root = result.snapshots[0]?.snapshot.root;
        if (!root) return null;
        const screen = ${JSON.stringify(report.screenshot)};
        let best = null;
        const stack = [[root, "0"]];
        while (stack.length) {
          const [node, id] = stack.pop();
          const segments = id.split("/").length;
          const bounds = node.bounds;
          const onScreen = bounds && bounds.left >= 0 && bounds.top >= 0
            && (!screen || (bounds.right <= screen.width && bounds.bottom <= screen.height));
          if (node.visibleToUser && onScreen && node.text && node.className.includes("TextView")
              && (!best || segments < best.segments)) best = { id, segments, text: node.text };
          for (let index = node.children.length - 1; index >= 0; index--) stack.push([node.children[index], id + "/" + index]);
        }
        return best && { id: best.id, query: best.text.trim().slice(0, 24) };
      })`);
      assert.ok(priorityTarget && priorityTarget.id && priorityTarget.query, "Could not find a stable visible TextView for priority capture");
      await evaluate("document.querySelector('.tree-search').focus()");
      await connection.send("Input.insertText", { text: priorityTarget.query });
      await until(() => evaluate("document.querySelector('.tree-search').value !== ''"), "priority TextView filter input");
      await evaluate("(() => { const tree = document.querySelector('.ui-tree-scroll'); tree.scrollTop = 0; })()");
      await until(() => evaluate(`Boolean(document.querySelector('.tree-row[data-tree-id=${JSON.stringify(priorityTarget.id)}]'))`), "priority capture target row");
      const selectedId = await evaluate(`(() => {
        const row = document.querySelector('.tree-row[data-tree-id=${JSON.stringify(priorityTarget.id)}]');
        if (!row) return null;
        row.click();
        return row.dataset.treeId;
      })()`);
      assert.ok(selectedId, "Could not select a visible native TextView for priority capture");
      await until(() => evaluate(`document.querySelector('.tree-row.selected')?.dataset.treeId === ${JSON.stringify(selectedId)}`), "priority capture selection");
      await evaluate("document.querySelector('.tree-clear-inline').click()");
      await until(() => evaluate("document.querySelector('.tree-search').value === ''"), "clear priority capture filter");
      await evaluate(`(() => {
        const events = [];
        const stages = [];
        window.__appSmokePriorityEvents = events;
        window.__appSmokePriorityStages = stages;
        window.electronApi.onInspectionProgress((progress) => stages.push({ atMs: Math.round(performance.now()), stage: progress.stage, elapsedMs: progress.elapsedMs }));
        window.electronApi.onInspectionPreview((preview) => {
          if (preview.phase !== "layers") return;
          events.push(preview.updates.filter(update => Boolean(update.layerImageDataUrl)).map(update => update.id));
        });
        document.querySelector('.capture-button:not([disabled])').click();
      })()`);
      await until(() => evaluate("Boolean(document.querySelector('.capture-button[disabled]'))"), "priority capture start", 5000);
      await until(() => evaluate("Boolean(document.querySelector('.capture-button:not([disabled])') || document.querySelector('.error-placeholder'))"), "priority capture completion", 90_000);
      const priorityEvents = await evaluate("window.__appSmokePriorityEvents || []");
      const priorityStages = await evaluate("window.__appSmokePriorityStages || []");
      const priorityOutcome = await evaluate(`(() => ({
        warning: document.querySelector('.snapshot-warning-message')?.textContent ?? null,
        errorText: document.querySelector('.error-placeholder p')?.textContent ?? null,
        summary: document.querySelector('.snapshot-summary')?.textContent ?? null,
        buttonEnabled: Boolean(document.querySelector('.capture-button:not([disabled])')),
      }))()`);
      const priorityTreeState = await evaluate(`(() => ({
        rowCount: document.querySelectorAll('.tree-row').length,
        dataRowCount: document.querySelector('.ui-tree-scroll')?.dataset.rowCount ?? null,
        selectedRowPresent: Array.from(document.querySelectorAll('.tree-row')).some((row) => row.dataset.treeId === ${JSON.stringify(selectedId)}),
        nowSelected: document.querySelector('.tree-row.selected')?.dataset.treeId ?? null,
      }))()`);
      report.priorityCapture = {
        selectedId,
        firstUpdateCount: priorityEvents[0]?.length ?? 0,
        updateCount: priorityEvents.length,
        totalImageUpdates: priorityEvents.reduce((total, batch) => total + batch.length, 0),
        firstBatchHead: priorityEvents[0]?.slice(0, 40) ?? [],
        firstBatchContainsSelected: Boolean(priorityEvents[0]?.includes(selectedId)),
        anyBatchContainsSelected: priorityEvents.some((batch) => batch.includes(selectedId)),
        treeAfterCapture: priorityTreeState,
        outcome: priorityOutcome,
        priorityStages: priorityStages.slice(-80),
      };
      assert.ok(report.priorityCapture.firstBatchContainsSelected, "Selected View was not included in the first independent-image update");
      recordCheck("selected View is included in the first independent-image update");
    }

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
  if (connection) {
    try {
      const failure = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(join(output, "failure.png"), Buffer.from(failure.data, "base64"));
      report.failureState = await connection.send("Runtime.evaluate", { expression: "({ focused: document.hasFocus(), selected: document.querySelector('.tree-row.selected')?.dataset.treeId, warning: document.querySelector('.snapshot-warning-message')?.textContent ?? null, errorText: document.querySelector('.error-placeholder p')?.textContent ?? null, summary: document.querySelector('.snapshot-summary')?.textContent ?? null, gesture: document.querySelector('.screenshot-frame')?.dataset.gesture, hovered: document.querySelector('.layer-scene')?.dataset.layerHoveredId, label: document.querySelector('.layer-hover-label')?.textContent, priorityStages: (window.__appSmokePriorityStages ?? []).slice(-80), priorityBatchSizes: (window.__appSmokePriorityEvents ?? []).map(batch => batch.length) })", returnByValue: true });
    } catch (diagnosticError) { report.diagnosticError = String(diagnosticError); }
  }
  process.exitCode = 1;
} finally {
  report.rendererErrors = connection?.errors ?? [];
  connection?.close();
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { if (!exited) child.kill(); }
    if (!exited) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2000)]);
    try { process.kill(-child.pid, 0); process.kill(-child.pid, "SIGKILL"); } catch { }
  } else if (!exited) {
    child.kill();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2000)]);
  }
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(output, "stdout.log"), stdout);
  writeFileSync(join(output, "stderr.log"), stderr);
  console.log(JSON.stringify({ output, ...report }, null, 2));
}

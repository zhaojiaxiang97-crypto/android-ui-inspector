// Actual candidate renderer + production CSS, with an isolated synthetic bridge.
// This does NOT accept the installed window or substitute the product main/preload.
const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve, sep } = require("node:path");
const { fileURLToPath } = require("node:url");
const { Worker } = require("node:worker_threads");
const evidence = require("./lib/packaged-check-evidence.cjs");
const { viewports, verifyDisclosureKeyboard, verifyDialogKeyboard } = require("./lib/workbench-ui-driver.cjs");
const project = resolve(__dirname, ".."), options = evidence.parseArgs(process.argv.slice(2));
const output = evidence.createEvidence(join(project, ".benchmarks/packaged-handoff"), options);
app.setPath("userData", join(output, "profile"));
const report = { ...options, output, passed: false, fixtureOnly: true, installedAcceptance: false,
  coverage: "candidate renderer/CSS only; test main/preload", phoneOperations: 0,
  resourceIdentity: null, resourcesUnchanged: false, runs: [], rendererErrors: [], blockedRequests: [] };
let window, finished = false;
function finish(error) {
  if (finished) return; finished = true;
  if (error) { report.passed = false; report.error = String(error.stack ?? error); }
  evidence.writeResult(output, report); console.log(JSON.stringify(report, null, 2));
  clearTimeout(deadline); app.exit(report.passed ? 0 : 1);
}
const deadline = setTimeout(() => finish(new Error("Candidate handoff checks exceeded 90 seconds")), 90000);
app.whenReady().then(async () => {
  try {
    const identity = evidence.resourceIdentity(options.resources); report.resourceIdentity = identity;
    if (identity.candidate) assert.equal(identity.candidate, options.candidate, "Candidate identifier mismatch");
    const fixtureFile = join(output, "fixture.cjs"), checksFile = join(output, "checks.js"), imagesFile = join(output, "webp-images.cjs");
    for (const [entry, target, format, outfile] of [["benchmarks/diagnosis-handoff-fixture.ts", "node", "cjs", fixtureFile],
      ["benchmarks/workbench-properties-checks.ts", "node", "cjs", join(output, "properties-fixture.cjs")],
      ["benchmarks/diagnosis-handoff-packaged-entry.ts", "browser", "iife", checksFile], ["tests/fixtures/webp-images.ts", "node", "cjs", imagesFile]])
      execFileSync("bun", ["build", entry, "--target", target, "--format", format, "--outfile", outfile], { cwd: project, timeout: 10000 });
    // Exercise the actual archived worker and its packaged native dependencies, not local sharp.
    const worker = new Worker(join(options.resources, "app.asar", "dist-electron/webp-alpha-worker.cjs"));
    report.webpChecks = [];
    try {
      for (const image of require(imagesFile).webpImages) {
        const bytes = Buffer.from(image.data, "base64"), before = evidence.hash(bytes);
        const empty = await new Promise((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); worker.removeListener("message", success); worker.removeListener("error", failure); worker.removeListener("exit", exited); };
          const success = value => { cleanup(); resolve(value); }, failure = error => { cleanup(); reject(error); };
          const exited = code => failure(new Error(`Candidate worker exited: ${code}`));
          const timer = setTimeout(() => failure(new Error("Candidate worker exceeded 3 seconds")), 3000);
          worker.once("message", success); worker.once("error", failure); worker.once("exit", exited);
          worker.postMessage({ bytes, size: { width: 2, height: 2 } });
        });
        assert.equal(empty, image.alpha === 0, `Candidate WebP result: ${image.name}`); assert.equal(evidence.hash(bytes), before);
        report.webpChecks.push({ name: image.name, empty, sourceUnchanged: true });
      }
    } finally { await worker.terminate(); }
    const pixels = Buffer.alloc(360 * 640 * 4);
    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = 50; pixels[index + 1] = 35; pixels[index + 2] = 24; pixels[index + 3] = 255;
    }
    const snapshot = require(fixtureFile).diagnosisHandoffFixture(nativeImage.createFromBitmap(pixels, { width: 360, height: 640 }).toDataURL());
    const richSnapshot = require(join(output, "properties-fixture.cjs")).propertiesFixture(snapshot.screenshotDataUrl);
    let activeSnapshot = snapshot, original = JSON.stringify(snapshot), mode = "handoff", state = "connected";
    let calls, copied = [], copyFailure = false, holdNextCopy = false, releaseCopy;
    let totals = { captures: 0, writes: 0, deviceActions: 0 };
    const configure = (nextMode, nextState = "connected") => {
      mode = nextMode; state = nextState;
      activeSnapshot = mode === "properties" ? richSnapshot : mode === "entry" ? { ...snapshot, rawXml: "<hierarchy/>" }
        : mode === "history" ? { ...snapshot, screenshotDataUrl: null }
        : mode === "failure" || mode === "empty" ? { ...snapshot, root: null, nodeCount: 0, screenshotDataUrl: null, error: mode === "failure" ? "合成 Debug 连接失败" : null } : snapshot;
      original = JSON.stringify(activeSnapshot); calls = { captures: 0, writes: 0, deviceActions: 0 };
      copied = []; copyFailure = holdNextCopy = false; releaseCopy = undefined;
    };
    const audit = () => ({ ...calls, sourceUnchanged: JSON.stringify(activeSnapshot) === original });
    configure("handoff");
    window = new BrowserWindow({ show: false, width: 1440, height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        preload: join(__dirname, "packaged-handoff-preload.cjs") } });
    const web = window.webContents, loaded = new Set(), candidateDist = join(options.resources, "app.asar", "dist");
    web.session.webRequest.onBeforeRequest((details, callback) => {
      let allowed = details.url.startsWith("data:image/");
      if (details.url.startsWith("file:")) {
        const path = fileURLToPath(details.url);
        allowed = path === join(candidateDist, "index.html") || path.startsWith(candidateDist + sep);
        if (allowed) loaded.add(path);
      }
      if (!allowed) report.blockedRequests.push(details.url);
      callback({ cancel: !allowed });
    });
    web.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    web.on("will-navigate", event => event.preventDefault());
    web.setWindowOpenHandler(() => ({ action: "deny" }));
    web.on("console-message", details => { if (details.level === "error") report.rendererErrors.push(details.message); });
    web.on("preload-error", (_event, _path, error) => report.rendererErrors.push(String(error)));
    web.on("render-process-gone", (_event, details) => report.rendererErrors.push(details.reason));
    const validSender = event => assert(event.sender === web && event.senderFrame === web.mainFrame, "Unexpected fixture sender");
    ipcMain.on("local-handoff-control", (event, method, args) => {
      try {
        validSender(event);
        let value;
        if (method === "snapshot") value = activeSnapshot;
        else if (method === "copied") value = copied;
        else if (method === "failCopy") copyFailure = args[0] === true;
        else if (method === "holdCopy") holdNextCopy = true;
        else if (method === "releaseCopy") { assert(releaseCopy, "No held copy"); releaseCopy(); releaseCopy = undefined; }
        else throw new Error(`Unknown fixture control: ${method}`);
        event.returnValue = { value };
      } catch (error) { event.returnValue = { error: String(error) }; }
    });
    ipcMain.handle("local-handoff-fixture", async (event, method, args) => {
      validSender(event);
      if (method === "audit") return audit();
      if (method === "updateAppMenu") return;
      if (method === "copyText") {
        if (copyFailure) throw new Error("Synthetic copy failure");
        if (holdNextCopy) { holdNextCopy = false; await new Promise(resolve => { releaseCopy = resolve; }); }
        copied.push(args[0]); return;
      }
      if (method === "loadSnapshots") return { snapshots: mode === "history" ? [{ id: "synthetic-history", capturedAt: "2026-10-10T00:00:00Z",
        savedAt: "2026-10-10T00:00:01Z", snapshot: activeSnapshot }] : [], error: null };
      if (method === "probeAdb") {
        if (state === "loading") return new Promise(() => {});
        const ready = { serial: snapshot.serial, state: "device", model: mode === "handoff" || mode === "properties" ? "本地样本" : "中文长设备名称 / ".repeat(20),
          androidVersion: "fixture", product: null, transportId: null };
        return { adbPath: state === "adb-missing" ? null : "synthetic-only", adbVersion: "fixture",
          error: state === "error" ? "本地连接错误 / ".repeat(90) : null,
          devices: state === "no-device" ? [] : state === "offline" || state === "unauthorized" ? [{ ...ready, state }]
            : mode === "handoff" || mode === "properties" ? [ready] : [ready, { ...ready, serial: "pending-fixture", state: "unauthorized" }, { ...ready, serial: "offline-fixture", state: "offline" }] };
      }
      if (method === "inspectDevice") {
        calls.captures++; totals.captures++;
        assert(calls.captures === 1 && args[0] === activeSnapshot.serial, "Only one synthetic capture per fixture allowed");
        if (mode === "handoff" || mode === "properties") assert(args[3] === true && args[4]?.expectedPackage === "com.example.benchmark", "Missing scoped diagnosis policy");
        return activeSnapshot;
      }
      if (["saveSnapshot", "clearSnapshots", "exportSnapshot"].includes(method)) { calls.writes++; totals.writes++; }
      else { calls.deviceActions++; totals.deviceActions++; }
      throw new Error(`Forbidden local fixture action: ${method}`);
    });
    const loadFixture = async (nextMode, nextState = "connected") => {
      assert(audit().sourceUnchanged && !calls.writes && !calls.deviceActions, "Previous fixture mutated source/history or called device");
      configure(nextMode, nextState); loaded.clear();
      await window.loadFile(join(candidateDist, "index.html"));
      const location = await web.executeJavaScript("location.href");
      assert.equal(fileURLToPath(location), join(candidateDist, "index.html"));
      await web.executeJavaScript(readFileSync(checksFile, "utf8"));
      for (const name of Object.keys(identity.files).filter(name => /^dist\/assets\/.*\.(css|js)$/.test(name)))
        assert(loaded.has(join(options.resources, "app.asar", name)), `Candidate asset not loaded: ${name}`);
      return location;
    };
    const shot = async name => writeFileSync(join(output, name), (await web.capturePage()).toPNG(), { flag: "wx" });
    for (const [width, height] of viewports) {
      totals = { captures: 0, writes: 0, deviceActions: 0 };
      window.setContentSize(width, height);
      await web.session.clearStorageData({ storages: ["localstorage"] });
      const location = await loadFixture("handoff");
      const result = await web.executeJavaScript("window.verifyDiagnosisHandoff()");
      await shot(`handoff-${width}.png`);
      const run = { width, height, location, loaded: [...loaded], ...result }; report.runs.push(run);
      for (const [name, fn] of [["layout", "verifyWorkbenchLayout"], ["tree", "verifyWorkbenchTree"], ["focus", "verifyWorkbenchFocus"], ["canvas", "verifyWorkbenchCanvas"]]) {
        run[name] = await web.executeJavaScript(`window.${fn}()`); await shot(`${name}-${width}.png`);
        assert.deepEqual(audit(), { captures: 1, writes: 0, deviceActions: 0, sourceUnchanged: true });
      }
      await loadFixture("properties");
      run.properties = await web.executeJavaScript("window.verifyWorkbenchProperties()");
      assert.deepEqual(audit(), { captures: 1, writes: 0, deviceActions: 0, sourceUnchanged: true });
      await verifyDisclosureKeyboard(web, ".inspector-type", [false, true]);
      run.properties.keyboardDisclosure = true; await shot(`properties-${width}.png`);
      run.entry = { scenarios: ["seven honest home states with full device/error content"], homeStates: [] };
      for (const homeState of ["connected", "loading", "unauthorized", "offline", "adb-missing", "no-device", "error"]) {
        await loadFixture("home", homeState);
        run.entry.homeStates.push(await web.executeJavaScript(`window.verifyHomeState(${JSON.stringify(homeState)})`));
        await shot(`entry-${homeState}-${width}.png`);
      }
      await loadFixture("entry"); await web.executeJavaScript("window.verifyHomeState('connected')");
      await web.executeJavaScript("document.querySelector('.home-secondary-action[aria-haspopup=dialog]').focus(); document.querySelector('.home-secondary-action[aria-haspopup=dialog]').click()");
      await verifyDialogKeyboard(web, ".home-device-switcher", ".home-secondary-action[aria-haspopup=dialog]");
      run.entry.deviceDialogKeyboard = true;
      const entries = await web.executeJavaScript("window.verifyEntryControls()");
      run.entry.scenarios.push(...entries.scenarios); run.entry.reachableCommands = entries.reachableCommands;
      assert.deepEqual(audit(), { captures: 1, writes: 0, deviceActions: 0, sourceUnchanged: true });
      await shot(`commands-${width}.png`);
      await loadFixture("history", "offline");
      const history = await web.executeJavaScript("window.verifyOfflineHistory()");
      run.entry.drawers = history.drawers; run.entry.scenarios.push(...history.scenarios);
      assert.deepEqual(audit(), { captures: 0, writes: 0, deviceActions: 0, sourceUnchanged: true });
      await shot(`offline-history-${width}.png`);
      await loadFixture("empty");
      run.entry.scenarios.push(...(await web.executeJavaScript("window.verifyEmptyCapture()")).scenarios);
      assert.deepEqual(audit(), { captures: 1, writes: 0, deviceActions: 0, sourceUnchanged: true });
      await shot(`empty-workbench-${width}.png`);
      await loadFixture("failure");
      run.entry.scenarios.push(...(await web.executeJavaScript("window.verifyFailedCapture()")).scenarios);
      assert.deepEqual(audit(), { captures: 1, writes: 0, deviceActions: 0, sourceUnchanged: true });
      await shot(`capture-failure-${width}.png`);
      await loadFixture("home"); await web.executeJavaScript("window.verifyHomeState('connected')");
      await web.executeJavaScript("document.querySelector('.home-application-menu').open = true; document.querySelector('.home-application-menu [data-command=preferences]').focus(); document.querySelector('.home-application-menu [data-command=preferences]').click()");
      await shot(`preferences-${width}.png`);
      await verifyDialogKeyboard(web, ".preferences-panel", ".home-application-menu > summary"); run.entry.preferencesKeyboard = true;
      assert.equal(totals.captures, 5); assert.equal(totals.writes, 0); assert.equal(totals.deviceActions, 0);
      run.calls = { ...totals, sourceUnchanged: true }; run.entry.fixtureOnly = true;
    }
    assert.deepEqual(report.rendererErrors, []); assert.deepEqual(report.blockedRequests, []);
    evidence.verifyUnchanged(identity, options.resources); report.resourcesUnchanged = true;
    report.passed = true; finish();
  } catch (error) {
    if (window && !window.isDestroyed()) {
      try {
        report.activeElement = await window.webContents.executeJavaScript("document.activeElement?.outerHTML.slice(0, 500)");
        report.layout = await window.webContents.executeJavaScript(`['.app-shell','.workspace','.home-view','.home-center-state','.home-center-state h2','.screenshot-frame','.floating-inspector','.inspector-body'].map(selector => {
          const element = document.querySelector(selector); if (!element) return { selector, missing: true };
          const bounds = element.getBoundingClientRect(); return { selector, hidden: element.hidden,
            left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, style: element.getAttribute('style') }; })`);
        writeFileSync(join(output, "failed.png"), (await window.webContents.capturePage()).toPNG(), { flag: "wx" });
      }
      catch (captureError) { report.screenshotError = String(captureError); }
    }
    finish(error);
  }
}).catch(finish);

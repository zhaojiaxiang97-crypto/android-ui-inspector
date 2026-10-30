const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict"), sharp = require("sharp");
const project = resolve(__dirname, ".."), output = join(project, ".benchmarks", "image-round3");
mkdirSync(output, { recursive: true }); app.setPath("userData", mkdtempSync(join(output, "profile-")));
const deadline = setTimeout(() => { console.error("Image round 3 exceeded 240 seconds"); app.exit(1); }, 240000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, title: "离线图片交互检查",
    webPreferences: { preload: join(__dirname, "image-round3-checks-preload.cjs"), sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  let zoom = 1, width = 1440;
  const report = { fixtureOnly: true, sandbox: true, generatedAt: new Date().toISOString(), runs: [], outputChecks: [], passed: false };
  const { outputNodeImage } = require(join(output, "image-output.cjs"));
  ipcMain.handle("fixture-image-output", async (event, request, outcome = "success") => {
    if (event.sender !== window.webContents || !["success", "cancel", "copy-failure"].includes(outcome)) throw new Error("unexpected output fixture sender or outcome");
    const input = Buffer.from(request.dataUrl.split(",")[1], "base64");
    const source = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const verify = async bytes => {
      const result = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.deepEqual(result.info, source.info, "preview output changed original image dimensions/channels");
      assert.deepEqual(result.data, source.data, "preview output changed original RGBA pixels");
      report.outputChecks.push({ zoom, windowWidth: width, action: request.action, outcome, width: result.info.width, height: result.info.height, originalRgba: true,
        alphaSamples: [result.data[3], result.data[7], result.data[11]], fileName: request.defaultFileName });
    };
    return outputNodeImage(request, {
      choosePath: async () => outcome === "cancel" ? null : "/offline/control.png",
      write: async (_path, bytes) => { await verify(bytes); },
      copy: async bytes => { if (outcome === "copy-failure") throw new Error("clipboard fixture failure"); await verify(bytes); },
    });
  });
  ipcMain.handle("fixture-image-input", async (event, inputs) => {
    if (event.sender !== window.webContents) throw new Error("unexpected fixture sender");
    for (const input of inputs) {
      const next = { ...input };
      if (next.x !== undefined) next.x = Math.round(next.x * zoom);
      if (next.y !== undefined) next.y = Math.round(next.y * zoom);
      window.webContents.sendInputEvent(next); await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
  ipcMain.handle("fixture-image-checkpoint", async (event, name) => {
    if (event.sender !== window.webContents || !/^[a-z0-9-]+$/.test(name)) throw new Error("invalid checkpoint");
    writeFileSync(join(output, `${width}-${zoom * 100}-${name}.png`), (await window.webContents.capturePage()).toPNG());
  });
  try {
    await window.loadURL(pathToFileURL(join(project, "benchmarks/image-round3.html")).href); window.webContents.focus();
    for (zoom of [1, 1.25, 1.5]) for (const dimensions of [[1440, 900], [960, 700], [650, 760]]) {
      width = dimensions[0]; window.setSize(...dimensions); window.webContents.setZoomFactor(zoom);
      for (const appearance of ["dark", "light"]) {
        const run = await window.webContents.executeJavaScript(`window.verifyImageRound3(window.fixtureNative, ${JSON.stringify(appearance)})`);
        if (window.webContents.getZoomFactor() !== zoom) throw new Error("preview Ctrl-wheel changed page zoom");
        report.runs.push({ zoom, window: dimensions, ...run }); console.log(`Image ${dimensions.join("x")} ${zoom * 100}% ${appearance}: ${run.scenarios.length} groups, ${run.deviceRequests} device requests`);
      }
    }
    report.passed = true;
  } catch (error) {
    report.error = String(error); console.error(error); writeFileSync(join(output, "failure.png"), (await window.webContents.capturePage()).toPNG());
  } finally {
    writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n"); clearTimeout(deadline); app.exit(report.passed ? 0 : 1);
  }
}).catch(error => { console.error(error); app.exit(1); });

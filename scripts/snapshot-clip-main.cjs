const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync, mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const source = process.argv[2], output = process.argv[3], branch = process.argv[4], groupFile = process.argv[5];
app.setPath("userData", mkdtempSync(join(output, "profile-")));
const deadline = setTimeout(() => app.exit(1), 30_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let result;
  try {
    await window.loadURL("about:blank");
    await window.webContents.executeJavaScript(readFileSync(join(output, "checker.js"), "utf8"));
    const rectangularFixtures = await window.webContents.executeJavaScript("SnapshotClip.checkRectangularReferenceFixtures()");
    const snapshot = JSON.parse(readFileSync(source, "utf8"))[0].snapshot;
    const root = snapshot.root;
    if (branch) {
      const group = groupFile ? `data:image/png;base64,${readFileSync(groupFile).toString("base64")}` : undefined;
      const check = await window.webContents.executeJavaScript(`SnapshotClip.checkSnapshotBranch(${JSON.stringify(root)}, ${JSON.stringify(branch)}, ${JSON.stringify(snapshot.captureGeometry?.beforeScreenshot)}, ${JSON.stringify(group)})`);
      for (const [name, key] of [["actual.png", "actualPng"], ["expected.png", "expectedPng"], ["group.png", "groupPng"]]) {
        if (!check[key]) continue;
        writeFileSync(join(output, name), Buffer.from(check[key].split(",")[1], "base64"));
        delete check[key];
      }
      result = { success: check.verified, rectangularFixtures, ...check };
    } else result = { success: true, rectangularFixtures, ...await window.webContents.executeJavaScript(`SnapshotClip.checkSnapshotClips(${JSON.stringify(root)})`) };
  } catch (error) { result = { success: false, error: String(error) }; }
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(output, JSON.stringify(result));
  clearTimeout(deadline); app.exit(result.success ? 0 : 1);
});

const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync, mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const output = process.argv[2];
app.setPath("userData", mkdtempSync(join(output, "profile-")));
const deadline = setTimeout(() => app.exit(1), 30_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let result;
  try {
    const { source, inputs } = JSON.parse(readFileSync(join(output, "input.json"), "utf8"));
    await window.loadURL("about:blank");
    await window.webContents.executeJavaScript(readFileSync(join(output, "checker.js"), "utf8"));
    const cases = [];
    for (const [i, input] of inputs.entries()) {
      const row = await window.webContents.executeJavaScript(`PairedColor.checkPairedColor(${JSON.stringify(input)})`);
      for (const key of ["desktopPng", "truncatedAlphaControlPng"]) {
        writeFileSync(join(output, `${i}-${key}.png`), Buffer.from(row[key].split(",")[1], "base64"));
        delete row[key];
      }
      cases.push(row);
    }
    const desktopMatchesPhone = cases.every(c => c.desktopVsPhone.mismatchedPixels === 0);
    const desktopMatchesNativeGroup = cases.every(c => c.desktopVsNativeGroup.mismatchedPixels === 0);
    result = { diagnosticCompleted: true, success: desktopMatchesPhone && desktopMatchesNativeGroup, source, cases,
      desktopMatchesPhone, desktopMatchesNativeGroup,
      scope: "saved fixed sample PNGs at original dimensions; production Canvas composition versus flat references, Android composed and native group; not live capture or WebGL" };
  } catch (error) { result = { diagnosticCompleted: false, success: false, error: String(error) }; }
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(output, JSON.stringify({ success: result.success, diagnosticCompleted: result.diagnosticCompleted,
    cases: result.cases?.map(c => ({ case: c.case, desktopVsPhone: c.desktopVsPhone.mismatchedPixels,
      desktopVsNative: c.desktopVsNativeGroup.mismatchedPixels, flatRaw: c.desktopVsFlatRaw.mismatchedPixels,
      truncatedAlphaVsPhone: c.truncatedAlphaControlVsPhone.mismatchedPixels,
      truncatedAlphaVsNative: c.truncatedAlphaControlVsNativeGroup.mismatchedPixels })), error: result.error }));
  clearTimeout(deadline); app.exit(result.success ? 0 : 1);
});

// Actual desktop window and menu lifecycle, using only isolated local fixture data.
const { app, BrowserWindow, Menu, screen } = require("electron");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const project = resolve(__dirname, "..");
const base = join(project, ".benchmarks", "window-layout");
mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, "run-"));
app.setAppPath(project); app.setPath("userData", join(output, "profile"));
process.argv.push("--visual-fixture");
require(join(project, "dist-electron/main.cjs"));
const report = { passed: false, fixtureOnly: true, output, checks: [], rendererErrors: [] };
const deadline = setTimeout(() => { console.error("Window layout checks timed out"); app.exit(1); }, 30000);
const until = async predicate => {
  for (let i = 0; i < 160; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error("Window layout did not settle");
};
app.whenReady().then(async () => {
  const window = BrowserWindow.getAllWindows()[0], web = window.webContents;
  const evaluate = code => web.executeJavaScript(code);
  const command = async id => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (item) { assert(item.enabled, `Menu disabled: ${id}`); item.click(); }
    else await evaluate(`document.querySelector('.home-application-menu').open = true; document.querySelector('[data-command="${id}"]').click()`);
  };
  const home = () => evaluate("!document.querySelector('.inspection-active') && document.querySelector('.home-view')?.dataset.state === 'connected'");
  const size = () => window.getBounds();
  web.on("console-message", details => { if (details.level === "error") report.rendererErrors.push(details.message); });
  try {
    await until(home);
    await until(() => Menu.getApplicationMenu()?.getMenuItemById("capture")?.enabled || process.platform !== "darwin");
    assert.equal(size().width, 440); assert.equal(size().height, 640);
    assert.equal(await evaluate("Boolean(document.querySelector('.debug-home-controls'))"), false);
    const homeBounds = { ...size() };
    report.checks.push("440×640 initial window; no bottom tool strip");
    await command("capture"); await until(() => evaluate("Boolean(document.querySelector('.inspection-active .tree-row'))"));
    await until(() => size().width >= 960 && size().height >= 700);
    const area = screen.getDisplayMatching(size()).workArea;
    const workspace = { x: area.x + 20, y: area.y + 20, width: Math.min(1100, area.width - 40), height: Math.min(760, area.height - 40) };
    window.setBounds(workspace); const savedBounds = { ...size() };
    await command("save");
    await until(() => evaluate("window.electronApi.loadSnapshots().then(result => result.snapshots.length === 1)"));
    await command("home"); await until(home); await until(() => size().width === 440);
    assert.deepEqual(size(), homeBounds);
    await until(() => evaluate("Boolean(document.querySelector('.home-target-preview img')?.naturalWidth)"));
    for (const [width, height] of [[440, 640], [360, 520]]) {
      window.setSize(width, height);
      for (const theme of ["dark", "light"]) {
        await evaluate(`document.documentElement.dataset.appearance = '${theme}'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        const layout = await evaluate(`(() => {
          const home = document.querySelector('.home-view'), button = document.querySelector('.home-primary-action').getBoundingClientRect(), help = document.querySelector('.home-connection-help > summary').getBoundingClientRect();
          return { fits: home.scrollHeight <= home.clientHeight + 1 && home.scrollWidth <= home.clientWidth + 1, primaryVisible: button.top >= 0 && button.bottom <= innerHeight, helpVisible: help.bottom <= innerHeight, viewport: [innerWidth, innerHeight] };
        })()`);
        assert(layout.fits && layout.primaryVisible && layout.helpVisible, JSON.stringify(layout));
        writeFileSync(join(output, `home-${theme}-${width}.png`), (await web.capturePage()).toPNG());
      }
    }
    window.setBounds(homeBounds);
    await command("history"); await until(() => evaluate("Boolean(document.querySelector('.home-history[open] .snapshot-history-item'))"));
    assert.deepEqual(size(), homeBounds);
    await evaluate("document.querySelector('.home-history .snapshot-history-item').click()");
    await until(() => evaluate("Boolean(document.querySelector('.inspection-active .tree-row'))"));
    await until(() => size().width === savedBounds.width); assert.deepEqual(size(), savedBounds);
    report.checks.push("saved snapshot opens from home menu; workspace restores user bounds");
    await command("home"); await until(home); await until(() => size().width === 440);
    await command("preferences"); await until(() => evaluate("Boolean(document.querySelector('.preferences-panel[open]'))"));
    await until(() => size().width === savedBounds.width);
    await evaluate("document.querySelector('.preferences-panel .entry-dialog-close').click()");
    await until(() => size().width === 440); assert.deepEqual(size(), homeBounds);
    assert.equal(await evaluate("window.electronApi.setWindowMode('invalid').then(() => false, () => true)"), true);
    report.checks.push("advanced dialog expands then restores home; invalid window mode rejected");
    assert.deepEqual(report.rendererErrors, []); report.passed = true;
  } catch (error) { report.error = String(error); }
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); clearTimeout(deadline); app.exit(report.passed ? 0 : 1);
});

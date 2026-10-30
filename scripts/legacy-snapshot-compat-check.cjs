// Run after build. Copies the supplied legacy archive into a private fixture profile.
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { constants, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readSync, statSync, writeFileSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { app, BrowserWindow } = require("electron");

const project = resolve(__dirname, "..");
const archive = process.argv.find(value => value.startsWith("--archive="))?.slice("--archive=".length);
const expectedCount = process.argv.find(value => value.startsWith("--expected-count="))?.slice("--expected-count=".length);
if (expectedCount !== undefined) assert.ok(/^\d{1,3}$/.test(expectedCount), "Invalid expected snapshot count");
const base = join(project, ".benchmarks", "legacy-snapshot-acceptance");
mkdirSync(base, { recursive: true, mode: 0o700 });
chmodSync(base, 0o700);
const profile = mkdtempSync(join(base, "profile-"));
const file = join(profile, "snapshots.json");

const syntheticSnapshot = {
  serial: "synthetic-legacy", root: null, nodeCount: 0, xmlSize: 0,
  rawXml: null, screenshotDataUrl: null, warning: null, error: null,
};
if (archive) {
  const source = resolve(archive);
  assert(statSync(source).isFile(), "Legacy archive must be a regular file");
  assert(!existsSync(file), "Fixture profile already populated");
  copyFileSync(source, file, constants.COPYFILE_FICLONE);
} else {
  const time = new Date(0).toISOString();
  const data = Array.from({ length: 2 }, () => ({
    id: randomUUID(), capturedAt: time, savedAt: time, snapshot: syntheticSnapshot,
  }));
  writeFileSync(file, JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 });
}
chmodSync(file, 0o644); // Simulate the old permission; parent remains 0700.

function digest(filename) {
  const sha = createHash("sha256"), descriptor = openSync(filename, "r");
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (let count; (count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) sha.update(buffer.subarray(0, count));
    return sha.digest("hex");
  } finally { closeSync(descriptor); }
}
const beforeSha = digest(file);
const beforeBytes = statSync(file).size;
app.setAppPath(project);
app.setPath("userData", profile);
process.argv.push("--visual-fixture");
require(join(project, "dist-electron", "main.cjs"));

const timeout = setTimeout(() => { console.error("Legacy snapshot compatibility check timed out"); app.exit(1); }, 90_000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  try {
    let window;
    for (let i = 0; i < 200; i++) {
      window = BrowserWindow.getAllWindows()[0];
      if (window && !window.isDestroyed()
        && await window.webContents.executeJavaScript("Boolean(document.querySelector('.app-shell') && window.electronApi)").catch(() => false)) break;
      await delay(50);
    }
    assert.ok(window && !window.isDestroyed(), "Production fixture window not available");
    const invoke = code => window.webContents.executeJavaScript(code);
    const loaded = await invoke("window.electronApi.loadSnapshots().then(x => ({error:x.error,count:x.snapshots.length,allHaveIds:x.snapshots.every(v=>typeof v.id==='string')}))");
    assert.equal(loaded.error, null, "Legacy history was not readable");
    assert.ok(loaded.count >= 1 && loaded.allHaveIds, "Legacy records were lost");
    if (expectedCount !== undefined) assert.equal(loaded.count, Number(expectedCount), "Legacy history was filtered");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600, "Legacy permissions were not repaired");
    assert.equal(digest(file), beforeSha, "Reading legacy history changed its contents");

    const stored = await invoke("window.electronApi.saveSnapshot({capturedAt:new Date().toISOString(),snapshot:"
      + JSON.stringify(syntheticSnapshot) + "}).then(x=>({error:x.error,count:x.snapshots.length}))");
    if (archive) {
      assert.match(stored.error || "", /容量上限/, "Oversized legacy library was overwritten");
      assert.equal(digest(file), beforeSha, "Overbudget save changed legacy data");
      assert.equal(statSync(file).size, beforeBytes);
    } else {
      assert.equal(stored.error, null);
      assert.equal(stored.count, loaded.count + 1);
    }
    const report = { passed: true, source: archive ? "private-legacy-archive-copy" : "synthetic-legacy",
      snapshotCount: loaded.count, originalBytes: beforeBytes, contentUnchangedOnRead: true,
      permissionsRepaired: process.platform !== "win32", save: archive ? "rejected-preserved" : "accepted",
      appProfile: profile, realUserProfileModified: false };
    writeFileSync(join(profile, "acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify(report));
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });

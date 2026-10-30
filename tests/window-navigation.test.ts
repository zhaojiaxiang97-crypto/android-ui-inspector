import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { isSameDesktopDocument, isTrustedDevelopmentRendererUrl } from "../electron/desktop/window-navigation";

test("desktop navigation accepts same-document reload and hash changes", () => {
  for (const current of [
    "file:///Applications/Android%20UI%20Inspector.app/Contents/Resources/app.asar/dist/index.html",
    "http://127.0.0.1:1420/",
  ]) {
    assert.equal(isSameDesktopDocument(current, current), true);
    assert.equal(isSameDesktopDocument(current, current + "#details"), true);
  }
});

test("desktop navigation denies other documents, external origins and malformed URLs", () => {
  const local = "file:///Applications/Android%20UI%20Inspector.app/Contents/Resources/app.asar/dist/index.html";
  for (const target of [
    "file:///tmp/other.html", "file:///etc/passwd", "https://example.org/",
    "http://127.0.0.1:1420/", "javascript:alert(1)", "data:text/html,hello", "not-a-url",
  ]) assert.equal(isSameDesktopDocument(local, target), false, target);
  assert.equal(isSameDesktopDocument("http://127.0.0.1:1420/", "http://127.0.0.1:1420/untrusted"), false);
  assert.equal(isSameDesktopDocument("http://127.0.0.1:1420/", "http://localhost:1420/"), false);
  assert.equal(isSameDesktopDocument("", local), false);
});

test("development renderer cannot be replaced with an external or different local site", () => {
  assert.equal(isTrustedDevelopmentRendererUrl("http://127.0.0.1:1420"), true);
  assert.equal(isTrustedDevelopmentRendererUrl("http://127.0.0.1:1420/"), true);
  for (const other of ["https://example.org/", "http://localhost:1420/",
    "http://127.0.0.1:8888/", "http://127.0.0.1:1420/other",
    "http://bad@127.0.0.1:1420/", "file:///tmp/index.html", "javascript:alert(1)"]) {
    assert.equal(isTrustedDevelopmentRendererUrl(other), false, other);
  }
});

test("the real Electron main window rejects new windows and cross-document navigation", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(main, /webContents\.setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /webContents\.on\("will-navigate", \(event, requestedUrl\) =>/);
  assert.match(main, /isSameDesktopDocument\(window\.webContents\.getURL\(\), requestedUrl\)/);
  assert.match(main, /ipcMain\.handle\("probe-adb", event => \{ requireDesktopSender\(event\)/);
  for (const operation of ["load-snapshots", "save-snapshot", "delete-snapshot", "clear-snapshots"])
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${operation}", [^\\n]*requireDesktopSender\\(event\\)`));
});

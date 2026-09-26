import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTree, makeNode } from "../benchmarks/fixtures";
import { publishMcpSnapshot, revokeMcpSnapshot } from "../electron/mcp-snapshot";
import { DebugSession } from "../electron/debug-session";
import { openLiveBridge } from "../electron/mcp-live";
import type { UiSnapshot } from "../shared/types";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1EAAAAASUVORK5CYII=";
const packageName = "com.example.cli";
function fixture(text = "打开设置"): UiSnapshot {
  const root = makeNode("0"), button = makeNode("0/0", 1), list = makeNode("0/1", 2), row = makeNode("0/1/0", 3);
  for (const node of [root, button, list, row]) { node.package = packageName; node.clickable = node.scrollable = false; }
  root.bounds = { left: 0, top: 0, right: 1080, bottom: 2400, raw: "[0,0][1080,2400]" };
  button.bounds = { left: 20, top: 100, right: 180, bottom: 160, raw: "[20,100][180,160]" };
  button.resourceId = `${packageName}:id/settings`; button.text = text; button.clickable = true;
  button.layerImageDataUrl = png; button.layerImageStatus = "captured";
  button.attributes = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`attr${index}`, String(index)]));
  list.bounds = { left: 0, top: 500, right: 1080, bottom: 2300, raw: "[0,500][1080,2300]" };
  list.resourceId = `${packageName}:id/list`; list.scrollable = true;
  row.text = "row\u001b[2J\nextra";
  row.layerImageDataUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;
  root.children = [button, list]; list.children = [row];
  const frame = { width: 1080, height: 2400, rotation: 0 as const };
  return { serial: "cli-fixture", root, nodeCount: 4, xmlSize: 0, rawXml: null, error: null, warning: null,
    screenshotDataUrl: png, inspectionSource: "debug-view", captureMode: "deep",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}

test("CLI binary: shared tree/search/attributes/images/measurement, validation, live actions and revocation", { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "android-ui-cli-"));
  const path = join(directory, "current.json"), entry = join(directory, "android-ui.cjs");
  execFileSync("bun", ["build", resolve("scripts/cli.ts"), "--outfile", entry, "--target", "node", "--format", "cjs"], { stdio: "pipe" });
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile("node", [entry, ...args], { env: { ...process.env, ANDROID_UI_INSPECTOR_MCP_SNAPSHOT: path }, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, stdout, stderr }));
  });
  const json = async (...args: string[]) => {
    const result = await run(...args);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  };
  const fails = async (...args: string[]) => {
    const result = await run(...args);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr);
    assert.equal(error.isError, true);
    return error;
  };
  let bridge: Awaited<ReturnType<typeof openLiveBridge>> | undefined;
  let session: DebugSession | undefined;
  try {
    assert.match((await run("--help")).stdout, /screenshot/);
    assert.equal((await json("--version")).name, "android-ui");
    const notReady = await run("doctor");
    assert.equal(notReady.code, 1); assert.equal(JSON.parse(notReady.stdout).ready, false);
    await fails("attach"); await fails("tree");
    await fails("tree", "--limt", "4");
    await fails("tree", "--limit", "1", "--limit", "2");
    await fails("tap", "--mode", "deep");
    await fails("find");
    await fails("snapshot", "--snapshot-file", "");

    const shared = publishMcpSnapshot(path, fixture(), "0/0");
    assert.equal((await json("doctor")).shared.ready, true);
    assert.equal((await json("snapshot", "--pretty")).snapshotId, shared.id);
    const tree = await json("tree", "--depth", "1");
    assert.deepEqual(tree.items.map((item: { id: string }) => item.id), ["0", "0/0", "0/1"]);
    assert.equal(tree.depthLimited, true);
    const subtree = await json("tree", "--node", "0/1");
    assert.equal(subtree.items[0].parentId, null); assert.equal(subtree.items[1].depth, 1);
    const text = await run("tree", "--format", "text");
    assert.equal(text.code, 0); assert.ok(text.stdout.includes("row\\u001b[2J\\u000aextra"));
    assert.ok(!text.stdout.includes("\u001b")); assert.match(text.stderr, /nextOffset=null/);
    assert.equal((await json("find", "TextView", "--by", "class")).total, 3);
    assert.equal((await json("find", "TextView", "--by", "text")).total, 0);
    assert.equal((await json("find", "", "--clickable", "true", "--resource-id", `${packageName}:id/settings`)).items[0].id, "0/0");
    assert.equal((await json("find", "", "--clickable", "false")).total, 3);
    assert.equal((await json("attributes", "--node", "0/0", "--limit", "50")).nextAttributeOffset, 50);
    assert.equal((await json("attributes", "--node", "0/0", "--attribute-offset", "50")).attributes.attr59, "59");
    assert.equal((await json("measure", "0/0", "0/1")).units, "screen px");
    for (const args of [["tree", "--depth", "-1"], ["tree", "--depth", "1.5"], ["tree", "--limit", "NaN"],
      ["tree", "--format", "xml"], ["find", "", "--visible", "yes"], ["find", "", "--by", "unknown"]]) await fails(...args);
    const out = join(directory, "layer.png");
    assert.equal((await json("screenshot", "--node", "0/0", "--out", out)).mimeType, "image/png");
    const saved = readFileSync(out);
    assert.deepEqual(saved, Buffer.from(png.split(",")[1], "base64"));
    if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);
    await fails("screenshot", "--node", "0/0", "--out", out);
    assert.deepEqual(readFileSync(out), saved);
    const missing = join(directory, "missing.png");
    await fails("screenshot", "--node", "0/1", "--out", missing);
    assert.equal(existsSync(missing), false);
    await fails("screenshot", "--out", join(directory, "wrong.svg"));
    assert.equal(existsSync(join(directory, "wrong.svg")), false);
    const svg = join(directory, "style.svg");
    await json("screenshot", "--node", "0/1/0", "--out", svg);
    assert.match(readFileSync(svg, "utf8"), /^<svg/);
    await json("screenshot", "--out", join(directory, "screen.png"));

    const large = { ...fixture(), root: createTree(1105), nodeCount: 1105 };
    publishMcpSnapshot(path, large, null);
    await fails("tree", "--snapshot", shared.id);
    const paged = await json("tree");
    assert.equal(paged.items.length, 1000); assert.equal(paged.nextOffset, 1000);
    const all = await json("tree", "--limit", "20000");
    assert.equal(all.items.length, 1105); assert.equal(all.nextOffset, null);
    assert.equal(new Set(all.items.map((item: { id: string }) => item.id)).size, 1105);
    assert.equal((await json("tree", "--offset", "1000")).items.length, 105);
    revokeMcpSnapshot(path); await fails("tree");
    writeFileSync(path, "{}"); await fails("snapshot");
    revokeMcpSnapshot(path);

    let label = "打开设置", taps = 0, scrolls = 0, backs = 0, failAfterTap = false, holdCapture = false, cancelled = false;
    let captureStarted: () => void = () => {};
    const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "abcd" };
    session = new DebugSession({ serial: "cli-fixture", packageName, snapshotPath: path, directory, onEvent: () => {},
      observe: async (_serial, _package, mode, signal) => {
        if (failAfterTap && taps > 1) throw new Error("模拟输入已发送，但截图失败");
        if (holdCapture) await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener("abort", () => { cancelled = true; reject(signal!.reason); }, { once: true });
          captureStarted();
        });
        return { snapshot: { ...fixture(label), captureMode: mode }, target };
      },
      input: async (_serial, _target, action) => {
        if (action.kind === "tap") { taps++; label = "设置"; }
        if (action.kind === "swipe") scrolls++;
        if (action.kind === "back") backs++;
      },
    });
    bridge = await openLiveBridge(path, (command, signal) => session!.request(command, signal));
    const attached = await json("attach");
    assert.equal(attached.id, session.state.id); assert.equal(attached.packageName, packageName);
    assert.equal((await json("doctor")).live.active, true);
    const auth = ["--session", attached.id];
    await fails("capture");
    await fails("capture", ...auth, "--mode", "unknown");
    const deep = await json("capture", ...auth, "--mode", "deep");
    assert.equal((await fails("tap", ...auth, "--snapshot", deep.snapshotId, "--node", "0/0")).dispatchState, "not_sent");
    const first = await json("capture", ...auth);
    await fails("tap", ...auth, "--node", "0/0");
    assert.equal(taps, 0);
    const sent = await json("tap", ...auth, "--snapshot", first.snapshotId, "--node", "0/0");
    assert.equal(taps, 1); assert.equal(sent.dispatchState, "sent"); assert.equal(sent.verified, false);
    assert.equal((await fails("tap", ...auth, "--snapshot", first.snapshotId, "--node", "0/0")).dispatchState, "not_sent");
    assert.equal(taps, 1);
    const verified = await json("wait", ...auth, "--text", "设置", "--timeout-ms", "1000");
    assert.equal(verified.verified, true);
    const moved = await json("scroll", ...auth, "--snapshot", verified.snapshotId, "--node", "0/1", "--direction", "down");
    assert.equal(moved.dispatchState, "sent"); assert.equal(scrolls, 1);
    const returned = await json("back", ...auth, "--snapshot", moved.snapshotId);
    assert.equal(returned.dispatchState, "sent"); assert.equal(backs, 1);
    const failed = await fails("wait", ...auth, "--text", "不存在", "--timeout-ms", "1000");
    assert.equal(failed.verified, false); assert.ok(failed.evidencePath);
    failAfterTap = true;
    const failedAfterInput = await fails("tap", ...auth, "--snapshot", failed.snapshotId, "--node", "0/0");
    assert.equal(failedAfterInput.dispatchState, "sent"); assert.equal(taps, 2);
    failAfterTap = false;
    if (process.platform !== "win32") {
      holdCapture = true;
      const started = new Promise<void>(resolve => { captureStarted = resolve; });
      let interrupt: () => void = () => {};
      const aborted = new Promise<{ code: number | string | null | undefined; stderr: string }>(resolve => {
        const child = execFile("node", [entry, "capture", ...auth, "--snapshot-file", path], { timeout: 10_000 },
          (error, _stdout, stderr) => resolve({ code: error?.code, stderr }));
        interrupt = () => { child.kill("SIGINT"); };
      });
      await started;
      interrupt();
      const result = await aborted;
      assert.equal(result.code, 130); assert.equal(JSON.parse(result.stderr).isError, true);
      await session.settled();
      assert.equal(cancelled, true); assert.equal(session.state.active, true);
      holdCapture = false;
    }
    assert.equal((await json("stop", ...auth)).stopped, true);
    await fails("attach"); await fails("tree"); await fails("capture", ...auth);
    const stopped = await run("doctor");
    assert.equal(stopped.code, 1); assert.equal(JSON.parse(stopped.stdout).ready, false);
  } finally {
    session?.stop();
    await session?.settled();
    bridge?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

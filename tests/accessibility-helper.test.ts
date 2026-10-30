import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readHelperToken, selectHelperHierarchy } from "../electron/capture/accessibility-helper";
import { assessCaptureGeometry } from "../shared/screen-coordinates";

const packageName = "com.example.helper", frame = { width: 100, height: 200, rotation: 0 as const };
const node = (attrs = "", children = "") => `<node package="${packageName}" class="View" bounds="[0,0][100,200]" ${attrs}>${children}</node>`;
const root = (children = "") => node('window-id="7" window-type="application" window-focused="true"', children);
const dump = (nodes = root(), overrides = {}) => ({ success: true as const, truncated: false as const, xml: `<hierarchy rotation="0">${nodes}</hierarchy>`,
  ...frame, window_count: 1, node_count: 2, ...overrides });

test("Helper preserves separate semantics and shares only the unique authorized window", () => {
  const input = node('text="" hint="Account name" error="Account is required" state-description="Paused"');
  const foreign = '<node package="com.android.systemui" text="private notification"/>';
  const tree = selectHelperHierarchy(dump(foreign + root(input), { window_count: 2, node_count: 3 }), packageName, frame);
  assert.equal(tree.nodeCount, 2);
  assert.equal(tree.root.children[0].text, null);
  assert.equal(tree.root.children[0].attributes!.hint, "Account name");
  assert.equal(tree.root.children[0].attributes!.error, "Account is required");
  assert.equal(tree.root.children[0].attributes!["state-description"], "Paused");
  assert.equal(tree.root.attributes!["inspection-source"], "accessibility-helper");
  assert.equal(tree.root.children[0].attributes!["inspection-source"], "accessibility-helper");
  assert.ok(!tree.xml.includes("private notification"));
  assert.ok(!tree.xml.includes("com.android.systemui"));
  assert.ok(!tree.xml.includes("statusBarBackground"));
  assert.equal(assessCaptureGeometry({ hierarchyRotation: 0, beforeScreenshot: frame, afterScreenshot: frame, screenshotSize: frame }).status, "checked");
});

test("Helper rejects ambiguous focus, foreign children, non-application windows and frame conflicts", () => {
  for (const malformed of [dump(root() + root(), { window_count: 2 }), dump(root().replace('window-focused="true"', 'window-focused="false"')),
    dump(root().replace('window-id="7"', 'window-id="unknown"')), dump(root().replace('window-type="application"', 'window-type="input_method"')),
    dump(root().split(packageName).join("com.other.app")), dump(root(node().replace(packageName, "com.other.app"))),
    dump(root(node().replace(`package="${packageName}"`, ""))), dump(root(), { rotation: 1 }), dump(root(), { width: 101 }),
    dump(root(), { window_count: 2 }), dump(root(), { xml: dump().xml.replace('rotation="0"', 'rotation="1"') })])
    assert.throws(() => selectHelperHierarchy(malformed, packageName, frame));
});

test("Helper rejects malformed, entity, excessive depth and excessive node XML", () => {
  for (const xml of ["", "<hierarchy><node></hierarchy>", '<!DOCTYPE hierarchy [<!ENTITY x "secret">]>' + dump().xml,
    " ".repeat(8 * 1024 * 1024 + 1), dump(root(node().repeat(5001))).xml,
    '<hierarchy rotation="0">' + '<node>'.repeat(210) + '</node>'.repeat(210) + '</hierarchy>'])
    assert.throws(() => selectHelperHierarchy(dump(root(), { xml }), packageName, frame));
});

test("Helper token configuration accepts a private file and rejects unsafe files without revealing content", () => {
  const directory = mkdtempSync(join(tmpdir(), "helper-token-")), path = join(directory, "token"), link = join(directory, "link");
  const token = "private_fixture_token_value";
  try {
    writeFileSync(path, token + "\n", { mode: 0o600 });
    assert.equal(readHelperToken(path), token);
    for (const value of [undefined, "relative-token", directory, join(directory, "missing")]) assert.throws(() => readHelperToken(value), /Helper|令牌/);
    chmodSync(path, 0o644);
    assert.throws(() => readHelperToken(path), error => error instanceof Error && !error.message.includes(token));
    chmodSync(path, 0o600);
    symlinkSync(path, link); assert.throws(() => readHelperToken(link));
    for (const content of ["short", "x".repeat(1025), "token with invalid characters"]) {
      writeFileSync(path, content); assert.throws(() => readHelperToken(path));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function observe(scenario: string) {
  return JSON.parse(execFileSync(process.execPath, [resolve("tests/fixtures/accessibility-helper-entry.ts")],
    { env: { ...process.env, HELPER_FIXTURE_CASE: scenario }, timeout: 15_000, encoding: "utf8" }));
}
test("production Helper observer uses one authenticated GET, validates frames and releases its own forward", () => {
  const result = observe("success");
  assert.equal(result.error, undefined);
  assert.equal(result.source, "accessibility-helper"); assert.equal(result.mode, "fast");
  assert.equal(result.nodeCount, 2); assert.equal(result.text, null);
  assert.equal(result.attributes.hint, "Account name"); assert.equal(result.attributes.error, "Account is required");
  assert.equal(result.attributes["state-description"], "Paused");
  assert.equal(result.image, true); assert.equal(result.hierarchyDumpMode, null);
  assert.equal(result.requests, 1); assert.equal(result.removed, true); assert.equal(result.mapping, null);
  assert.ok(!JSON.stringify(result).includes("fixture_token_for_local_test_only"));
  assert.ok(!result.commands.some((args: string[]) => args.includes("uiautomator") || args.includes("input") && args[1] !== "dumpsys"));
});
for (const scenario of ["unauthorized", "truncated", "foreign-window", "geometry-moved", "activity-moved", "bad-png", "cancel", "cancel-body"]) {
  test(`production Helper ${scenario} fails without fallback, pairing, input or an abandoned forward`, () => {
    const result = observe(scenario);
    assert.equal(typeof result.error, "string"); assert.equal(result.source, undefined);
    assert.equal(result.requests, 1); assert.equal(result.removed, true); assert.equal(result.mapping, null);
    assert.ok(!result.commands.some((args: string[]) => ["uiautomator", "install", "broadcast", "am"].some(command => args.includes(command))
      || args[0] === "shell" && args[1] === "input"));
    if (scenario === "unauthorized") assert.equal(result.code, "helper-http");
    if (scenario === "truncated") assert.equal(result.code, "helper-truncated");
    if (scenario === "activity-moved") assert.match(result.error, /窗口发生变化/);
    if (scenario === "cancel-body") {
      assert.equal(result.bodyReads, 2); assert.equal(result.bodyReadPending, true);
      assert.match(result.error, /取消|cancell|abort/i);
    }
  });
}

for (const scenario of ["cancel-cli", "cancel-mcp"]) {
  test(`production Helper ${scenario} cancels the pending HTTP request and recovers explicitly`, () => {
    const result = observe(scenario);
    assert.match(result.error, /取消|cancell|abort/i);
    if (scenario === "cancel-cli") assert.equal(result.cliExitCode, 130);
    assert.deepEqual(result.beforeRecovery, { newSnapshots: 0, snapshotExists: false, requestSignalAborted: true,
      active: true, stepStatus: "failed", httpDisconnectedBeforeResponse: true });
    assert.equal(result.recoverySource, "accessibility-helper"); assert.equal(result.recoveryNodeCount, 2);
    assert.equal(result.captures, 1); assert.equal(result.requests, 2); assert.equal(result.inputCalls, 0);
    assert.equal(result.removed, true); assert.equal(result.mapping, null);
    assert.ok(!JSON.stringify(result).includes("fixture_token_for_local_test_only"));
    assert.ok(!result.commands.some((args: string[]) => ["uiautomator", "install", "broadcast", "am"].some(command => args.includes(command))
      || args[0] === "shell" && args[1] === "input"));
  });
}

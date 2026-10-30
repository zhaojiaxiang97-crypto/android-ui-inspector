import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HelperCaptureError } from "../electron/capture/accessibility-helper";
import { readHelperObservation } from "../electron/capture/helper-observation";
import { helperFrame, helperPackage, helperToken } from "./fixtures/helper-protocol";

const source = readFileSync(new URL("../scripts/helper-templates/InspectorObservation.java", import.meta.url), "utf8");
const snapshot = source.slice(source.indexOf("private static JSONObject snapshotLocked("),
  source.indexOf("/** No guessed default dimensions"));

test("every Inspector observation clears the descendant cache before any window or tree read", () => {
  const gate = snapshot.indexOf("if (Build.VERSION.SDK_INT >= 33) {");
  const display = snapshot.indexOf("JSONObject displayBefore = display(service);");
  const windows = snapshot.indexOf("enumerate(service, before, true);");
  const hierarchy = snapshot.indexOf("before.trees.add(node(");
  const screenshot = snapshot.indexOf("takeScreenshot(service)");
  assert.ok(gate > snapshot.indexOf("try {"));
  assert.ok(gate < display && display < windows && windows < hierarchy && hierarchy < screenshot,
    "clearing after traversal would leave stale child geometry in this observation");
  assert.equal([...snapshot.matchAll(/service\.clearCache\(\)/g)].length, 1);
  assert.match(snapshot.slice(gate, display), /if \(!service\.clearCache\(\)\) throw new Capture\.DiagnosedFailure\(\)/);
  assert.match(snapshot.slice(gate, display), /before\.fail\(Capture\.Reason\.cache_clear_failed\);\s+throw new Capture\.DiagnosedFailure\(\)/);
  // A failed gate must flow to the existing failure envelope, never continue with old nodes.
  assert.match(snapshot.slice(0, gate), /put\("success", false\)\.put\("has_screenshot", false\)/);
  assert.match(snapshot.slice(0, gate), /put\("complete", false\)/);
  const failure = snapshot.slice(snapshot.indexOf("if (!(error instanceof Capture.DiagnosedFailure))"));
  assert.match(failure, /result\.put\("error",/);
  assert.doesNotMatch(failure, /put\("(?:success|has_screenshot|complete)", true\)|enumerate\(|takeScreenshot\(/);
});

test("freshness gate preserves the older API path and both descendant prefetch calls", () => {
  assert.match(snapshot, /if \(Build\.VERSION\.SDK_INT >= 33\) \{\s+try \{\s+if \(!service\.clearCache\(\)\)/);
  assert.doesNotMatch(source, /setCacheEnabled\(false\)/);
  assert.match(source, /window\.getRoot\(1 << 3\) : window\.getRoot\(\)/);
  assert.match(source, /node\.getChild\(i, CHILD_PREFETCH_FLAGS\) : node\.getChild\(i\)/);
});

test("cache-clear failure and exception envelopes cannot yield actionable host observations", async () => {
  for (const error of ["Accessibility cache could not be cleared", "private service connection exception"]) {
    let requests = 0;
    await assert.rejects(() => readHelperObservation(12345, helperToken, helperPackage, helperFrame,
      new AbortController().signal, (async () => {
        requests++;
        return Response.json({ success: false, has_screenshot: false, error, helperObservation: { complete: false } });
      }) as typeof fetch), (failure: unknown) => {
      assert.ok(failure instanceof HelperCaptureError);
      assert.equal(failure.code, "helper-capture-failed");
      assert.doesNotMatch(failure.message, /Accessibility cache|private service/);
      return true;
    });
    assert.equal(requests, 1, "cache failure must not silently retry or fall back");
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("production fixture guards reject packaged test modes before window or device setup", () => {
  const source = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("const visualFixtureMode =");
  const end = source.indexOf("type VisualFixtureState", start);
  assert.ok(start > 0 && end > start);
  const gate = new Function("process", "app", source.slice(start, end));
  for (const args of [["--visual-fixture"], ["--visual-fixture", "--visual-capture-lifecycle"], ["--visual-capture-lifecycle"]]) {
    assert.throws(() => gate({ argv: args }, { isPackaged: true }), /requires an unpackaged/);
  }
  assert.doesNotThrow(() => gate({ argv: [] }, { isPackaged: true }));
  assert.doesNotThrow(() => gate({ argv: ["--visual-fixture"] }, { isPackaged: false }));
  assert.doesNotThrow(() => gate({ argv: ["--visual-fixture", "--visual-capture-lifecycle"] }, { isPackaged: false }));
  assert.throws(() => gate({ argv: ["--visual-capture-lifecycle"] }, { isPackaged: false }), /requires an unpackaged/);
});

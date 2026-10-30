import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const scenario of ["completed", "semantic", "rejected", "cancelled", "timeout", "network", "abort-before", "window", "display", "bounds", "missing-session", "missing-source"])
  test(`Helper input dispatch preserves transport and never falls back: ${scenario}`, () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/helper-input-dispatch.mjs", import.meta.url)), scenario],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

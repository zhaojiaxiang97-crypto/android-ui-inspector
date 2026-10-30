import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("manual pairing keeps secrets on-device and requires explicit user action", () => {
  const source = readFileSync("scripts/helper-templates/InspectorPairingActivity.java", "utf8");
  assert.match(source, /WindowManager\.LayoutParams\.FLAG_SECURE/);
  assert.match(source, /TYPE_TEXT_VARIATION_PASSWORD/);
  assert.match(source, /IMPORTANT_FOR_AUTOFILL_NO/);
  assert.match(source, /setOnClickListener\(v -> \{/);
  assert.match(source, /InspectorPairingToken\.setFromUser\(/);
  assert.match(source, /InspectorPairingToken\.clearFromUser\(/);
  assert.match(source, /\.setPositiveButton\("清除"/);
  assert.doesNotMatch(source, /getIntent\(|startService\(|sendBroadcast\(|SharedPreferences|Log\./);
});

test("manual token validation preserves current pairing on invalid input and explicitly revokes", { timeout: 20000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "inspector-pairing-"));
  const stub = join(base, "TokenStore.java");
  const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  try {
    writeFileSync(stub, `package com.artemis.helper;
final class TokenStore {
    private static String value;
    static void set(String next) { value = next; }
    static boolean isSet() { return value != null; }
    static boolean matches(String candidate) { return value != null && value.equals(candidate); }
}
`);
    const compile = spawnSync(java("javac"), ["--release", "8", "-d", base, stub,
      resolve("scripts/helper-templates/InspectorPairingToken.java"),
      resolve("tests/fixtures/InspectorPairingTokenCheck.java")], { encoding: "utf8", timeout: 12000 });
    assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
    const result = spawnSync(java("java"), ["-cp", base, "com.artemis.helper.InspectorPairingTokenCheck"],
      { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /manual pairing validation and revocation passed/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

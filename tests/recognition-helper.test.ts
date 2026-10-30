import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { helperPackage, patchRecognitionHelper, verifyHelperSource } from "../scripts/prepare-recognition-helper";

test("helper source verification rejects tampering and unknown paths", () => {
  const bytes = Buffer.from('plugins {\n    id("com.android.application") version "8.5.0" apply false\n}\n');
  // Use a tiny real upstream blob, rather than accepting whatever the patch happens to expect.
  verifyHelperSource("build.gradle.kts", bytes);
  assert.throws(() => verifyHelperSource("build.gradle.kts", Buffer.concat([bytes, Buffer.from(" ")])));
  assert.throws(() => verifyHelperSource("../other.java", bytes));
});

test("layout flags are enabled at startup and service binding without changing other capabilities", () => {
  const path = "app/src/main/java/com/artemis/helper/ArtemisAccessibilityService.java";
  const code = '// Not-important views are what UIAutomator\'s compressed dump leaves out;\n            // keep them out here too so both backends describe the same tree.\ninfo.flags &= ~AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;\nsetServiceInfo(info);';
  assert.match(patchRecognitionHelper(path, code), /info.flags \|= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS/);
  assert.throws(() => patchRecognitionHelper(path, code + code));
  const flags = 'accessibilityFlags="flagDefault|flagRetrieveInteractiveWindows|flagReportViewIds" canPerformGestures="true"';
  assert.equal(patchRecognitionHelper("app/src/main/res/xml/accessibility_service_config.xml", flags),
    'accessibilityFlags="flagDefault|flagRetrieveInteractiveWindows|flagReportViewIds|flagIncludeNotImportantViews" canPerformGestures="true"');
});

test("isolated package preserves protected token receiver and explicit upstream service classes", () => {
  const manifest = '<manifest\n    package="com.artemis.helper">\n    <uses-sdk\n        android:minSdkVersion="24"\n        android:targetSdkVersion="35" />\n\n<service android:name=".ArtemisAccessibilityService" android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"/><receiver android:name=".TokenReceiver" android:permission="android.permission.WRITE_SECURE_SETTINGS"/></manifest>';
  const patched = patchRecognitionHelper("app/src/main/AndroidManifest.xml", manifest);
  assert.match(patched, /android:name="com.artemis.helper.ArtemisAccessibilityService"/);
  assert.match(patched, /android:name="com.artemis.helper.TokenReceiver"/);
  assert.match(patched, /WRITE_SECURE_SETTINGS/);
  assert.match(patched, /BIND_ACCESSIBILITY_SERVICE/);
  assert.doesNotMatch(patched, /package=/);
  assert.doesNotMatch(patched, /uses-sdk/);
  const build = 'namespace = "com.artemis.helper"\napplicationId = "com.artemis.helper"\ncompileSdk = 35\nversionName = "1.2.0"\nminSdk = 24\ntargetSdk = 35';
  const output = patchRecognitionHelper("app/build.gradle.kts", build);
  assert.ok(output.includes(`applicationId = "${helperPackage}"`));
  assert.match(output, /namespace = "com.artemis.helper"/);
  assert.match(output, /minSdk = 24\ntargetSdk = 35/);
  assert.equal(patchRecognitionHelper("app/src/main/java/com/artemis/helper/TokenReceiver.java", "untouched"), "untouched");
});

test("recognition sample has stable nested layouts and no SDK dependency or network permission", () => {
  const file = (path: string) => readFileSync(new URL(`../android/recognition-sample/${path}`, import.meta.url), "utf8");
  assert.doesNotMatch(file("build.gradle.kts"), /dependencies|inspector-sdk|hiddenapibypass/);
  assert.doesNotMatch(file("src/main/AndroidManifest.xml"), /uses-permission|provider|service/);
  const layout = file("src/main/res/layout/activity_main.xml");
  for (const id of ["layout_stage", "nested_layout", "account_input", "capture_state", "sample_action"])
    assert.ok(layout.includes(`@+id/${id}`));
});

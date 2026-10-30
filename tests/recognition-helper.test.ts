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

test("Inspector routes are inserted after authentication without modifying upstream routes", () => {
  const before = '            if (!authed) {\n                sendJson(output, 401, unauthorizedJson().toString());\n                return;\n            }\n\n';
  const after = '            // Route endpoints\n            if (path.equals("/snapshot")) {\n                unchangedSnapshot();\n            } else if (path.equals("/action")) { unchangedAction(); }';
  const path = "app/src/main/java/com/artemis/helper/CommandServer.java";
  const patched = patchRecognitionHelper(path, before + after);
  assert.ok(patched.startsWith(before));
  assert.ok(patched.endsWith(after));
  assert.ok(patched.indexOf('if (!authed)') < patched.indexOf('path.equals("/inspector/capabilities")'));
  assert.ok(patched.indexOf('if (!"GET".equals(parts[0]))') < patched.indexOf('InspectorObservation.snapshot(service)'));
  assert.match(patched, /sendJson\(output, 405,/);
  assert.throws(() => patchRecognitionHelper(path, "unknown upstream version"), /补丁目标缺失或重复/);
  assert.throws(() => patchRecognitionHelper(path, before + after + after), /补丁目标缺失或重复/);
});

test("Inspector protocol template never provides input or pairing operations", () => {
  const source = readFileSync(new URL("../scripts/helper-templates/InspectorObservation.java", import.meta.url), "utf8");
  assert.doesNotMatch(source, /dispatchGesture|performAction|performGlobalAction|TokenStore|GestureController|ProcessBuilder|Runtime\.getRuntime/);
  const publicEntrypoints = [...source.matchAll(/public static (?:synchronized )?JSONObject (\w+)\(/g)].map(match => match[1]);
  assert.deepEqual(publicEntrypoints, ["capabilities", "snapshot"]);
});

test("Inspector XML roots carry the window identity required by the desktop selector", () => {
  const source = readFileSync(new URL("../scripts/helper-templates/InspectorObservation.java", import.meta.url), "utf8");
  // This boundary used to omit window-type/focused, making every otherwise valid observation fail selection.
  const windowFields = source.match(/if \(windowMetadata != null\) \{([\s\S]*?)\n            \}/)?.[1] ?? "";
  for (const [attribute, field] of [["window-type", "type"], ["window-layer", "layer"],
    ["window-active", "active"], ["window-focused", "focused"]]) {
    assert.ok(windowFields.includes(`"${attribute}", windowMetadata.get`), `missing root attribute: ${attribute}`);
    assert.ok(windowFields.includes(`("${field}")`), `unbound inventory field: ${field}`);
  }
  assert.match(source, /node\(root, 0, i, window\.getString\("id"\), window,/);
});

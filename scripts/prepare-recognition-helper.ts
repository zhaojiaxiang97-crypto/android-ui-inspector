// Prepare an isolated evaluation fork; upstream sources and Apache-2.0 license stay in the ignored output.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const helperCommit = "351ca8422f7b5b54e80a9c1ce03a222e02415b6b";
export const helperPackage = "com.androiduiinspector.a11yhelper";
const prefix = "packages/artemis-accessibility-helper/";
const java = "app/src/main/java/com/artemis/helper/";
const sources: Record<string, string> = {
  LICENSE: "ba262877bba9344e5e5b8ff5828ba2e7e2c8d963",
  "app/build.gradle.kts": "ad802d617bf693a74345ffd4b97b5f1198dc82b4",
  "app/src/main/AndroidManifest.xml": "94b1a1c58d868c0608fb993d09e13ac48a27bdb1",
  [java + "A11yNode.java"]: "676728ab3e078d36022414f7bd0ffe0d48636c37",
  [java + "ArtemisAccessibilityService.java"]: "895a59d8889b7ba5280ce62837464fe9f5a74418",
  [java + "CommandServer.java"]: "328f7174e1e535e623b524c367aa6d330a8200ee",
  [java + "DisplayUtils.java"]: "9c6731d18c6eb5a51e804ad783611339d8d58127",
  [java + "GestureController.java"]: "1714a634f2fd6c4a939fda74abcad6e7a75565a4",
  [java + "HierarchyDumper.java"]: "ee1084bddb6b394cb0e0630c4de345dc7d747464",
  [java + "TokenReceiver.java"]: "7e7090490ab6bec696a6715d68f2a851769d70f3",
  [java + "TokenStore.java"]: "2062fc1fbdb4feaa988712b47dd090ccd290c5aa",
  [java + "XmlUtils.java"]: "40422544689ac6a4f117f4f54266b1735364d274",
  "app/src/main/res/values/strings.xml": "0d5195ac96f747201994c673c648d120adefb628",
  "app/src/main/res/xml/accessibility_service_config.xml": "ee07cb5d4515a5b1ebd9117b936f50adf940f0a0",
  "build.gradle.kts": "c153e67997dac7a7b13d0427606124a454269b1a",
  "settings.gradle.kts": "a68441d7442d3196c499aae2424c85b84065aac9",
  "gradle.properties": "3c5e11311bd5f328c2ef0eef1cf06eda2eaf7eae",
};

export function verifyHelperSource(path: string, bytes: Uint8Array) {
  const digest = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (!sources[path] || digest !== sources[path]) throw new Error(`固定版本源码摘要不符：${path}`);
}

function replaceOnce(source: string, from: string, to: string) {
  if (source.split(from).length !== 2) throw new Error(`补丁目标缺失或重复：${from}`);
  return source.replace(from, to);
}

export function patchRecognitionHelper(path: string, source: string) {
  if (path === java + "ArtemisAccessibilityService.java") {
    source = replaceOnce(source, "info.flags &= ~AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;",
      "info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;");
    source = replaceOnce(source,
      "// Not-important views are what UIAutomator's compressed dump leaves out;\n            // keep them out here too so both backends describe the same tree.",
      "// Inspector evaluation: retain layout containers as in the existing uncompressed fast tree.");
  } else if (path === "app/src/main/res/xml/accessibility_service_config.xml") {
    source = replaceOnce(source, "flagDefault|flagRetrieveInteractiveWindows|flagReportViewIds",
      "flagDefault|flagRetrieveInteractiveWindows|flagReportViewIds|flagIncludeNotImportantViews");
  } else if (path === "app/build.gradle.kts") {
    source = replaceOnce(source, 'applicationId = "com.artemis.helper"', `applicationId = "${helperPackage}"`);
    source = replaceOnce(source, "compileSdk = 35", "compileSdk = 36");
    source = replaceOnce(source, 'versionName = "1.2.0"', 'versionName = "1.2.0-inspector-layout"');
  } else if (path === "app/src/main/AndroidManifest.xml") {
    source = replaceOnce(source, '\n    package="com.artemis.helper"', "");
    source = replaceOnce(source, '    <uses-sdk\n        android:minSdkVersion="24"\n        android:targetSdkVersion="35" />\n\n', "");
    for (const name of ["ArtemisAccessibilityService", "TokenReceiver"])
      source = replaceOnce(source, `android:name=".${name}"`, `android:name="com.artemis.helper.${name}"`);
  } else if (path === "app/src/main/res/values/strings.xml") {
    source = replaceOnce(source, "Artemis Accessibility Helper", "Inspector Layout Helper");
  }
  return source;
}

async function main() {
  if (process.argv.length !== 2) throw new Error("用法：bun scripts/prepare-recognition-helper.ts；仅准备源码，不安装或操作手机");
  const base = join(process.cwd(), ".benchmarks", "recognition-helper");
  mkdirSync(base, { recursive: true });
  const output = mkdtempSync(join(base, "source-"));
  const manifest: Array<{ path: string; sourceBlob: string; patchedSha256: string; changed: boolean }> = [];
  // Fetch only pinned source files. Never download upstream installers, APKs or signing keys.
  const replies = await Promise.allSettled(Object.entries(sources).map(async ([path, blob]) => {
    const upstream = path === "LICENSE" ? path : prefix + path;
    const response = await fetch(`https://raw.githubusercontent.com/google/artemis/${helperCommit}/${upstream}`, {
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`源码下载失败：${path} HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    verifyHelperSource(path, bytes);
    const original = Buffer.from(bytes).toString("utf8");
    const patched = path === "build.gradle.kts" ? readFileSync(join(process.cwd(), "android", path), "utf8")
      : patchRecognitionHelper(path, original);
    const target = join(output, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, patched, { mode: 0o600 });
    manifest.push({ path, sourceBlob: blob, patchedSha256: createHash("sha256").update(patched).digest("hex"), changed: original !== patched });
  }));
  const failures = replies.filter((reply): reply is PromiseRejectedResult => reply.status === "rejected").map(reply => String(reply.reason));
  writeFileSync(join(output, "source-manifest.json"), JSON.stringify({ helperCommit, helperPackage,
    patches: ["include layout nodes in static and runtime flags", "isolated application ID and label", "compile SDK 36 and repository Gradle plugin; SDK versions remain in Gradle"],
    files: manifest.sort((a, b) => a.path.localeCompare(b.path)), failures }, null, 2) + "\n", { mode: 0o600 });
  if (failures.length) throw new Error(`准备失败，保留现场 ${output}：${failures.join("; ")}`);
  console.log(JSON.stringify({ output, helperPackage, helperCommit, build: "gradle -p <output> :app:assembleDebug --console=plain" }));
}

if (import.meta.main) await main();

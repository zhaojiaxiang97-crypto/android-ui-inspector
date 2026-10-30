import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const base = "android/sdk-free-sample/src/debug";
test("fixed traversal model has exact bounded real/provider shapes, stable identity and honest wide counts", { timeout: 20_000 }, context => {
  const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  const compiler = spawnSync(java("javac"), ["-version"], { encoding: "utf8", timeout: 5000 });
  if (!process.env.JAVA_HOME && ((compiler.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    || /Unable to locate a Java Runtime|No Java runtime present/i.test(compiler.stderr ?? ""))) {
    context.skip("JDK unavailable; install a JDK to execute the fixed traversal model checks."); return;
  }
  assert.equal(compiler.status, 0, compiler.stderr || compiler.error?.message);
  const directory = mkdtempSync(join(tmpdir(), "traversal-fixture-"));
  try {
    const check = join(directory, "TraversalFixtureCheck.java");
    writeFileSync(check, `package com.androiduiinspector.sdkfree;
import java.util.*;
public class TraversalFixtureCheck {
  static void check(boolean ok) { if(!ok)throw new AssertionError("fixed tree contract"); }
  static String walk(TraversalFixtureTree.Node node,Set<Integer> seen) {
    check(seen.add(node.id));StringBuilder result=new StringBuilder(TraversalFixtureTree.name(node.id));
    for(TraversalFixtureTree.Node child:node.children){check(child.parent==node);result.append("[").append(walk(child,seen)).append("]");}return result.toString();
  }
  public static void main(String[] args) {
    String[] shapes={"deep300","deep530","real-wide80","virtual80","virtual300","virtual750"};int[] counts={300,530,81,81,300,750},depths={23,29,1,1,23,29};
    for(int i=0;i<shapes.length;i++){
      TraversalFixtureTree tree=TraversalFixtureTree.create(shapes[i]);Set<Integer> seen=new HashSet<>();String first=walk(tree.root(),seen);
      check(tree.nodes.size()==counts[i]&&seen.size()==counts[i]&&tree.maxDepth()==depths[i]);
      check(tree.virtual==shapes[i].startsWith("virtual"));check(tree.maxChildren()==(depths[i]==1?80:15));
      check(first.equals(walk(TraversalFixtureTree.create(shapes[i]).root(),new HashSet<Integer>())));
      for(int id=1;id<=counts[i];id++)check(tree.find(id).id==id);
      check(tree.find(0)==null&&tree.find(counts[i]+1)==null);check(tree.root().parent==null);
    }
    try{TraversalFixtureTree.create("unbounded");throw new AssertionError("unknown shape accepted");}catch(IllegalArgumentException expected){}
    System.out.println("6 fixed shapes, exact counts/depth, stable IDs, parent links and missing nodes checked");
  }
}`);
    const compiled = spawnSync(java("javac"), ["--release", "8", "-d", directory,
      resolve(base, "java/com/androiduiinspector/sdkfree/TraversalFixtureTree.java"), check], { encoding: "utf8", timeout: 10_000 });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
    const result = spawnSync(java("java"), ["-cp", directory, "com.androiduiinspector.sdkfree.TraversalFixtureCheck"], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /6 fixed shapes/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("traversal Activity is debug-only, counts stay outside UI, and provider has full deterministic node identities", () => {
  const activity = readFileSync(resolve(base, "java/com/androiduiinspector/sdkfree/TraversalDiagnosticsActivity.java"), "utf8");
  const manifest = readFileSync(resolve(base, "AndroidManifest.xml"), "utf8");
  assert.match(manifest, /TraversalDiagnosticsActivity[^>]+android:exported="true"[^>]+android:launchMode="singleTop"/);
  assert.doesNotMatch(readFileSync(resolve("android/sdk-free-sample/src/main/AndroidManifest.xml"), "utf8"), /TraversalDiagnostics/);
  assert.match(activity, /ACTION_DUMP_COUNTS.equals[\s\S]*?dumpCounts\("requested"\); return;/);
  assert.match(activity, /extends AccessibilityNodeProvider/); assert.match(activity, /virtualId >= 2 \? tree.find/);
  assert.match(activity, /info.setSource\(VirtualHost.this, node.id\)/); assert.match(activity, /info.setBoundsInScreen\(screen\)/);
  assert.match(activity, /info.addChild\(VirtualHost.this, child.id\)/); assert.match(activity, /setViewIdResourceName/);
  assert.match(activity, /node\.id > 530 \? getPackageName\(\) \+ ":id\/" \+ TraversalFixtureTree\.name\(node\.id\)/);
  assert.match(activity, /getBooleanExtra\("probeTarget", false\)\) shapeLabel\.setClickable\(true\)/);
  assert.match(activity, /getBooleanExtra\("profileProvider", false\)/);
  assert.match(activity, /getBooleanExtra\("traceProvider", false\)/);
  assert.match(activity, /getBooleanExtra\("auditProviderIds", false\)/);
  assert.match(activity, /ACTION_RESET_PROVIDER_AUDIT.equals[\s\S]*?resetAuditCounts\(\); dumpCounts\("reset"\); return;/);
  assert.match(activity, /AccessibilityNodeInfo info = profiledNodeInfo\(virtualId\);[\s\S]*?if \(info != null && auditVirtualIdCounts != null/);
  assert.match(activity, /virtualId >= 2 && virtualId < auditVirtualIdCounts.length/);
  assert.match(activity, /if \(calls == 1\) uniqueVirtualIds\+\+/);
  assert.match(activity, /if \(calls == 2\) duplicatedVirtualIds\+\+/);
  assert.match(activity, /Arrays.fill\(auditVirtualIdCounts, 0\)/);
  assert.match(activity, /auditProviderIds=[\s\S]*?uniqueVirtualIds=[\s\S]*?duplicateVirtualCreates=[\s\S]*?duplicatedVirtualIds=[\s\S]*?maxCreatesPerId=/);
  assert.match(activity, /if \(traceProvider\) Trace\.beginSection\("InspectorProviderNode"\)/);
  assert.match(activity, /finally \{\s*if \(traceProvider\) Trace\.endSection\(\)/);
  assert.match(activity, /SystemClock\.elapsedRealtimeNanos\(\)/);
  assert.match(activity, /Debug\.threadCpuTimeNanos\(\)/);
  assert.match(activity, /if \(!profileProvider\) return nodeInfo\(virtualId\)/);
  assert.match(activity, /try \{ return nodeInfo\(virtualId\); \}\s*finally \{/);
  assert.match(activity, /providerWallNs=.*providerCpuNs=/);
  assert.match(activity, /performAction\(int virtualId, int action, Bundle arguments\) \{ return false;/);
  assert.doesNotMatch(activity, /postDelayed|ValueAnimator|setOnClickListener|sendAccessibilityEvent|setInterval/);
  const label = activity.match(/private String nodeText[^\n]+/)![0]; assert.doesNotMatch(label, /Creates|SystemClock|currentTime/);
  const resources = readFileSync(resolve(base, "res/values/traversal_diagnostics_ids.xml"), "utf8");
  const ids = [...resources.matchAll(/name="(traversal_node_\d{4})"/g)].map(match => match[1]);
  assert.equal(ids.length, 530); assert.equal(new Set(ids).size, 530);
  for (let i = 1; i <= 530; i++) assert.ok(ids.includes(`traversal_node_${String(i).padStart(4, "0")}`));
});

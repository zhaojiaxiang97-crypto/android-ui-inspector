import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("production merged SDK prefix stops UI failure before layer selection, preserving non-UI compatibility", () => {
  const source = readFileSync(join(import.meta.dirname, "../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/HierarchyCapture.java"), "utf8");
  const start = source.indexOf("    Bundle captureVisible(");
  const end = source.indexOf('        File file = new File(app.getNoBackupFilesDir(), "inspector-visible-layers.bin");', start);
  assert(start > 0 && end > start);
  const directory = mkdtempSync(join(tmpdir(), "sdk-merged-failure-"));
  try {
    mkdirSync(join(directory, "android/util"), { recursive: true });
    writeFileSync(join(directory, "android/util/Log.java"), "package android.util; public class Log { public static int d(String a,String b){return 0;} }");
    writeFileSync(join(directory, "MergedFailureCheck.java"), `
import java.util.*;
public class MergedFailureCheck {
  static class Bundle {
    Map<String,String> values=new HashMap<>(); boolean withTree=true;
    void putString(String k,String v){values.put(k,v);}
    String getString(String k){return values.get(k);}
    boolean getBoolean(String k,boolean d){return k.equals("withTree")?withTree:d;}
  }
  static class Application {}
  static class JSONObject {}
  static class GeometryRecords {}
  static class VisibleTreeGuard { VisibleTreeGuard(JSONObject j){} }
  static class Process { static int myPid(){return 42;} }
  static class SystemClock { static long elapsedRealtime(){return 10;} }
  String processInstance="current"; Exception failure; int trees, selection, notifications;
  interface Sink {void write(String nonce);}
  Sink notifyTreeReady=nonce -> notifications++;
  JSONObject writeTreeFile(Application app,String file) throws Exception { trees++; if(failure!=null)throw failure; return new JSONObject(); }
${source.slice(start, end)}
    selection++; return answer;
  }
  static void check(boolean b,String message){if(!b)throw new AssertionError(message);}
  public static void main(String[] args) {
    String nonce="1234567890abcdef";
    Exception[] failures={new IllegalStateException("View tree timed out"),new IllegalStateException("Main queue unavailable"),new InterruptedException("cancel")};
    String[] reasons={"ui-timeout","ui-unavailable","interrupted"};
    for(int i=0;i<failures.length;i++) {
      MergedFailureCheck p=new MergedFailureCheck();p.failure=failures[i];
      Bundle r=p.captureVisible(new Application(),nonce,new Bundle());
      check(p.trees==1&&p.selection==0,"no selection after UI failure");
      check(p.notifications==0,"no notification before a published tree");
      check("failed".equals(r.getString("tree"))&&reasons[i].equals(r.getString("treeFailure")),"typed failure");
      check(nonce.equals(r.getString("nonce"))&&"current".equals(r.getString("processInstance")),"request identity");
    }
    MergedFailureCheck normal=new MergedFailureCheck();
    check("ok".equals(normal.captureVisible(new Application(),nonce,new Bundle()).getString("tree"))&&normal.selection==1,"normal success");
    check(normal.notifications==1,"published tree notifies before layer selection");
    MergedFailureCheck other=new MergedFailureCheck();other.failure=new IllegalStateException("No resumed Activity");
    Bundle r=other.captureVisible(new Application(),nonce,new Bundle());
    check("failed".equals(r.getString("tree"))&&r.getString("treeFailure")==null&&other.selection==1,"non-UI compatibility");
    MergedFailureCheck plain=new MergedFailureCheck();Bundle extra=new Bundle();extra.withTree=false;
    plain.captureVisible(new Application(),nonce,extra);check(plain.trees==0&&plain.selection==1,"plain capture unchanged");
    System.out.println("6 merged tree failure checks passed");
  }
}`);
    const compiled = spawnSync("javac", ["--release", "8", "-d", directory, join(directory, "android/util/Log.java"), join(directory, "MergedFailureCheck.java")], { encoding: "utf8", timeout: 20000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync("java", ["-cp", directory, "MergedFailureCheck"], { encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /6 merged tree failure checks passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

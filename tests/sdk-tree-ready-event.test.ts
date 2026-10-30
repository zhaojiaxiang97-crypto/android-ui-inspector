import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("SDK actual notification and socket dispatch are opt-in, request scoped and failure-safe", () => {
  const source = readFileSync(new URL("../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/HierarchyProvider.java", import.meta.url), "utf8");
  const start = source.indexOf("    private void notifyTreeReady(");
  const end = source.indexOf("    @Override public void onActivityResumed", start);
  const dispatchStart = source.indexOf("    Bundle dispatchSession(");
  const dispatchEnd = start;
  assert.ok(start > 0 && end > start && dispatchStart > 0 && dispatchEnd > dispatchStart);
  const directory = mkdtempSync(join(tmpdir(), "sdk-tree-ready-"));
  try {
    mkdirSync(join(directory, "org/json"), { recursive: true });
    writeFileSync(join(directory, "org/json/JSONObject.java"), `package org.json;
public class JSONObject { private final java.util.Map<String,Object> values=new java.util.LinkedHashMap<>();
 public JSONObject put(String k,Object v){values.put(k,v);return this;}
 public String toString(){return values.toString();} }`);
    writeFileSync(join(directory, "NotifyCheck.java"), `import java.io.*; import java.nio.charset.StandardCharsets; import org.json.JSONObject;
public class NotifyCheck {
 final ThreadLocal<OutputStream> treeReadyOutput=new ThreadLocal<>(); String processInstance="instance"; boolean fail;
 static class Process {static int myPid(){return 42;}}
 static class Log {static void w(String tag,String message){}}
 static class Bundle {boolean enabled; boolean getBoolean(String k,boolean d){return enabled;} void putString(String k,String v){} }
 static boolean isDataMethod(String method){return method.equals("capture-visible")||method.equals("capture");}
 static boolean isDiagnosticMethod(String method){return false;}
 Bundle readDiagnostic(String method,String arg,Bundle extra,int uid){throw new AssertionError("not a scalar fixture");}
 Bundle dispatch(String method,String arg,Bundle extra){if(fail)throw new IllegalStateException("dispatch failure");notifyTreeReady(arg);return new Bundle();}
 ${source.slice(start, end)}
 ${source.slice(dispatchStart, dispatchEnd)}
 Bundle socketDispatch(String method,Bundle extras,OutputStream output){return dispatchSession(method,"0123456789abcdef",extras,2000,output);}
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception {
  NotifyCheck p=new NotifyCheck();ByteArrayOutputStream output=new ByteArrayOutputStream();Bundle extra=new Bundle();
  p.socketDispatch("capture-visible",extra,output);check(output.size()==0,"old client receives no event");
  extra.enabled=true;p.socketDispatch("capture",extra,output);check(output.size()==0,"other method receives no event");
  p.socketDispatch("capture-visible",extra,output);String event=output.toString("UTF-8");
  check(event.startsWith("Event: ")&&event.endsWith("\\n")&&event.contains("nonce=0123456789abcdef")&&event.contains("pid=42"),"event binds request and process");
  check(p.treeReadyOutput.get()==null,"dispatch removes output");
  int length=output.size();p.notifyTreeReady("later");check(output.size()==length,"no leaked writer after request");
  p.socketDispatch("capture-visible",extra,new OutputStream(){public void write(int b)throws IOException{throw new IOException("closed");}});
  check(p.treeReadyOutput.get()==null,"optional notification failure cleans output");
  p.fail=true;try{p.socketDispatch("capture-visible",extra,output);throw new AssertionError("failure swallowed");}catch(IllegalStateException expected){}
  check(p.treeReadyOutput.get()==null,"dispatch exception cleans output");
  System.out.println("notification checks passed");
 }
}`);
    const built = spawnSync("javac", ["--release", "8", "-d", directory, join(directory, "org/json/JSONObject.java"), join(directory, "NotifyCheck.java")], { encoding: "utf8", timeout: 20000 });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync("java", ["-cp", directory, "NotifyCheck"], { encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /notification checks passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("actual SDK request decoding retains nullable args, boolean extras, legacy conversion and rejects decoder errors", () => {
  const source = readFileSync(new URL("../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/HierarchySession.java", import.meta.url), "utf8");
  const start = source.indexOf("    static final class Request {");
  assert.ok(start > 0);
  const directory = mkdtempSync(join(tmpdir(), "sdk-request-"));
  try {
    mkdirSync(join(directory, "org/json"), { recursive: true });
    writeFileSync(join(directory, "org/json/JSONException.java"), "package org.json; public class JSONException extends Exception { public JSONException(String s){super(s);} }");
    // Deterministic JSONObject/Bundle substitutes exercise production conversion, not Android JSON parsing.
    writeFileSync(join(directory, "org/json/JSONObject.java"), `package org.json; import java.util.*;
public class JSONObject {
 public static final Map<String,JSONObject> fixtures=new HashMap<>(); public final Map<String,Object> values=new LinkedHashMap<>();
 public JSONObject(){} public JSONObject(String line)throws JSONException{if(!fixtures.containsKey(line))throw new JSONException("bad JSON");values.putAll(fixtures.get(line).values);}
 public String getString(String key)throws JSONException{Object v=values.get(key);if(!(v instanceof String))throw new JSONException("bad method");return (String)v;}
 public boolean isNull(String key){return values.get(key)==null;}
 public String optString(String key,String fallback){Object v=values.get(key);return v==null?fallback:String.valueOf(v);}
 public JSONObject optJSONObject(String key){Object v=values.get(key);return v instanceof JSONObject?(JSONObject)v:null;}
 public Iterator<String> keys(){return values.keySet().iterator();} public Object get(String key){return values.get(key);}
}`);
    writeFileSync(join(directory, "RequestCheck.java"), `import java.util.*; import org.json.*;
public class RequestCheck {
 static class Bundle {final Map<String,Object> values=new LinkedHashMap<>();void putString(String k,String v){values.put(k,v);}void putBoolean(String k,boolean v){values.put(k,v);}}
${source.slice(start, source.lastIndexOf("}"))}
 static void check(boolean b){if(!b)throw new AssertionError();}
 static void rejects(String token)throws Exception{try{Request.read(token);throw new AssertionError("bad request accepted");}catch(JSONException expected){}}
 public static void main(String[] args)throws Exception {
  JSONObject old=new JSONObject();old.values.put("method","capture");JSONObject.fixtures.put("legacy",old);
  Request legacy=Request.read("legacy");check(legacy.method.equals("capture")&&legacy.arg==null&&legacy.extras.values.isEmpty());
  JSONObject extras=new JSONObject();extras.values.put("withTree",true);extras.values.put("treeReadyEvents",false);
  extras.values.put("pid",42);extras.values.put("processInstance","instance");extras.values.put("missing",null);
  JSONObject data=new JSONObject();data.values.put("method","capture-visible");data.values.put("arg","0123456789abcdef");data.values.put("extras",extras);
  JSONObject.fixtures.put("new",data);Request parsed=Request.read("new");
  check(parsed.method.equals("capture-visible")&&parsed.arg.equals("0123456789abcdef"));
  check(parsed.extras.values.get("withTree").equals(true)&&parsed.extras.values.get("treeReadyEvents").equals(false));
  check(parsed.extras.values.get("pid").equals("42")&&parsed.extras.values.get("processInstance").equals("instance")&&parsed.extras.values.get("missing").equals("null"));
  data.values.put("arg",null);check(Request.read("new").arg==null);
  data.values.put("arg","");check(Request.read("new").arg.equals(""));
  data.values.put("extras","not-an-object");check(Request.read("new").extras.values.isEmpty());
  rejects("bad-json");data.values.remove("method");rejects("new");data.values.put("method",true);rejects("new");
  check(legacy.extras.values.isEmpty());System.out.println("request conversion checks passed");
 }
}`);
    const compile = spawnSync("javac", ["--release", "8", "-d", directory, join(directory, "org/json/JSONException.java"), join(directory, "org/json/JSONObject.java"), join(directory, "RequestCheck.java")], { encoding: "utf8", timeout: 20000 });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync("java", ["-cp", directory, "RequestCheck"], { encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /request conversion checks passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

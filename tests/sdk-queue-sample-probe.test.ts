import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { finishSampleHold, isQueueSampleComponent, parseSampleHoldReply, validateQueueSampleArgs } from "../scripts/diagnostics/sdk/sdk-queue-sample-probe";

const requestId = "11111111-1111-1111-1111-111111111111", expected = { requestId, pid: 42 };
const state = { ...expected, postedMs: 100, enteredMs: 101, endedMs: -1, observedMs: 102, limitMs: 1800 };
test("sample hold reply is bounded, identity-bound and accepts either Android Bundle order", () => {
  for (const fields of [`result=ok, state=${JSON.stringify(state)}`, `state=${JSON.stringify(state)}, result=ok`])
    assert.deepEqual(parseSampleHoldReply(`Result: Bundle[{${fields}}]`, expected), state);
  for (const patch of [{ pid: 99 }, { requestId: "bad" }, { limitMs: 10000 }, { observedMs: 99 },
    { endedMs: 100 }, { enteredMs: -2 }, { postedMs: NaN }, { unknown: true }])
    assert.throws(() => parseSampleHoldReply(`Result: Bundle[{result=ok, state=${JSON.stringify({ ...state, ...patch })}}]`, expected));
  for (const reply of ["Result: Bundle[{error=denied}]", "Result: Bundle[{result=ok}]", "x".repeat(2049)])
    assert.throws(() => parseSampleHoldReply(reply, expected));
});

test("sample device probe requires an explicit --run and never accepts a business target or install flags", () => {
  assert.equal(validateQueueSampleArgs(["fixture", "--run"]), "fixture");
  for (const args of [[], ["fixture"], ["fixture", "--install"], ["fixture", "--run", "com.smile.gifmaker"], ["bad;", "--run"]])
    assert.throws(() => validateQueueSampleArgs(args));
  const source = readFileSync(new URL("../scripts/diagnostics/sdk/sdk-queue-sample-probe.ts", import.meta.url), "utf8");
  assert.match(source, /if \(import\.meta\.main\)/);
  assert.doesNotMatch(source, /"force-stop"|"install"|"clear"|"-S"/);
  assert.equal(source.match(/device\.captureOnce\(/g)?.length, 1);
  assert.match(source, /waitForSessionProbeRestoration/);
});

test("sample control deadline covers the observed content CLI startup without enlarging the UI hold or freshness window", () => {
  const source = readFileSync(new URL("../scripts/diagnostics/sdk/sdk-queue-sample-probe.ts", import.meta.url), "utf8");
  const deadline = source.match(/`pid:i:\$\{expected\.pid\}`\], (\d+), signal/);
  assert.ok(deadline, "the actual hold control call must retain an explicit deadline");
  assert.equal(Number(deadline[1]), 2000, "1000ms killed the real ~1125ms content CLI, even though the hold executed");
  assert.match(source, /value\.limitMs !== 1800/);
  const observer = readFileSync(new URL("../scripts/diagnostics/sdk/sdk-queue-observer.ts", import.meta.url), "utf8");
  assert.match(observer, /dependencies\.now\(\) - received > 250/);
});

test("a lost sample release acknowledgement still checks ended state once without replay or masking the error", async () => {
  const calls: string[] = [];
  const finished = { ...state, endedMs: 102 };
  const reply = await finishSampleHold(async method => {
    calls.push(method);
    if (method === "release") throw Error("release reply timed out");
    return finished;
  });
  assert.deepEqual(calls, ["release", "read"]);
  assert.deepEqual(reply.state, finished);
  assert.deepEqual(reply.failures, ["sample release: Error: release reply timed out"]);
  const source = readFileSync(new URL("../scripts/diagnostics/sdk/sdk-queue-sample-probe.ts", import.meta.url), "utf8");
  assert.match(source, /if \(attempts\.diagnosticCapture === 1 && observation\?\.identity\)/,
    "never query a diagnostic task that was not submitted");
});

test("sample cleanup retains active/unknown hold failures and does not retry a read", async () => {
  for (const outcome of [state, Error("state unavailable")]) {
    const calls: string[] = [];
    const reply = await finishSampleHold(async method => {
      calls.push(method);
      if (method === "release") return state;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    assert.deepEqual(calls, ["release", "read"]);
    assert.equal(reply.failures.length, 1);
  }
  const ok = await finishSampleHold(async () => ({ ...state, endedMs: 102 }));
  assert.deepEqual(ok.failures, []);
});

test("sample foreground check accepts the exact short Android Activity spelling, not a similar or foreign class", () => {
  const source = readFileSync(new URL("../scripts/diagnostics/sdk/sdk-queue-sample-probe.ts", import.meta.url), "utf8");
  const checks = [...source.matchAll(/assert\.(?:equal|ok)\([^\n]*active\.component[^;]*;/g)].map(value => value[0]);
  assert.equal(checks.length, 2, "both preflight and restoration must check the exact sample Activity");
  const full = "com.androiduiinspector.sample/com.androiduiinspector.sample.QueueObservationActivity";
  const short = "com.androiduiinspector.sample/.QueueObservationActivity";
  for (const check of checks) {
    const match = new Function("assert", "active", "component", "isQueueSampleComponent", check);
    for (const value of [short, full])
      assert.doesNotThrow(() => match(assert, { component: value }, full, isQueueSampleComponent));
    for (const wrong of ["other.app/.QueueObservationActivity", short + "Extra", "com.androiduiinspector.sample/.MainActivity"])
      assert.throws(() => match(assert, { component: wrong }, full, isQueueSampleComponent));
  }
  assert.match(source, /assert\.ok\(!isQueueSampleComponent\(previous\.component\)/);
  assert.match(source, /previous: previous && \{ packageName: previous\.packageName, component: previous\.component, windowId: previous\.windowId \}, attempts/);
});

test("actual Debug-only sample hold is authorized, single-use, released and bounded without Android", () => {
  const source = readFileSync(new URL("../android/sample-app/src/debug/java/com/androiduiinspector/sample/QueueHoldProvider.java", import.meta.url), "utf8");
  const debug = readFileSync(new URL("../android/sample-app/src/debug/AndroidManifest.xml", import.meta.url), "utf8");
  const main = readFileSync(new URL("../android/sample-app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  assert.match(debug, /QueueHoldProvider/); assert.match(debug, /QueueObservationActivity/);
  assert.doesNotMatch(main, /QueueHoldProvider|QueueObservationActivity/);
  const directory = mkdtempSync(join(tmpdir(), "sample-queue-hold-"));
  try {
    writeFileSync(join(directory, "QueueHoldProvider.java"), `import java.util.*;import java.util.concurrent.*;
${source.replace(/^package .*;\n/m, "").replace(/^import .*;\n/gm, "")}
class Bundle extends HashMap<String,Object>{void putString(String k,String v){put(k,v);}int getInt(String k,int d){return containsKey(k)?(Integer)get(k):d;}}
class ApplicationInfo {static final int FLAG_DEBUGGABLE=2;int flags=2;}
class Context {ApplicationInfo info=new ApplicationInfo();String name="com.androiduiinspector.sample";ApplicationInfo getApplicationInfo(){return info;}String getPackageName(){return name;}}
abstract class ContentProvider {
 final Context context=new Context();Context getContext(){return context;}
 public abstract boolean onCreate();public abstract Bundle call(String m,String a,Bundle b);
 public abstract Cursor query(Uri u,String[]p,String s,String[]a,String o);public abstract String getType(Uri u);
 public abstract Uri insert(Uri u,ContentValues v);public abstract int delete(Uri u,String s,String[]a);public abstract int update(Uri u,ContentValues v,String s,String[]a);
}
class ContentValues{}class Cursor{}class Uri{}
class Binder {static int uid=2000;static int getCallingUid(){return uid;}}
class Process {static int myPid(){return 42;}}
class SystemClock {static long elapsedRealtime(){return System.nanoTime()/1000000;}}
class Looper {static Looper getMainLooper(){return new Looper();}}
class Handler {
 static final ExecutorService executor=Executors.newSingleThreadExecutor(r->{Thread t=new Thread(r,"main");t.setDaemon(true);return t;});
 static boolean fail,queueOnly;static int posts;static Runnable last,pending;
 Handler(Looper l){}boolean post(Runnable r){last=r;if(fail)return false;posts++;if(queueOnly)pending=r;else executor.submit(r);return true;}
 void removeCallbacks(Runnable r){if(pending==r)pending=null;}
}
class JSONObject {final Map<String,Object> fields=new LinkedHashMap<>();JSONObject put(String k,Object v){fields.put(k,v);return this;}public String toString(){return fields.toString();}}
class SampleHoldCheck {
 static final String id="11111111-1111-1111-1111-111111111111", other="22222222-2222-2222-2222-222222222222";
 static Bundle extra(){Bundle b=new Bundle();b.put("pid",42);return b;}
 static void check(boolean b,String why){if(!b)throw new AssertionError(why);}
 static boolean ok(Bundle b){return "ok".equals(b.get("result"));}
 static long field(Bundle b,String key){java.util.regex.Matcher m=java.util.regex.Pattern.compile(key+"=(-?[0-9]+)").matcher((String)b.get("state"));check(m.find(),key);return Long.parseLong(m.group(1));}
 static void ended(QueueHoldProvider p) throws Exception {
  long deadline=SystemClock.elapsedRealtime()+2400;Bundle b;
  do {b=p.call("read",id,extra());if(field(b,"endedMs")!=-1)return;Thread.sleep(2);}while(SystemClock.elapsedRealtime()<deadline);
  throw new AssertionError("hold did not end");
 }
 public static void main(String[] args) throws Exception {
  try {
   QueueHoldProvider p=new QueueHoldProvider();check(p.onCreate()&&Handler.posts==0,"no hold on creation");
   Binder.uid=0;check(!ok(p.call("arm",id,extra())),"root denied");Binder.uid=10001;check(!ok(p.call("arm",id,extra())),"app denied");Binder.uid=2000;
   p.context.info.flags=0;check(!ok(p.call("arm",id,extra())),"release denied");p.context.info.flags=2;
   p.context.name="other.app";check(!ok(p.call("arm",id,extra())),"business denied");p.context.name="com.androiduiinspector.sample";
   Bundle wrong=extra();wrong.put("pid",99);check(!ok(p.call("arm",id,wrong))&&!ok(p.call("arm","bad",extra())),"identity denied");
   check(!ok(p.call("unknown",id,extra()))&&!ok(p.call("read",id,extra()))&&Handler.posts==0,"no unsupported effects");
   check(ok(p.call("arm",id,extra()))&&Handler.posts==1,"arm once");
   check(!ok(p.call("arm",id,extra()))&&!ok(p.call("release",other,extra()))&&Handler.posts==1,"no replay or foreign release");
   check(field(p.call("read",id,extra()),"endedMs")==-1,"wrong release does not unblock");
   check(ok(p.call("release",id,extra())),"owned release");ended(p);check(ok(p.call("release",id,extra())),"idempotent release");
   QueueHoldProvider automatic=new QueueHoldProvider();check(ok(automatic.call("arm",id,extra())),"automatic hold entered");ended(automatic);
   check(field(automatic.call("read",id,extra()),"endedMs")-field(automatic.call("read",id,extra()),"enteredMs")>=1700,"fixed timeout kept");
   Handler.fail=true;QueueHoldProvider failed=new QueueHoldProvider();check(!ok(failed.call("arm",id,extra())),"post failure");Handler.fail=false;
   check(!ok(failed.call("arm",id,extra())),"failure consumed once");
   Handler.queueOnly=true;QueueHoldProvider late=new QueueHoldProvider();check(!ok(late.call("arm",id,extra())),"queue entry bounded");
   check(Handler.pending==null,"queued callback removed");Handler.last.run();
   check(field(late.call("read",id,extra()),"enteredMs")==-1,"late callback cannot start a hold");
   System.out.println("sample hold checks passed");
  } finally {Handler.executor.shutdownNow();}
 }
}`);
    const built = spawnSync("javac", ["--release", "8", "-d", directory, join(directory, "QueueHoldProvider.java")], { encoding: "utf8", timeout: 20000 });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync("java", ["-cp", directory, "SampleHoldCheck"], { encoding: "utf8", timeout: 6000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /sample hold checks passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

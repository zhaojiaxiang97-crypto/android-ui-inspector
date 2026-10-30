import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("actual SDK session timing stays opt-in, authorized and on the existing monitor", () => {
  const source = readFileSync(new URL("../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/HierarchyProvider.java", import.meta.url), "utf8");
  const callStart = source.indexOf("    @Override public Bundle call("), callEnd = source.indexOf("    /** Runs one provider", callStart);
  const helperStart = source.indexOf("    private static boolean isDiagnosticMethod(");
  const openStart = source.indexOf('        if ("open-session".equals(method)) {', callEnd);
  const openEnd = source.indexOf('        if ("close-session".equals(method))', openStart);
  const sessionStart = source.indexOf("    private Bundle openSession("), sessionEnd = source.indexOf("    private Bundle closeSession", sessionStart);
  assert.ok(callStart > 0 && callEnd > callStart && openStart > 0 && openEnd > openStart && sessionEnd > sessionStart);
  const directory = mkdtempSync(join(tmpdir(), "sdk-session-timing-"));
  try {
    const path = join(directory, "SessionTimingCheck.java");
    writeFileSync(path, `import java.util.*; import java.util.concurrent.*;
public class SessionTimingCheck {
 static class Bundle extends HashMap<String,Object> {
  void putString(String k,String v){put(k,v);} void putInt(String k,int v){put(k,v);} void putLong(String k,long v){put(k,v);}
  String getString(String k){return (String)get(k);}
  boolean getBoolean(String k,boolean fallback){return containsKey(k)?(Boolean)get(k):fallback;}
 }
 static class ApplicationInfo {static final int FLAG_DEBUGGABLE=2;int flags=2;}
 static class Application {ApplicationInfo info=new ApplicationInfo();ApplicationInfo getApplicationInfo(){return info;}
  Application getApplicationContext(){return this;}String getPackageName(){return "sample";}}
 static class Binder {static int uid=2000;static int getCallingUid(){return uid;}}
 static class Process {static int myPid(){return 42;}}
 static class BuildConfig {static final String SDK_SOURCE_SHA256="fixture";}
 static class TreeQueueDiagnostics {static class Snapshot {String event(String kind){return "{}";}}Snapshot read(String arg,String instance){return null;}}
 static class SystemClock {static int reads;static long elapsedRealtimeNanos(){reads++;return System.nanoTime();}}
 static class HierarchySession {static final String SUFFIX=".session";static int builds;static boolean fail;HierarchySession(Application a,SessionTimingCheck p)throws Exception {
  check(Thread.holdsLock(p),"construction escaped monitor");builds++;if(fail)throw new Exception("build failed");}void touch(){} }
 Application app=new Application();HierarchySession session;int dispatched;
 String processInstance="fixture";TreeQueueDiagnostics treeQueueDiagnostics=new TreeQueueDiagnostics();
 Application getContext(){return app;}
 static boolean isDataMethod(String method){return "capture".equals(method);}
 ${source.slice(helperStart, callStart)}
 ${source.slice(callStart, callEnd).replace("@Override ", "")}
 private synchronized Bundle dispatch(String method,String arg,Bundle extras){
  check(Thread.holdsLock(this),"dispatch escaped monitor");dispatched++;Application app=this.app;
  ${source.slice(openStart, openEnd)}return new Bundle();}
 ${source.slice(sessionStart, sessionEnd)}
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static long number(Bundle b,String key){check(b.get(key) instanceof Number,"missing "+key);return ((Number)b.get(key)).longValue();}
 static void timed(Bundle b){
  check(number(b,"sessionTimingVersion")==1,"version");
  long lock=number(b,"sessionLockWaitNs"),dispatch=number(b,"sessionDispatchNs"),open=number(b,"sessionOpenNs"),call=number(b,"sessionCallNs");
  check(lock>=0&&open>=0&&dispatch>=open&&call>=lock+dispatch,"phase scopes");
 }
 public static void main(String[] args)throws Exception {
  SessionTimingCheck p=new SessionTimingCheck();Bundle extras=new Bundle();extras.put("sessionTiming",true);
  Bundle old=p.call("open-session",null,null);check("ok".equals(old.get("result"))&&old.size()==2,"old reply changed");
  check(SystemClock.reads==0&&HierarchySession.builds==1,"default cost or behavior changed");
  Bundle reuse=p.call("open-session",null,extras);timed(reuse);check(HierarchySession.builds==1,"recreated live service");
  p.session=null;timed(p.call("open-session",null,extras));check(HierarchySession.builds==2,"cold creation");
  p.session=null;HierarchySession.fail=true;Bundle failed=p.call("open-session",null,extras);timed(failed);
  check(failed.containsKey("error")&&!failed.containsKey("result")&&p.session==null,"failure converted into success");HierarchySession.fail=false;
  int calls=p.dispatched;Binder.uid=10001;Bundle denied=p.call("open-session",null,extras);
  check(denied.size()==1&&denied.containsKey("error")&&p.dispatched==calls,"unauthorized diagnostics or dispatch");
  Binder.uid=2000;p.app.info.flags=0;denied=p.call("open-session",null,extras);
  check(denied.size()==1&&p.dispatched==calls,"release authorization changed");p.app.info.flags=2;
  denied=p.call("unknown",null,extras);check(denied.size()==1&&p.dispatched==calls,"unsupported request");
  int clockReads=SystemClock.reads;p.call("capture",null,extras);check(SystemClock.reads==clockReads,"timing expanded to capture");
  // Hold the real object monitor; the test does not read or draw Android Views.
  CountDownLatch ready=new CountDownLatch(1);java.util.concurrent.atomic.AtomicReference<Bundle> reply=new java.util.concurrent.atomic.AtomicReference<>();
  Thread request=new Thread(()->{ready.countDown();reply.set(p.call("open-session",null,extras));});
  synchronized(p){request.start();ready.await();long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(1);
   while(request.getState()!=Thread.State.BLOCKED&&System.nanoTime()<deadline)Thread.yield();
   check(request.getState()==Thread.State.BLOCKED,"request did not wait for monitor");Thread.sleep(40);}
  request.join(1000);check(!request.isAlive(),"request stuck");timed(reply.get());
  check(number(reply.get(),"sessionLockWaitNs")>=TimeUnit.MILLISECONDS.toNanos(30),"lock cost not separated");
  System.out.println("session timing checks passed");
 }
}`);
    const built = spawnSync("javac", ["--release", "8", "-d", directory, path], { encoding: "utf8", timeout: 20000 });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync("java", ["-cp", directory, "SessionTimingCheck"], { encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /session timing checks passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

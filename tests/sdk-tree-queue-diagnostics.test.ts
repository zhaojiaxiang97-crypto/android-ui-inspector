import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseQueueEvent } from "../scripts/diagnostics/sdk/sdk-queue-observer";
import { parseRuntimeSdkBuild } from "../scripts/diagnostics/sdk/sdk-queue-build";
import { parseDiagnosticIdentity } from "../scripts/diagnostics/sdk/sdk-queue-bootstrap";

test("actual opt-in SDK diagnostic wrapper and out-of-band query bind requests without the capture monitor", { timeout: 20000 }, () => {
  const source = readFileSync(join(import.meta.dirname, "../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/HierarchyProvider.java"), "utf8");
  const queryStart = source.indexOf('        // Out-of-band scalar query:');
  const queryEnd = source.indexOf('        // Opt-in scalar diagnostics only;', queryStart);
  const helperStart = source.indexOf('    private static boolean isDiagnosticMethod(');
  const helperEnd = source.indexOf('    @Override public Bundle call(', helperStart);
  const wrapperStart = source.indexOf('    private synchronized Bundle dispatch(');
  const wrapperEnd = source.indexOf('    private Bundle dispatchWork(', wrapperStart);
  assert.ok(queryStart > 0 && queryEnd > queryStart && wrapperStart > 0 && wrapperEnd > wrapperStart);
  const directory = mkdtempSync(join(tmpdir(), "sdk-queue-diagnostic-"));
  try {
    const generated = `
import com.androiduiinspector.sdk.TreeQueueDiagnostics;
import java.util.*;
import java.util.concurrent.*;
public class QueueDiagnosticCheck {
  static class Bundle {
    Map<String,Object> values=new HashMap<>();
    void putString(String k,String v){values.put(k,v);}
    void putInt(String k,int v){values.put(k,v);}
    String getString(String k){return (String)values.get(k);}
    boolean getBoolean(String k,boolean d){return values.containsKey(k)?Boolean.TRUE.equals(values.get(k)):d;}
  }
  static class ApplicationInfo { static int FLAG_DEBUGGABLE=2; int flags=2; }
  static class Application { ApplicationInfo info=new ApplicationInfo(); Application getApplicationContext(){return this;} ApplicationInfo getApplicationInfo(){return info;} }
  static class Binder { static int uid=2000; static int getCallingUid(){return uid;} }
  static class Process { static int myPid(){return 42;} }
  static class BuildConfig { static String SDK_SOURCE_SHA256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; }
  Application app=new Application(); Application getContext(){return app;}
  String processInstance="12345678-1234-1234-1234-123456789abc";
  final ThreadLocal<TreeQueueDiagnostics.Task> treeQueueTask=new ThreadLocal<>();
  final List<String> events=new CopyOnWriteArrayList<>();
  final TreeQueueDiagnostics treeQueueDiagnostics=new TreeQueueDiagnostics(()->System.nanoTime()/1000000,events::add);
  CountDownLatch posted=new CountDownLatch(1), release=new CountDownLatch(1);
  boolean block, throwAfterPost;
${source.slice(helperStart, helperEnd)}
  Bundle call(String method,String arg,Bundle extras) {
${source.slice(queryStart, queryEnd)}
    return new Bundle();
  }
${source.slice(wrapperStart, wrapperEnd)}
  Bundle dispatchWork(String method,String arg,Bundle extras) {
    TreeQueueDiagnostics.Task task=treeQueueTask.get();
    if(task!=null)task.posted();
    posted.countDown();
    try { if(block)release.await(); }
    catch(InterruptedException e){Thread.currentThread().interrupt();throw new RuntimeException(e);}
    if(throwAfterPost)throw new RuntimeException("capture failure");
    if(task!=null){task.entered();task.ended();}
    return new Bundle();
  }
  static void check(boolean v,String reason){if(!v)throw new AssertionError(reason);}
  Bundle enabled(boolean merged){Bundle b=new Bundle();b.values.put("treeQueueDiagnostics",true);b.values.put("withTree",merged);b.putString("processInstance",processInstance);return b;}
  Bundle query(String id){Bundle e=new Bundle();e.putString("processInstance",processInstance);return call("read-tree-task",id,e);}
  Bundle bootstrap(String nonce){Bundle e=new Bundle();e.putString("pid","42");return call("read-diagnostic-identity",nonce,e);}
  public static void main(String[] args)throws Exception {
    String classic="11111111-1111-1111-1111-111111111111", merged="0123456789abcdef";
    String nonce="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    QueueDiagnosticCheck disabled=new QueueDiagnosticCheck();
    check("ok".equals(disabled.bootstrap(nonce).getString("result")),"bootstrap before any tree");
    check(disabled.events.isEmpty()&&disabled.treeQueueDiagnostics.read(classic,disabled.processInstance)==null,"bootstrap schedules no tree");
    check(disabled.call("read-sdk-build",null,new Bundle()).getString("error")!=null,"existing build still needs instance");
    check(disabled.call("read-tree-task",classic,new Bundle()).getString("error")!=null,"existing state still needs instance");
    check(disabled.bootstrap(null).getString("error")!=null&&disabled.bootstrap("bad").getString("error")!=null,"nonce required");
    check(disabled.bootstrap(nonce+"e").getString("error")!=null,"nonce length bounded");
    check(disabled.bootstrap(nonce.toUpperCase()).getString("error")!=null,"nonce syntax bounded");
    check(disabled.call("read-diagnostic-identity",nonce,null).getString("error")!=null,"PID required");
    Bundle wrongPid=new Bundle();wrongPid.putString("pid","43");
    check(disabled.call("read-diagnostic-identity",nonce,wrongPid).getString("error")!=null,"PID mismatch");
    QueueDiagnosticCheck cold=new QueueDiagnosticCheck();cold.block=true;
    Thread coldWorker=new Thread(()->cold.dispatch("capture",classic,new Bundle()));coldWorker.start();
    check(cold.posted.await(1,TimeUnit.SECONDS),"capture monitor held before diagnostic tree exists");
    ExecutorService coldReader=Executors.newSingleThreadExecutor();
    try {
      check("ok".equals(coldReader.submit(()->cold.bootstrap(nonce)).get(300,TimeUnit.MILLISECONDS).getString("result")),"identity available without a preparatory tree");
      check(cold.events.isEmpty()&&cold.treeQueueDiagnostics.read(classic,cold.processInstance)==null,"identity reads no tree state or UI");
    } finally {cold.release.countDown();coldReader.shutdown();coldWorker.join(1000);}
    check(!coldWorker.isAlive(),"capture released after identity query");
    disabled.dispatch("capture",classic,new Bundle());
    disabled.dispatch("capture-visible",merged,new Bundle());
    check(disabled.events.isEmpty()&&disabled.treeQueueDiagnostics.read(classic,disabled.processInstance)==null,"default off");
    for(boolean isMerged:new boolean[]{false,true}) {
      QueueDiagnosticCheck p=new QueueDiagnosticCheck();p.block=true;
      String id=isMerged?merged:classic;
      Thread worker=new Thread(()->p.dispatch(isMerged?"capture-visible":"capture",id,p.enabled(isMerged)));
      worker.start();check(p.posted.await(1,TimeUnit.SECONDS),"posted");
      // This caller runs while dispatch holds its monitor; no UI or capture queue used.
      ExecutorService reader=Executors.newSingleThreadExecutor();
      Bundle state=reader.submit(()->p.query(id)).get(300,TimeUnit.MILLISECONDS);
      check("ok".equals(state.getString("result"))&&state.getString("diagnostic").contains("\\\"enteredMs\\\":-1"),"out-of-band read");
      System.out.println("EVENT:"+state.getString("diagnostic"));
      Bundle identity=reader.submit(()->p.call("read-sdk-build",null,p.enabled(false))).get(300,TimeUnit.MILLISECONDS);
      check("sdk-source-v1".equals(identity.getString("protocol"))&&BuildConfig.SDK_SOURCE_SHA256.equals(identity.getString("sourceSha256"))&&Integer.valueOf(42).equals(identity.values.get("pid")),"build identity outside capture monitor");
      System.out.println("BUILD:Result: Bundle["+identity.values.toString()+"]");
      Bundle initialIdentity=reader.submit(()->p.bootstrap(nonce)).get(300,TimeUnit.MILLISECONDS);
      check("ok".equals(initialIdentity.getString("result"))&&nonce.equals(initialIdentity.getString("nonce")),"bootstrap outside capture monitor without known instance");
      System.out.println("BOOTSTRAP:Result: Bundle["+initialIdentity.values.toString()+"]");
      reader.shutdown();
      check(p.query("wrong").getString("error")!=null,"wrong request");
      Binder.uid=10001;check(p.query(id).getString("error")!=null,"unauthorized");check(p.call("read-sdk-build",null,p.enabled(false)).getString("error")!=null,"build uid denied");Binder.uid=2000;
      Binder.uid=0;check(p.query(id).getString("error")!=null,"root diagnostic denied");check(p.call("read-sdk-build",null,p.enabled(false)).getString("error")!=null,"root build denied");Binder.uid=2000;
      p.app.info.flags=0;check(p.query(id).getString("error")!=null,"release denied");check(p.call("read-sdk-build",null,p.enabled(false)).getString("error")!=null,"build release denied");p.app.info.flags=2;
      Bundle wrong=new Bundle();wrong.putString("processInstance","wrong");
      check(p.call("read-tree-task",id,wrong).getString("error")!=null,"wrong instance");
      check(p.call("read-sdk-build",null,wrong).getString("error")!=null,"build instance denied");
      for(int uid:new int[]{10001,0}) {Binder.uid=uid;check(p.bootstrap(nonce).getString("error")!=null,"bootstrap shell only");}Binder.uid=2000;
      p.app.info.flags=0;check(p.bootstrap(nonce).getString("error")!=null,"bootstrap debug only");p.app.info.flags=2;
      Thread.sleep(650);
      check(p.events.stream().filter(e->e.contains("\\\"phase\\\":\\\"queued\\\"")).count()==1,"one early notification");
      check(p.events.get(0).contains(id)&&p.events.get(0).contains("\\\"kind\\\":\\\""+(isMerged?"merged":"classic")+"\\\""),"kind identity");
      p.release.countDown();worker.join(1000);check(!worker.isAlive(),"finished");
      TreeQueueDiagnostics.Snapshot done=p.treeQueueDiagnostics.read(id,p.processInstance);
      check(done.enteredMs>=done.postedMs&&done.settledMs>=done.endedMs,"lifecycle clocks");
      int count=p.events.size();Thread.sleep(550);check(p.events.size()==count,"timer disposed");
    }
    QueueDiagnosticCheck cancelled=new QueueDiagnosticCheck();cancelled.block=true;
    Thread worker=new Thread(()->{try{cancelled.dispatch("capture",classic,cancelled.enabled(false));}catch(RuntimeException expected){}});
    worker.start();check(cancelled.posted.await(1,TimeUnit.SECONDS),"cancel posted");worker.interrupt();worker.join(1000);
    Thread.sleep(550);check(cancelled.events.stream().noneMatch(e->e.contains("\\\"phase\\\":\\\"queued\\\"")),"cancelled timer removed");
    check(cancelled.treeQueueDiagnostics.read(classic,cancelled.processInstance).settledMs>=0,"cancel settled");
    check(cancelled.dispatch("capture", "bad",cancelled.enabled(false)).getString("error")!=null,"invalid token");
    check(cancelled.dispatch("capture-visible",merged,cancelled.enabled(false)).getString("error")!=null,"diagnostic requires merged tree");
    check(cancelled.dispatch("capture-style",merged,cancelled.enabled(false)).getString("error")!=null,"other methods cannot opt in");
    Bundle badIdentity=cancelled.enabled(false);badIdentity.putString("processInstance","wrong");
    check(cancelled.dispatch("capture",classic,badIdentity).getString("error")!=null,"capture identity guard");
    QueueDiagnosticCheck fast=new QueueDiagnosticCheck();fast.dispatch("capture",classic,fast.enabled(false));
    Thread.sleep(550);check(fast.events.stream().noneMatch(e->e.contains("\\\"phase\\\":\\\"queued\\\"")),"fast capture no queued notice");
    fast.throwAfterPost=true;
    try{fast.dispatch("capture",classic,fast.enabled(false));throw new AssertionError("failure swallowed");}catch(RuntimeException expected){}
    check(fast.treeQueueDiagnostics.read(classic,fast.processInstance).settledMs>=0&&fast.treeQueueTask.get()==null,"exception cleanup");
    TreeQueueDiagnostics throwing=new TreeQueueDiagnostics(()->10,msg->{throw new RuntimeException("log failure");});
    TreeQueueDiagnostics.Task t=throwing.begin(classic,"classic",42,fast.processInstance);t.posted();t.entered();t.ended();t.settle();
    System.out.println("diagnostic lifecycle checks passed");
  }
}`;
    const javaPath = join(directory, "QueueDiagnosticCheck.java");
    writeFileSync(javaPath, generated);
    const compile = spawnSync("javac", ["--release", "8", "-d", directory, javaPath,
      join(import.meta.dirname, "../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/TreeQueueDiagnostics.java")], { encoding: "utf8", timeout: 10000 });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync("java", ["-cp", directory, "QueueDiagnosticCheck"], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /lifecycle checks passed/);
    const states = run.stdout.split(/\r?\n/).filter(line => line.startsWith("EVENT:"))
      .map(line => parseQueueEvent(line.slice(6)));
    assert.deepEqual(states.map(state => state.kind), ["classic", "merged"]);
    assert.ok(states.every(state => state.phase === "state" && state.enteredMs === -1));
    const builds = run.stdout.split(/\r?\n/).filter(line => line.startsWith("BUILD:"))
      .map(line => parseRuntimeSdkBuild(line.slice(6), { sourceSha256: "a".repeat(64), pid: 42,
        processInstance: "12345678-1234-1234-1234-123456789abc" }));
    assert.equal(builds.length, 2);
    assert.ok(builds.every(build => build.sdkVersion === `sdk-source-v1:${"a".repeat(64)}`));
    const initialIdentities = run.stdout.split(/\r?\n/).filter(line => line.startsWith("BOOTSTRAP:"))
      .map(line => parseDiagnosticIdentity(line.slice(10), { sourceSha256: "a".repeat(64), pid: 42, nonce: "e".repeat(64) }));
    assert.equal(initialIdentities.length, 2);
    assert.ok(initialIdentities.every(identity => identity.processInstance === "12345678-1234-1234-1234-123456789abc"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

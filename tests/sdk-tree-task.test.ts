import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("actual SDK tree method rejects queued/running late results, post failure and interruption", { timeout: 20000 }, () => {
  const source = readFileSync(join(import.meta.dirname, "../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/HierarchyCapture.java"), "utf8");
  const start = source.indexOf("    JSONObject writeTreeFile(");
  const end = source.indexOf("    Bundle captureOwn(", start);
  assert.ok(start > 0 && end > start);
  const directory = mkdtempSync(join(tmpdir(), "sdk-tree-task-"));
  try {
    mkdirSync(join(directory, "android/util"), { recursive: true });
    writeFileSync(join(directory, "android/util/Log.java"), "package android.util; public class Log { public static int d(String a,String b){return 0;} }");
    // Compile the production method unchanged against deterministic queue/View stubs.
    writeFileSync(join(directory, "TreeTaskCheck.java"), `
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import com.androiduiinspector.sdk.TreeQueueDiagnostics;
public class TreeTaskCheck {
  final ThreadLocal<TreeQueueDiagnostics.Task> treeQueueTask=new ThreadLocal<>();
  static class JSONObject { public String toString(){return "{}";} }
  static class SystemClock { static long elapsedRealtime(){return System.nanoTime()/1000000;} }
  static class Looper { static Looper getMainLooper(){return new Looper();} }
  static class Handler {
    static volatile Runnable pending;
    static boolean immediate, rejected;
    static CountDownLatch posted;
    static Thread worker;
    Handler(Looper l){}
    boolean post(Runnable r){
      if(rejected)return false;
      pending=r; posted.countDown();
      if(immediate){worker=new Thread(r);worker.start();}
      return true;
    }
    void removeCallbacks(Runnable r){if(pending==r)pending=null;}
  }
  static class View { boolean isAttachedToWindow(){return true;} }
  static class Window { View getDecorView(){return new View();} }
  static class Activity { Window getWindow(){return new Window();} }
  static class Application { File dir; Application(File d){dir=d;} File getNoBackupFilesDir(){return dir;} }
  Callable<Activity> resumed=()->new Activity();
  static AtomicInteger reads=new AtomicInteger();
  static CountDownLatch entered, release;
  String processInstance="instance";
  JSONObject captureTree(Application a,View r,String instance) throws Exception {
    reads.incrementAndGet();
    if(entered!=null){entered.countDown();release.await();}
    return new JSONObject();
  }
${source.slice(start, end)}
  static void check(boolean v,String message){if(!v)throw new AssertionError(message);}
  static void reset(){Handler.pending=null; Handler.immediate=false; Handler.rejected=false;
    Handler.posted=new CountDownLatch(1); entered=null; release=null; reads.set(0);}
  public static void main(String[] args) throws Exception {
    TreeTaskCheck probe=new TreeTaskCheck(); Application app=new Application(new File(args[0]));
    reset();
    AtomicReference<Throwable> failure=new AtomicReference<>();
    CopyOnWriteArrayList<String> diagnosticEvents=new CopyOnWriteArrayList<>();
    TreeQueueDiagnostics diagnostics=new TreeQueueDiagnostics(()->System.nanoTime()/1000000,diagnosticEvents::add);
    String request="11111111-1111-1111-1111-111111111111", instance="22222222-2222-2222-2222-222222222222";
    Thread queued=new Thread(()->{
      probe.treeQueueTask.set(diagnostics.begin(request,"classic",42,instance));
      try{probe.writeTreeFile(app,"queued.json");}catch(Throwable e){failure.set(e);}
      finally{probe.treeQueueTask.remove();}
    });
    queued.start(); check(Handler.posted.await(1,TimeUnit.SECONDS),"posted");
    Runnable late=Handler.pending; queued.join(4500);
    check(!queued.isAlive() && failure.get().getMessage().equals("View tree timed out"),"queued timeout");
    check(diagnosticEvents.stream().filter(e->e.contains("\\\"phase\\\":\\\"queued\\\"")).count()==1,"actual tree early notification");
    TreeQueueDiagnostics.Snapshot diagnostic=diagnostics.read(request,instance);
    check(diagnostic.enteredMs==-1&&diagnostic.settledMs>=diagnostic.postedMs,"actual tree settled without entering");
    late.run(); check(reads.get()==0 && Handler.pending==null && !new File(app.dir,"queued.json").exists(),"queued late work discarded");

    reset(); Handler.immediate=true; entered=new CountDownLatch(1); release=new CountDownLatch(1); failure.set(null);
    Thread running=new Thread(()->{try{probe.writeTreeFile(app,"running.json");}catch(Throwable e){failure.set(e);}});
    running.start(); check(entered.await(1,TimeUnit.SECONDS),"entered"); running.join(4500);
    check(!running.isAlive() && failure.get().getMessage().equals("View tree timed out"),"running timeout");
    release.countDown(); Handler.worker.join(1000);
    check(!Handler.worker.isAlive(),"late task finished without interruption");
    check(!new File(app.dir,"running.json").exists(),"running late result never publishes");

    reset(); Handler.rejected=true;
    try{probe.writeTreeFile(app,"rejected.json");throw new AssertionError("post accepted");}
    catch(IllegalStateException e){check(e.getMessage().equals("Main queue unavailable"),"post rejection");}

    reset(); failure.set(null); AtomicBoolean interrupted=new AtomicBoolean();
    Thread cancelled=new Thread(()->{try{probe.writeTreeFile(app,"cancelled.json");}catch(Throwable e){failure.set(e);interrupted.set(Thread.currentThread().isInterrupted());}});
    cancelled.start(); check(Handler.posted.await(1,TimeUnit.SECONDS),"cancel posted");
    Runnable cancelledLate=Handler.pending; cancelled.interrupt(); cancelled.join(1000); cancelledLate.run();
    check(failure.get() instanceof InterruptedException && interrupted.get() && reads.get()==0,"interrupt preserved, queue removed");

    reset(); Handler.immediate=true; probe.writeTreeFile(app,"fresh.json");
    check(reads.get()==1 && new File(app.dir,"fresh.json").exists(),"fresh task succeeds after failures");
    System.out.println("5 lifecycle checks passed");
  }
}`);
    const compile = spawnSync("javac", ["--release", "8", "-d", directory, join(directory, "android/util/Log.java"), join(directory, "TreeTaskCheck.java"), join(import.meta.dirname, "../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/TreeQueueDiagnostics.java")], { encoding: "utf8", timeout: 20000 });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync("java", ["-cp", directory, "TreeTaskCheck", directory], { encoding: "utf8", timeout: 12000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /5 lifecycle checks passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

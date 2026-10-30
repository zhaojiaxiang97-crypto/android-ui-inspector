package com.androiduiinspector.sample;

import android.os.Debug;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;

/** Debug-only grouped counters. No extra captures, per-image logs, CPU copies or worker threads. */
final class PipelineWaitProbe {
    private static final String[] SDK = {"context", "contextCpu", "draw", "drawCpu", "verify", "verifyCpu", "snapshotPrepare", "snapshotInvoke"};
    private final AtomicLong[] sdk = new AtomicLong[SDK.length];
    private final long[] uiBefore = new long[SDK.length]; // Main thread only, one capture per post.
    private final Group[] groups = {new Group(), new Group()};
    private final AtomicLong observer = new AtomicLong();
    private final boolean schedulerEnabled;
    private long schedulerWall, schedulerRuntime, schedulerRunnable, schedulerSlices, schedulerReadNanos;
    private int schedulerCalls, schedulerFailures;
    private long[] schedulerBefore;
    private long schedulerStarted;
    long fileFinishNanos;

    private static final class Group {
        final AtomicLong[] ui = new AtomicLong[SDK.length];
        final AtomicLong uiCalls = new AtomicLong(), encodeCalls = new AtomicLong(), jsonCalls = new AtomicLong();
        final AtomicLong captureWait = new AtomicLong(), uiQueue = new AtomicLong(), uiTask = new AtomicLong();
        final AtomicLong encodeQueue = new AtomicLong(), encode = new AtomicLong(), encodeCpu = new AtomicLong();
        final AtomicLong json = new AtomicLong(), jsonCpu = new AtomicLong(), hash = new AtomicLong();
        final AtomicLong getWait = new AtomicLong(), tailGetWait = new AtomicLong(), write = new AtomicLong(), drains = new AtomicLong();
        Group() { for (int index = 0; index < ui.length; index++) ui[index] = new AtomicLong(); }
    }

    PipelineWaitProbe(Object timing) throws Exception {
        this(timing, false);
    }
    PipelineWaitProbe(Object timing, boolean schedulerEnabled) throws Exception {
        this.schedulerEnabled = schedulerEnabled;
        for (int index = 0; index < SDK.length; index++) {
            Field field = timing.getClass().getDeclaredField(SDK[index]); field.setAccessible(true);
            sdk[index] = (AtomicLong) field.get(timing);
        }
    }
    private Group group(int ordinal) {
        if (ordinal < 0 || ordinal >= 407) throw new IllegalArgumentException("Invalid measured ordinal");
        return groups[ordinal >= 32 && ordinal < 96 ? 0 : 1];
    }
    void beforeUi() {
        long start = System.nanoTime();
        for (int index = 0; index < SDK.length; index++) uiBefore[index] = sdk[index].get();
        observer.addAndGet(System.nanoTime() - start);
    }
    void beforeUi(int ordinal) {
        if (schedulerEnabled && ordinal >= 32 && ordinal < 96) {
            schedulerStarted = System.nanoTime();
            schedulerBefore = readScheduler();
        }
        beforeUi();
    }
    private long[] readScheduler() {
        long start = System.nanoTime();
        try {
            if (android.os.Process.myTid() != android.os.Process.myPid())
                throw new IllegalStateException("Scheduler observation must be on main thread");
            byte[] bytes = java.nio.file.Files.readAllBytes(new java.io.File("/proc/self/task/"
                    + android.os.Process.myTid() + "/schedstat").toPath());
            if (bytes.length > 4096) throw new IllegalStateException("Oversize scheduler observation");
            String[] fields = new String(bytes, java.nio.charset.StandardCharsets.UTF_8).trim().split("\\s+");
            if (fields.length != 3) throw new IllegalStateException("Invalid scheduler observation");
            long[] values = new long[3];
            for (int i = 0; i < values.length; i++) {
                values[i] = Long.parseLong(fields[i]);
                if (values[i] < 0) throw new IllegalStateException("Negative scheduler observation");
            }
            return values;
        } catch (Exception unavailable) { return null; }
        finally { schedulerReadNanos += System.nanoTime() - start; }
    }
    void afterUi(int ordinal) {
        long start = System.nanoTime(); Group group = group(ordinal);
        for (int index = 0; index < SDK.length; index++) group.ui[index].addAndGet(sdk[index].get() - uiBefore[index]);
        group.uiCalls.incrementAndGet(); observer.addAndGet(System.nanoTime() - start);
        if (schedulerEnabled && ordinal >= 32 && ordinal < 96) {
            long[] after = readScheduler();
            long wall = System.nanoTime() - schedulerStarted;
            if (schedulerBefore == null || after == null || after[0] <= schedulerBefore[0]
                    || after[1] < schedulerBefore[1] || after[2] < schedulerBefore[2]
                    || after[0] - schedulerBefore[0] > wall || after[1] - schedulerBefore[1] > wall
                    || after[0] - schedulerBefore[0] + after[1] - schedulerBefore[1] > wall) schedulerFailures++;
            else {
                schedulerCalls++; schedulerWall += wall;
                schedulerRuntime += after[0] - schedulerBefore[0];
                schedulerRunnable += after[1] - schedulerBefore[1];
                schedulerSlices += after[2] - schedulerBefore[2];
            }
            schedulerBefore = null;
        }
    }
    void captureReturned(int ordinal, long elapsed, UiTaskBatch.Result batch) {
        long start = System.nanoTime(); Group group = group(ordinal);
        group.captureWait.addAndGet(elapsed); group.uiQueue.addAndGet(batch.queueNanos); group.uiTask.addAndGet(batch.taskNanos);
        observer.addAndGet(System.nanoTime() - start);
    }
    void workerStarted(int ordinal, long submitted) {
        long start = System.nanoTime(); group(ordinal).encodeQueue.addAndGet(start - submitted);
        observer.addAndGet(System.nanoTime() - start);
    }
    void stage(int ordinal, String phase, long began, long cpu) {
        long start = System.nanoTime(); Group group = group(ordinal);
        if (phase.equals("encode")) {
            group.encode.addAndGet(start - began); group.encodeCpu.addAndGet(Math.max(0, Debug.threadCpuTimeNanos() - cpu));
            group.encodeCalls.incrementAndGet();
        } else if (phase.equals("json")) {
            group.json.addAndGet(start - began); group.jsonCpu.addAndGet(Math.max(0, Debug.threadCpuTimeNanos() - cpu));
            group.jsonCalls.incrementAndGet();
        } else if (phase.equals("hash")) group.hash.addAndGet(start - began);
        else throw new IllegalArgumentException("Unknown pipeline phase");
        observer.addAndGet(System.nanoTime() - start);
    }
    void drained(int ordinal, long getNanos, long writeNanos, boolean tail) {
        long start = System.nanoTime(); Group group = group(ordinal);
        group.getWait.addAndGet(getNanos); if (tail) group.tailGetWait.addAndGet(getNanos);
        group.write.addAndGet(writeNanos); group.drains.incrementAndGet();
        observer.addAndGet(System.nanoTime() - start);
    }
    JSONObject report(long wallNanos) throws Exception {
        JSONArray rows = new JSONArray(); long capture = 0, get = 0, write = 0;
        for (int index = 0; index < groups.length; index++) {
            Group group = groups[index];
            JSONObject ui = new JSONObject();
            for (int key = 0; key < SDK.length; key++) ui.put(SDK[key] + "Nanos", group.ui[key].get());
            rows.put(new JSONObject().put("group", index == 0 ? "fixed64" : "remaining343")
                    .put("uiCalls", group.uiCalls.get()).put("encodeCalls", group.encodeCalls.get())
                    .put("jsonCalls", group.jsonCalls.get()).put("drains", group.drains.get()).put("sdkUi", ui)
                    .put("captureWaitNanos", group.captureWait.get()).put("uiQueueNanos", group.uiQueue.get()).put("uiTaskNanos", group.uiTask.get())
                    .put("encodeQueueNanos", group.encodeQueue.get()).put("encodeWallNanos", group.encode.get()).put("encodeCpuNanos", group.encodeCpu.get())
                    .put("jsonWallNanos", group.json.get()).put("jsonCpuNanos", group.jsonCpu.get()).put("hashWallNanos", group.hash.get())
                    .put("futureGetNanos", group.getWait.get()).put("tailFutureGetNanos", group.tailGetWait.get()).put("writeNanos", group.write.get()));
            capture += group.captureWait.get(); get += group.getWait.get(); write += group.write.get();
        }
        long remainder = wallNanos - capture - get - write - fileFinishNanos;
        if (remainder < 0) throw new IllegalStateException("Overlapping main pipeline accounting");
        JSONObject answer = new JSONObject().put("groups", rows).put("first", 32).put("end", 96)
                .put("observerNanos", observer.get()).put("perImageLogs", false).put("extraCaptures", 0)
                .put("mainExclusive", new JSONObject().put("captureWaitNanos", capture).put("futureGetNanos", get)
                        .put("writeNanos", write).put("fileFinishNanos", fileFinishNanos).put("otherNanos", remainder))
                .put("parallelCountersAreNotExclusive", true).put("futureGetIncludesHandoff", true);
        if (schedulerEnabled) answer.put("mainScheduler", new JSONObject()
                .put("scope", "fixed64-ui-capture-including-boundary-reads").put("tid", android.os.Process.myPid())
                .put("calls", schedulerCalls).put("unavailableCalls", schedulerFailures)
                .put("wallNanos", schedulerWall).put("runtimeNanos", schedulerRuntime)
                .put("runnableWaitNanos", schedulerRunnable).put("timeSlices", schedulerSlices)
                .put("unaccountedNanos", schedulerWall - schedulerRuntime - schedulerRunnable)
                .put("readNanos", schedulerReadNanos).put("notGpuTime", true)
                .put("notExactSnapshotInvoke", true));
        return answer;
    }
}

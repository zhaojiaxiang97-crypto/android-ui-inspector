package com.artemis.helper;

import android.accessibilityservice.AccessibilityService;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** Paired, read-only diagnostic. No action field, dispatch gate, node ticket or input callback. */
public final class InspectorTargetProbe {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final AtomicReference<Job> ACTIVE = new AtomicReference<>();
    private InspectorTargetProbe() {}

    private static final class Job {
        final JSONObject identity, target;
        final long started = SystemClock.elapsedRealtime(), deadline = started + 1000;
        final CountDownLatch done = new CountDownLatch(1);
        volatile long mainStarted = -1, stageStarted = -1;
        volatile String stage;
        volatile InspectorObservation.InputScanProgress scan;
        boolean closed, running;
        JSONObject result;
        Runnable runnable;
        Job(String body) throws Exception {
            if (body == null || body.getBytes(StandardCharsets.UTF_8).length > 4096) throw new IllegalArgumentException();
            JSONObject raw = new JSONObject(body);
            InspectorObservation.waitKeys(raw, "version", "sessionId", "requestId", "serviceInstanceId", "captureId", "packageName", "windowId", "display", "target");
            InspectorObservation.waitInteger(raw, "version", 1, 1);
            identity = new JSONObject().put("version", 1);
            for (String key : new String[]{"sessionId", "requestId", "serviceInstanceId", "captureId"})
                identity.put(key, InspectorObservation.waitUuid(raw, key));
            String packageName = InspectorObservation.waitText(raw, "packageName", 256);
            String windowId = InspectorObservation.waitText(raw, "windowId", 10);
            if (!packageName.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")
                    || !windowId.matches("0|[1-9][0-9]{0,9}")) throw new IllegalArgumentException();
            JSONObject frame = raw.getJSONObject("display");
            InspectorObservation.waitKeys(frame, "width", "height", "rotation");
            int width = (int) InspectorObservation.waitInteger(frame, "width", 1, 16384);
            int height = (int) InspectorObservation.waitInteger(frame, "height", 1, 16384);
            int rotation = (int) InspectorObservation.waitInteger(frame, "rotation", 0, 3);
            identity.put("packageName", packageName).put("windowId", windowId).put("display",
                    new JSONObject().put("width", width).put("height", height).put("rotation", rotation));
            target = InspectorInput.probeTarget(raw.getJSONObject("target"), width, height);
        }
        synchronized boolean permitted(BooleanSupplier authenticated) {
            return !closed && SystemClock.elapsedRealtime() < deadline && authenticated.getAsBoolean();
        }
        synchronized void finish(String status, String code) throws Exception {
            if (closed) return;
            closed = true;
            InspectorObservation.InputScanProgress frozen = scan;
            long finished = SystemClock.elapsedRealtime();
            JSONObject reply = new JSONObject();
            for (String key : new String[]{"version", "sessionId", "requestId", "serviceInstanceId", "captureId", "packageName", "windowId", "display"})
                reply.put(key, identity.get(key));
            reply.put("readOnly", true).put("dispatchState", "not_sent").put("status", status)
                    .put("startedAtMs", started).put("finishedAtMs", finished);
            if (code != null) reply.put("errorCode", code);
            if (mainStarted >= started && mainStarted <= finished) {
                reply.put("mainStartedAtMs", mainStarted);
                if (stage != null && stageStarted >= mainStarted && stageStarted <= finished)
                    reply.put("preflightStage", stage).put("preflightStageStartedAtMs", stageStarted);
                if (frozen != null) {
                    JSONObject diagnostics = InspectorInput.probeDiagnostics(frozen, mainStarted, mainStarted, finished);
                    if (diagnostics != null) reply.put("scanDiagnostics", diagnostics);
                }
            }
            result = reply;
            done.countDown();
        }
    }

    public static JSONObject execute(AccessibilityService service, String body, BooleanSupplier authenticated) throws Exception {
        final Job job;
        try { job = new Job(body); }
        catch (Exception invalid) { return new JSONObject().put("success", false).put("errorCode", "invalid_request"); }
        if (!ACTIVE.compareAndSet(null, job)) { job.finish("rejected", "busy"); return job.result; }
        job.runnable = () -> {
            try {
                synchronized (job) {
                    if (job.closed) return;
                    job.running = true;
                    job.mainStarted = SystemClock.elapsedRealtime();
                    job.stage = "precheck"; job.stageStarted = job.mainStarted;
                }
                InspectorObservation.probeInputCapture(service, job.identity.getString("serviceInstanceId"),
                        job.identity.getString("captureId"), job.identity.getString("packageName"), job.identity.getString("windowId"),
                        job.identity.getJSONObject("display"), job.target, job.deadline, () -> job.permitted(authenticated),
                        stage -> { synchronized (job) { if (!job.closed) { job.stageStarted = SystemClock.elapsedRealtime(); job.stage = stage; } } },
                        scan -> { synchronized (job) { if (!job.closed) job.scan = scan; } });
                job.finish("completed", null);
            } catch (InspectorObservation.InputBoundaryFailure failure) {
                try { job.finish(failure.code.equals("timeout") ? "timeout" : "rejected", failure.code); }
                catch (Exception invalid) { throw new IllegalStateException("Probe receipt failed"); }
            } catch (Exception failure) {
                try { job.finish("rejected", "incomplete"); }
                catch (Exception invalid) { throw new IllegalStateException("Probe receipt failed"); }
            } finally { ACTIVE.compareAndSet(job, null); }
        };
        try {
            if (!authenticated.getAsBoolean()) job.finish("rejected", "authorization_changed");
            else if (!MAIN.post(job.runnable)) job.finish("rejected", "busy");
            else if (!job.done.await(Math.max(0, job.deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS))
                job.finish("timeout", "timeout");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt(); job.finish("rejected", "cancelled");
        } finally {
            synchronized (job) {
                if (!job.running) { MAIN.removeCallbacks(job.runnable); ACTIVE.compareAndSet(job, null); }
            }
        }
        return job.result;
    }
}

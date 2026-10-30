package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.FrameLayout;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Debug sample only: exercise real timeout and late cleanup without blocking a business App. */
final class CaptureFailureProbe {
    static void start(Activity activity, FrameLayout parent, View target) {
        SlowView slow = new SlowView(activity);
        parent.addView(slow, new FrameLayout.LayoutParams(120, 80));
        View root = activity.getWindow().getDecorView();
        Activity guarded = new Activity() {
            @Override public android.view.Window getWindow() {
                if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Window read off UI thread");
                return activity.getWindow();
            }
        };
        new Thread(() -> {
            JSONObject report = new JSONObject();
            try {
                Class<?> provider = Class.forName("com.androiduiinspector.sdk.CaptureFrame");
                Class<?> timing = Class.forName(provider.getName() + "$CaptureTiming");
                Constructor<?> ctor = timing.getDeclaredConstructor(); ctor.setAccessible(true);
                // Controlled timestamp fixture, not a performance measurement.
                Object fixture = ctor.newInstance();
                Field origin = timing.getDeclaredField("origin"); origin.setAccessible(true);
                Method queued = timing.getDeclaredMethod("queued", long.class); queued.setAccessible(true);
                Method task = timing.getDeclaredMethod("task", String.class, long.class, long.class, long.class); task.setAccessible(true);
                Method taskReply = timing.getDeclaredMethod("taskReply", android.os.Bundle.class); taskReply.setAccessible(true);
                int[] waits = {0, 1, 15, 16, 49, 50, 199, 200, 300, 400, 500, 600};
                long base = origin.getLong(fixture);
                for (int i = 0; i < waits.length; i++) {
                    queued.invoke(fixture, waits[i] * 1_000_000L);
                    long posted = base + i * 1_000_000L, entered = posted + waits[i] * 1_000_000L;
                    task.invoke(fixture, "example.View@" + Integer.toHexString(i + 1), posted, entered, entered + 100_000_000L);
                }
                android.os.Bundle taskData = new android.os.Bundle(); taskReply.invoke(fixture, taskData);
                if (!"1;2;2;2;5".equals(taskData.getString("uiQueueBuckets")) || taskData.getLong("uiQueueMaxMs") != 600
                        || taskData.getString("uiSlowTasks").split(";").length != 8)
                    throw new IllegalStateException("Invalid bounded task fixture: " + taskData);
                report.put("taskFixture", new JSONObject().put("uiQueueBuckets", taskData.getString("uiQueueBuckets"))
                        .put("uiQueueMaxMs", Long.toString(taskData.getLong("uiQueueMaxMs"))).put("uiSlowTasks", taskData.getString("uiSlowTasks")));
                Method capture = provider.getDeclaredMethod("captureFrame", View.class, View.class, boolean.class, timing, boolean.class);
                capture.setAccessible(true);
                Class<?> owner = Class.forName("com.androiduiinspector.sdk.HierarchyProvider");
                Object windowOwner = owner.getDeclaredConstructor().newInstance();
                Field windowResumed = owner.getDeclaredField("resumed"); windowResumed.setAccessible(true);
                windowResumed.set(windowOwner, new java.lang.ref.WeakReference<>(guarded));
                Field captureOwner = owner.getDeclaredField("capture"); captureOwner.setAccessible(true);
                Object windowProvider = captureOwner.get(windowOwner);
                Method verifyRoot = windowProvider.getClass().getDeclaredMethod("verifyCaptureRoot", View.class); verifyRoot.setAccessible(true);
                verifyRoot.invoke(windowProvider, root);
                report.put("windowVerificationOnUi", true);
                try {
                    verifyRoot.invoke(windowProvider, target);
                    throw new IllegalStateException("Changed root was accepted");
                } catch (InvocationTargetException expected) {
                    if (!(expected.getCause() instanceof IllegalStateException)) throw expected;
                }
                report.put("changedRootRejected", true);
                windowResumed.set(windowOwner, new java.lang.ref.WeakReference<Activity>(null));
                try {
                    verifyRoot.invoke(windowProvider, root);
                    throw new IllegalStateException("Missing activity was accepted");
                } catch (InvocationTargetException expected) {
                    if (!(expected.getCause() instanceof IllegalStateException)) throw expected;
                }
                report.put("missingActivityRejected", true);
                CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
                new Handler(Looper.getMainLooper()).post(() -> {
                    entered.countDown();
                    try { release.await(8, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                });
                if (!entered.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("UI blocker never started");
                try { report.put("queue", timeout(capture, ctor, target, root, "ui-queue")); }
                finally { release.countDown(); }
                barrier();
                recover(capture, ctor, target, root);
                report.put("queueRecovery", true);
                slow.delayPrepare = true;
                report.put("prepare", timeout(capture, ctor, slow, root, "draw-prepare"));
                barrier();
                recover(capture, ctor, slow, root);
                report.put("prepareRecovery", true);
                // Force the existing unsupported-outline path in this fixture only.
                new Handler(Looper.getMainLooper()).post(() -> slow.setClipToOutline(true));
                barrier();
                Object diagnosticTiming = ctor.newInstance();
                Field shortFlag = timing.getDeclaredField("shortParentDiagnostics"); shortFlag.setAccessible(true);
                shortFlag.setBoolean(diagnosticTiming, true);
                Object diagnosticFrame = capture.invoke(null, slow, root, true, diagnosticTiming, true);
                if (diagnosticFrame == null) throw new IllegalStateException("Diagnostic capture returned empty frame");
                Field imageField = diagnosticFrame.getClass().getDeclaredField("bitmap"); imageField.setAccessible(true);
                try {
                    Field contextField = diagnosticFrame.getClass().getDeclaredField("immutableGeometry"); contextField.setAccessible(true);
                    Object context = contextField.get(diagnosticFrame);
                    Method json = context.getClass().getDeclaredMethod("json", long.class, long.class); json.setAccessible(true);
                    JSONObject shortChain = (JSONObject) json.invoke(context, 10L, 20L);
                    if (!shortChain.optBoolean("diagnosticOnly") || shortChain.getJSONArray("chain").length() > 2
                            || shortChain.has("bitmapSpace") || shortChain.has("clipContext"))
                        throw new IllegalStateException("Short parent chain authorized placement");
                    report.put("shortParentDiagnostic", shortChain);
                    Object baseline = capture.invoke(null, slow, root, true, ctor.newInstance(), true);
                    if (baseline == null) throw new IllegalStateException("Baseline capture returned empty frame");
                    if (contextField.get(baseline) != null) throw new IllegalStateException("Diagnostic enabled without opt-in");
                    Bitmap oldImage = (Bitmap) imageField.get(baseline);
                    try {
                        java.io.ByteArrayOutputStream a = new java.io.ByteArrayOutputStream(), b = new java.io.ByteArrayOutputStream();
                        if (!((Bitmap) imageField.get(diagnosticFrame)).compress(Bitmap.CompressFormat.PNG, 100, a)
                                || !oldImage.compress(Bitmap.CompressFormat.PNG, 100, b)
                                || !java.util.Arrays.equals(a.toByteArray(), b.toByteArray()))
                            throw new IllegalStateException("Diagnostic capture changed fixture pixels");
                        report.put("shortParentPixelsUnchanged", true);
                    } finally { oldImage.recycle(); }
                } finally {
                    ((Bitmap) imageField.get(diagnosticFrame)).recycle();
                    new Handler(Looper.getMainLooper()).post(() -> slow.setClipToOutline(false));
                    barrier();
                }
                slow.delayCapture = true;
                String nonce = "1234567890abcdef";
                String targetRef = slow.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(slow));
                android.os.Bundle extras = new android.os.Bundle(); extras.putString("priorityViewRef", targetRef);
                // Internal test instance only; production shell-UID authorization stays unchanged.
                Object testProvider = ProbeRunner.sdkCapture(activity);
                Method visible = testProvider.getClass().getDeclaredMethod("captureVisible", android.app.Application.class, String.class, android.os.Bundle.class);
                visible.setAccessible(true);
                android.os.Bundle reply = (android.os.Bundle) visible.invoke(testProvider, activity.getApplication(), nonce, extras);
                if (reply == null || !"draw-snapshot".equals(reply.getString("failurePhase")) || !targetRef.equals(reply.getString("failureTarget"))
                        || !nonce.equals(reply.getString("nonce")) || reply.getLong("failureWaitMs") < 3000
                        || reply.getInt("failureCompleted", -1) != 0 || reply.containsKey("result") || reply.containsKey("sha256"))
                    throw new IllegalStateException("Invalid full-capture failure response: " + reply);
                report.put("draw", new JSONObject().put("phase", reply.getString("failurePhase")).put("waitMs", reply.getLong("failureWaitMs"))
                        .put("timing", new JSONObject(reply.getString("failureTiming")))
                        .put("phaseStartedMs", reply.getLong("failurePhaseStartedMs", -1)).put("phaseWaitMs", reply.getLong("failurePhaseWaitMs", -1))
                        .put("target", reply.getString("failureTarget")).put("completed", reply.getInt("failureCompleted"))
                        .put("nonce", reply.getString("nonce")).put("rootRef", reply.getString("rootRef")).put("processInstance", reply.getString("processInstance")));
                barrier(); // The timed-out draw finishes and releases its late bitmap before recovery.
                recover(capture, ctor, slow, root);
                report.put("drawRecovery", true);
                report.put("passed", true);
            } catch (Throwable e) {
                try { report.put("passed", false).put("error", e.toString()); } catch (Exception ignored) { }
            }
            try (FileOutputStream output = new FileOutputStream(new File(activity.getFilesDir(), "capture-failure-probe.json"))) {
                output.write(report.toString().getBytes(StandardCharsets.UTF_8));
            } catch (Exception e) { android.util.Log.e("InspectorProbe", "Failure probe report", e); }
        }, "capture-failure-probe").start();
    }

    private static JSONObject timeout(Method capture, Constructor<?> ctor, View view, View root, String expected) throws Exception {
        try { capture.invoke(null, view, root, false, ctor.newInstance(), false); }
        catch (InvocationTargetException e) {
            Throwable error = e.getCause();
            if (!error.getClass().getSimpleName().equals("CaptureTaskTimeout")) throw e;
            Field phase = error.getClass().getDeclaredField("phase"), wait = error.getClass().getDeclaredField("waitMs"), ref = error.getClass().getDeclaredField("target");
            Field started = error.getClass().getDeclaredField("phaseStartedMs"), phaseWait = error.getClass().getDeclaredField("phaseWaitMs");
            started.setAccessible(true); phaseWait.setAccessible(true);
            phase.setAccessible(true); wait.setAccessible(true); ref.setAccessible(true);
            Method timing = error.getClass().getDeclaredMethod("timing"); timing.setAccessible(true);
            if (!expected.equals(phase.get(error)) || wait.getLong(error) < 3000 || wait.getLong(error) > 65000)
                throw new IllegalStateException("Unexpected diagnostic " + phase.get(error));
            return new JSONObject().put("phase", phase.get(error)).put("waitMs", wait.getLong(error)).put("target", ref.get(error))
                    .put("timing", timing.invoke(error))
                    .put("phaseStartedMs", started.getLong(error)).put("phaseWaitMs", phaseWait.getLong(error));
        }
        throw new IllegalStateException("Expected timeout was not raised");
    }

    private static void recover(Method capture, Constructor<?> ctor, View view, View root) throws Exception {
        Object frame = capture.invoke(null, view, root, false, ctor.newInstance(), false);
        if (frame == null) throw new IllegalStateException("Recovery returned empty frame");
        Field field = frame.getClass().getDeclaredField("bitmap"); field.setAccessible(true);
        Bitmap image = (Bitmap) field.get(frame);
        try { if (image.getWidth() <= 0 || image.getHeight() <= 0) throw new IllegalStateException("Invalid recovery bitmap"); }
        finally { image.recycle(); }
    }

    private static void barrier() throws Exception {
        CountDownLatch ready = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(ready::countDown);
        if (!ready.await(8, TimeUnit.SECONDS)) throw new IllegalStateException("Late UI task did not settle");
    }

    private static final class SlowView extends View {
        volatile boolean delayCapture, delayPrepare;
        SlowView(Activity activity) { super(activity); }
        @Override public boolean isHardwareAccelerated() {
            if (delayPrepare) for (StackTraceElement frame : Thread.currentThread().getStackTrace()) {
                if (frame.getClassName().equals("com.androiduiinspector.sdk.IsolatedCapture") && frame.getMethodName().equals("debugSnapshot")) {
                    delayPrepare = false;
                    try { Thread.sleep(4200); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    break;
                }
            }
            return super.isHardwareAccelerated();
        }
        @Override protected void onDraw(Canvas canvas) {
            if (delayCapture) for (StackTraceElement frame : Thread.currentThread().getStackTrace()) {
                if (frame.getClassName().equals("com.androiduiinspector.sdk.IsolatedCapture")) {
                    delayCapture = false;
                    try { Thread.sleep(4200); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    break;
                }
            }
            canvas.drawColor(0xff3399ff);
        }
    }
}

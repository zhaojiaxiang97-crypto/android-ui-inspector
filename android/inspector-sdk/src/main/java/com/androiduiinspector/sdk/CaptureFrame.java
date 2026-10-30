package com.androiduiinspector.sdk;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.Debug;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.SurfaceView;
import android.view.PixelCopy;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import static com.androiduiinspector.sdk.HierarchyTree.*;

/** UI frame capture, geometry consistency and bounded capture diagnostics. */
final class CaptureFrame {
    static final class CapturedFrame {
        final Bitmap bitmap;
        final int x, y;
        final JSONObject geometry;
        final CaptureGeometrySnapshot immutableGeometry;
        final long started, ended;
        CapturedFrame(Bitmap bitmap, int x, int y, JSONObject geometry) {
            this(bitmap, x, y, geometry, null, 0, 0);
        }
        CapturedFrame(Bitmap bitmap, int x, int y, JSONObject geometry, CaptureGeometrySnapshot immutableGeometry, long started, long ended) {
            this.bitmap = bitmap; this.x = x; this.y = y; this.geometry = geometry;
            this.immutableGeometry = immutableGeometry; this.started = started; this.ended = ended;
        }
    }

    static final class CaptureTiming {
        boolean shortParentDiagnostics;
        final long origin = System.nanoTime();
        final int[] queueBuckets = new int[5]; // <1 / <16 / <50 / <200 / >=200 ms.
        long queueMax;
        final ArrayList<long[]> slowTimes = new ArrayList<>();
        final ArrayList<String> slowRefs = new ArrayList<>();
        synchronized void queued(long nanos) {
            queueMax = Math.max(queueMax, nanos);
            long ms = nanos / 1_000_000;
            queueBuckets[ms < 1 ? 0 : ms < 16 ? 1 : ms < 50 ? 2 : ms < 200 ? 3 : 4]++;
        }
        synchronized void task(String ref, long posted, long entered, long ended) {
            long queueMs = (entered - posted) / 1_000_000, taskMs = (ended - entered) / 1_000_000;
            if (Math.max(queueMs, taskMs) < 50 || ref.length() > 256) return;
            long[] sample = { (posted - origin) / 1_000_000, queueMs, taskMs };
            int at = 0;
            while (at < slowTimes.size() && Math.max(slowTimes.get(at)[1], slowTimes.get(at)[2]) >= Math.max(queueMs, taskMs)) at++;
            if (at >= 8) return;
            slowTimes.add(at, sample); slowRefs.add(at, ref);
            if (slowTimes.size() > 8) { slowTimes.remove(8); slowRefs.remove(8); }
        }
        synchronized void taskReply(Bundle answer) {
            StringBuilder buckets = new StringBuilder(), slow = new StringBuilder();
            for (int n : queueBuckets) { if (buckets.length() > 0) buckets.append(';'); buckets.append(n); }
            for (int i = 0; i < slowTimes.size(); i++) {
                if (slow.length() > 0) slow.append(';');
                long[] t = slowTimes.get(i);
                slow.append(slowRefs.get(i)).append('|').append(t[0]).append('|').append(t[1]).append('|').append(t[2]);
            }
            answer.putString("uiQueueBuckets", buckets.toString());
            answer.putLong("uiQueueMaxMs", queueMax / 1_000_000);
            answer.putString("uiSlowTasks", slow.length() == 0 ? "-" : slow.toString());
        }
        final AtomicLong queue = new AtomicLong(), context = new AtomicLong(), draw = new AtomicLong(), verify = new AtomicLong();
        final AtomicLong snapshotPrepare = new AtomicLong(), snapshotInvoke = new AtomicLong();
        final AtomicLong uiTaskMax = new AtomicLong(), snapshotInvokeMax = new AtomicLong();
        // Thread-local usage indication, not process/GPU time. Worker totals overlap
        // UI work; accumulate nanos before rounding and omit unavailable counters.
        final AtomicLong contextCpu = new AtomicLong(), drawCpu = new AtomicLong(), verifyCpu = new AtomicLong();
        final AtomicLong encodeCpu = new AtomicLong(), geometryWriteCpu = new AtomicLong();
        final AtomicLong geometryJson = new AtomicLong(), geometryUtf8 = new AtomicLong(), geometryDisk = new AtomicLong();
        final AtomicLong geometryJsonCpu = new AtomicLong(), geometryUtf8Cpu = new AtomicLong(), geometryDiskCpu = new AtomicLong();
        final java.util.concurrent.atomic.AtomicBoolean cpuAvailable = new java.util.concurrent.atomic.AtomicBoolean(true);
        void addCpu(AtomicLong target, long started) {
            long ended = Debug.threadCpuTimeNanos();
            if (started < 0 || ended < started) cpuAvailable.set(false);
            else target.addAndGet(ended - started);
        }
        void reply(Bundle answer) {
            taskReply(answer);
            answer.putLong("uiQueueMs", queue.get() / 1_000_000);
            answer.putLong("geometryMs", context.get() / 1_000_000);
            answer.putLong("drawMs", draw.get() / 1_000_000);
            answer.putLong("verifyMs", verify.get() / 1_000_000);
            answer.putLong("snapshotPrepareMs", snapshotPrepare.get() / 1_000_000);
            answer.putLong("snapshotInvokeMs", snapshotInvoke.get() / 1_000_000);
            answer.putLong("uiTaskMaxMs", uiTaskMax.get() / 1_000_000);
            answer.putLong("snapshotInvokeMaxMs", snapshotInvokeMax.get() / 1_000_000);
            answer.putLong("geometryJsonMs", geometryJson.get() / 1_000_000);
            answer.putLong("geometryUtf8Ms", geometryUtf8.get() / 1_000_000);
            answer.putLong("geometryDiskMs", geometryDisk.get() / 1_000_000);
            // Omit unsupported counters rather than pretending the work consumed zero CPU.
            if (cpuAvailable.get()) {
                answer.putLong("geometryCpuMs", contextCpu.get() / 1_000_000);
                answer.putLong("drawCpuMs", drawCpu.get() / 1_000_000);
                answer.putLong("verifyCpuMs", verifyCpu.get() / 1_000_000);
                answer.putLong("encodeCpuMs", encodeCpu.get() / 1_000_000);
                answer.putLong("geometryWriteCpuMs", geometryWriteCpu.get() / 1_000_000);
                answer.putLong("geometryJsonCpuMs", geometryJsonCpu.get() / 1_000_000);
                answer.putLong("geometryUtf8CpuMs", geometryUtf8Cpu.get() / 1_000_000);
                answer.putLong("geometryDiskCpuMs", geometryDiskCpu.get() / 1_000_000);
            }
        }
    }

    static final class CapturePhase {
        final String name;
        final long started, entered, snapshotStarted, snapshotReturned;
        CapturePhase(String name, long started) { this(name, started, 0, 0, 0); }
        CapturePhase(String name, long started, long entered, long snapshotStarted, long snapshotReturned) {
            this.name = name; this.started = started; this.entered = entered;
            this.snapshotStarted = snapshotStarted; this.snapshotReturned = snapshotReturned;
        }
        static void enter(AtomicReference<CapturePhase> phase, String name) {
            if (phase == null) return;
            long now = System.nanoTime();
            phase.updateAndGet(old -> new CapturePhase(name, now, old.entered,
                    "draw-snapshot".equals(name) ? now : old.snapshotStarted, old.snapshotReturned));
        }
        static void taskEntered(AtomicReference<CapturePhase> phase, long entered) {
            phase.set(new CapturePhase("geometry", entered, entered, 0, 0));
        }
        static void snapshotReturned(AtomicReference<CapturePhase> phase) {
            if (phase == null) return;
            long now = System.nanoTime();
            phase.updateAndGet(old -> new CapturePhase(old.name, old.started, old.entered, old.snapshotStarted, now));
        }
    }

    static final class CaptureTaskTimeout extends IllegalStateException {
        final String phase, target;
        final long waitMs, phaseStartedMs, phaseWaitMs;
        final CapturePhase trace;
        final long posted;
        final long[] totals;
        CaptureTaskTimeout(CapturePhase phase, String target, long posted, long observed, CaptureTiming timing) {
            super("View capture timed out");
            this.phase = phase.name; this.target = target;
            waitMs = (observed - posted) / 1_000_000;
            phaseStartedMs = (phase.started - posted) / 1_000_000;
            phaseWaitMs = (observed - phase.started) / 1_000_000;
            this.trace = phase; this.posted = posted;
            this.totals = new long[] { timing.queue.get(), timing.context.get(), timing.draw.get(), timing.verify.get(),
                    timing.snapshotPrepare.get(), timing.snapshotInvoke.get() };
        }
        JSONObject timing() throws JSONException {
            JSONObject value = new JSONObject().put("version", 1).put("observedMs", waitMs);
            // Missing events stay missing. This immutable trace cannot be updated by a late UI task.
            if (trace.entered != 0) value.put("enteredMs", (trace.entered - posted) / 1_000_000);
            if (trace.snapshotStarted != 0) value.put("snapshotStartedMs", (trace.snapshotStarted - posted) / 1_000_000);
            if (trace.snapshotReturned != 0) value.put("snapshotReturnedMs", (trace.snapshotReturned - posted) / 1_000_000);
            String[] names = { "queueMs", "geometryMs", "drawMs", "verifyMs", "snapshotPrepareMs", "snapshotInvokeMs" };
            for (int i = 0; i < names.length; i++) value.put(names[i], totals[i] / 1_000_000);
            return value;
        }
    }

    /** Target plus at most eight ancestors; copy evidence within the owning UI task. */
    private static JSONArray captureParentContext(View view, View root) throws JSONException {
        return captureParentContext(view, root, null);
    }

    // Package access is used only by the debug-source-set probe contract.
    static JSONArray captureParentContext(View view, View root, JSONArray clips) throws JSONException {
        return captureParentContext(view, root, clips, null);
    }

    private static String frameRef(View view, IdentityHashMap<View, String> identities) {
        if (identities == null) return ref(view);
        String value = identities.get(view);
        if (value == null) {
            value = ref(view);
            if (identities.size() < 16) identities.put(view, value);
        }
        return value;
    }

    private static JSONArray captureParentContext(View view, View root, JSONArray clips,
            IdentityHashMap<View, String> identities) throws JSONException {
        JSONArray chain = new JSONArray();
        for (View current = view; current != null && chain.length() < 9;) {
            int[] point = new int[2];
            current.getLocationOnScreen(point);
            View parent = current.getParent() instanceof View ? (View) current.getParent() : null;
            float[] matrix = new float[9];
            current.getMatrix().getValues(matrix);
            JSONArray transform = new JSONArray();
            for (float value : matrix) transform.put((double) value);
            chain.put(new JSONArray().put(frameRef(current, identities)).put(parent == null ? "" : frameRef(parent, identities))
                    .put(point[0]).put(point[1]).put(current.getWidth()).put(current.getHeight())
                    .put(current.getScrollX()).put(current.getScrollY()).put((double) current.getAlpha())
                    .put(current.getVisibility()).put(transform)
                    .put(current instanceof ViewGroup && ((ViewGroup) current).getClipChildren())
                    .put(current instanceof ViewGroup && ((ViewGroup) current).getClipToPadding())
                    .put(current.getClipToOutline()));
            if (clips != null) clips.put(captureClipRow(current, identities));
            if (current == root) break;
            current = parent;
        }
        return chain;
    }

    static CapturedFrame captureFrameOnUiThread(View view, View root, boolean debugCanvas) throws Exception {
        return captureFrameOnUiThread(view, root, debugCanvas, false);
    }

    private static JSONArray captureScreenMatrix(View view) throws JSONException {
        if (Build.VERSION.SDK_INT < 29) return null;
        Matrix matrix = new Matrix();
        view.transformMatrixToGlobal(matrix);
        float[] values = new float[9];
        matrix.getValues(values);
        JSONArray result = new JSONArray();
        for (float value : values) {
            if (Float.isNaN(value) || Float.isInfinite(value)) return null;
            result.put((double) value);
        }
        return result;
    }

    private static JSONArray captureClipContext(View view, View root) throws JSONException {
        JSONArray result = new JSONArray();
        for (View current = view; current != null && result.length() < 9;) {
            result.put(captureClipRow(current));
            if (current == root) break;
            current = current.getParent() instanceof View ? (View) current.getParent() : null;
        }
        return result;
    }

    private static JSONObject captureClipRow(View view) throws JSONException {
        return captureClipRow(view, null);
    }

    private static JSONObject captureClipRow(View view, IdentityHashMap<View, String> identities) throws JSONException {
        Rect clip = view.getClipBounds();
        return new JSONObject().put("ref", frameRef(view, identities))
                .put("clipBounds", clip == null ? JSONObject.NULL : new JSONArray()
                        .put(clip.left).put(clip.top).put(clip.right).put(clip.bottom))
                .put("padding", new JSONArray().put(view.getPaddingLeft()).put(view.getPaddingTop())
                        .put(view.getPaddingRight()).put(view.getPaddingBottom()))
                .put("localToScreen", captureScreenMatrix(view));
    }

    static CapturedFrame captureFrameOnUiThread(View view, View root, boolean debugCanvas, boolean evidence) throws Exception {
        return captureFrameOnUiThread(view, root, debugCanvas, evidence, null);
    }

    static CapturedFrame captureFrameOnUiThread(View view, View root, boolean debugCanvas, boolean evidence, CaptureTiming timing) throws Exception {
        return captureFrameOnUiThread(view, root, debugCanvas, evidence, timing, false);
    }

    static CapturedFrame captureFrameOnUiThread(View view, View root, boolean debugCanvas, boolean evidence, CaptureTiming timing, boolean immutable) throws Exception {
        return captureFrameOnUiThread(view, root, debugCanvas, evidence, timing, immutable, null);
    }

    static CapturedFrame captureFrameOnUiThread(View view, View root, boolean debugCanvas, boolean evidence, CaptureTiming timing, boolean immutable, AtomicReference<CapturePhase> phase) throws Exception {
        return captureFrameOnUiThread(view, root, debugCanvas, evidence, timing, immutable, phase, false);
    }

    static CapturedFrame captureFrameOnUiThread(View view, View root, boolean debugCanvas, boolean evidence, CaptureTiming timing, boolean immutable, AtomicReference<CapturePhase> phase, boolean diagnostic) throws Exception {
        long contextStarted = System.nanoTime();
        long contextCpuStarted = timing == null ? 0 : Debug.threadCpuTimeNanos();
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Capture must run on UI thread");
        if (!view.isAttachedToWindow() || view.getRootView() != root || !view.isShown()) return null;
        int[] before = new int[2], after = new int[2];
        view.getLocationOnScreen(before);
        int width = view.getWidth(), height = view.getHeight();
        JSONArray clipContext = evidence && !immutable ? new JSONArray() : null;
        IdentityHashMap<View, String> identities = evidence ? new IdentityHashMap<>(16) : null;
        JSONArray context = evidence && !immutable ? captureParentContext(view, root, clipContext, identities) : null;
        CaptureGeometrySnapshot immutableContext = evidence && immutable ? CaptureGeometrySnapshot.read(view, root, identities) : null;
        if (diagnostic) {
            try { immutableContext = CaptureGeometrySnapshot.diagnostic(view, root); }
            catch (RuntimeException ignored) { /* Optional observations must not reject otherwise valid pixels. */ }
        }
        JSONArray screenMatrix = clipContext == null ? null : clipContext.getJSONObject(0).optJSONArray("localToScreen");
        if (timing != null) {
            timing.addCpu(timing.contextCpu, contextCpuStarted);
            timing.context.addAndGet(System.nanoTime() - contextStarted);
        }
        long drawStarted = SystemClock.uptimeMillis();
        CapturePhase.enter(phase, "draw");
        long drawNanos = System.nanoTime();
        long drawCpuStarted = timing == null ? 0 : Debug.threadCpuTimeNanos();
        Bitmap bitmap;
        long[] snapshotPhases = timing == null ? null : new long[2];
        try { bitmap = debugCanvas ? IsolatedCapture.debugSnapshot(view, snapshotPhases, phase) : IsolatedCapture.own(view); }
        finally {
            if (timing != null) {
                timing.addCpu(timing.drawCpu, drawCpuStarted);
                timing.draw.addAndGet(System.nanoTime() - drawNanos);
                timing.snapshotPrepare.addAndGet(snapshotPhases[0]);
                timing.snapshotInvoke.addAndGet(snapshotPhases[1]);
                timing.snapshotInvokeMax.accumulateAndGet(snapshotPhases[1], Math::max);
            }
        }
        if (bitmap == null) return null;
        CapturePhase.enter(phase, "verify");
        long verifyStarted = System.nanoTime();
        long verifyCpuStarted = timing == null ? 0 : Debug.threadCpuTimeNanos();
        boolean accepted = false;
        try {
            view.getLocationOnScreen(after);
            // Custom drawing may mutate layout synchronously; do not label those pixels as stable.
            if (!view.isAttachedToWindow() || view.getRootView() != root || !view.isShown()
                    || width != view.getWidth() || height != view.getHeight()
                    || before[0] != after[0] || before[1] != after[1]
                    || bitmap.getWidth() != width || bitmap.getHeight() != height) return null;
            long drawEnded = SystemClock.uptimeMillis();
            if (context != null && !matchesParentContext(view, root, context, clipContext, identities)) return null;
            if (immutableContext != null && !immutableContext.isDiagnosticOnly() && !immutableContext.matches(view, root, identities)) return null;
            JSONObject geometry = context == null ? null : new JSONObject().put("ref", frameRef(view, identities))
                    .put("rootRef", frameRef(root, identities)).put("started", drawStarted).put("ended", drawEnded)
                    .put("rootReached", context.getJSONArray(context.length() - 1).getString(0).equals(frameRef(root, identities)))
                    .put("chain", context).put("clipContext", clipContext);
            if (geometry != null && screenMatrix != null) geometry.put("localToScreen", screenMatrix)
                    .put("bitmapSpace", "view-local");
            accepted = true;
            return new CapturedFrame(bitmap, before[0], before[1], geometry, immutableContext, drawStarted, drawEnded);
        } finally {
            if (timing != null) {
                timing.addCpu(timing.verifyCpu, verifyCpuStarted);
                timing.verify.addAndGet(System.nanoTime() - verifyStarted);
            }
            if (!accepted) bitmap.recycle();
        }
    }

    private static boolean matchesParentContext(View view, View root, JSONArray chain, JSONArray clips) throws JSONException {
        return matchesParentContext(view, root, chain, clips, null);
    }

    private static boolean matchesParentContext(View view, View root, JSONArray chain, JSONArray clips,
            IdentityHashMap<View, String> identities) throws JSONException {
        if (clips == null || clips.length() != chain.length()) return false;
        View current = view;
        int[] point = new int[2];
        float[] matrix = new float[9];
        for (int i = 0; i < chain.length(); i++) {
            if (current == null) return false;
            JSONArray row = chain.getJSONArray(i);
            View parent = current.getParent() instanceof View ? (View) current.getParent() : null;
            current.getLocationOnScreen(point);
            current.getMatrix().getValues(matrix);
            ViewGroup group = current instanceof ViewGroup ? (ViewGroup) current : null;
            if (!row.getString(0).equals(frameRef(current, identities)) || !row.getString(1).equals(parent == null ? "" : frameRef(parent, identities))
                    || row.getInt(2) != point[0] || row.getInt(3) != point[1]
                    || row.getInt(4) != current.getWidth() || row.getInt(5) != current.getHeight()
                    || row.getInt(6) != current.getScrollX() || row.getInt(7) != current.getScrollY()
                    || row.getDouble(8) != (double) current.getAlpha() || row.getInt(9) != current.getVisibility()
                    || row.getBoolean(11) != (group != null && group.getClipChildren())
                    || row.getBoolean(12) != (group != null && group.getClipToPadding())
                    || row.getBoolean(13) != current.getClipToOutline()) return false;
            JSONArray expectedMatrix = row.getJSONArray(10);
            for (int j = 0; j < 9; j++) if (expectedMatrix.getDouble(j) != (double) matrix[j]) return false;
            if (!matchesClipRow(current, clips.getJSONObject(i), identities)) return false;
            if (current == root) return i == chain.length() - 1;
            current = parent;
        }
        return current == null || chain.length() == 9;
    }

    private static boolean matchesClipRow(View view, JSONObject clip) throws JSONException {
        return matchesClipRow(view, clip, null);
    }

    private static boolean matchesClipRow(View view, JSONObject clip, IdentityHashMap<View, String> identities) throws JSONException {
        if (!clip.getString("ref").equals(frameRef(view, identities))) return false;
        Rect bounds = view.getClipBounds();
        JSONArray expected = clip.optJSONArray("clipBounds");
        if ((bounds == null) != (expected == null)) return false;
        if (bounds != null && (expected.getInt(0) != bounds.left || expected.getInt(1) != bounds.top
                || expected.getInt(2) != bounds.right || expected.getInt(3) != bounds.bottom)) return false;
        JSONArray padding = clip.getJSONArray("padding");
        return padding.getInt(0) == view.getPaddingLeft() && padding.getInt(1) == view.getPaddingTop()
                && padding.getInt(2) == view.getPaddingRight() && padding.getInt(3) == view.getPaddingBottom()
                && matchesScreenMatrix(view, clip.optJSONArray("localToScreen"));
    }

    private static boolean matchesScreenMatrix(View view, JSONArray expected) throws JSONException {
        if (Build.VERSION.SDK_INT < 29) return expected == null;
        Matrix matrix = new Matrix();
        view.transformMatrixToGlobal(matrix);
        float[] values = new float[9];
        matrix.getValues(values);
        for (float value : values) if (Float.isNaN(value) || Float.isInfinite(value)) return expected == null;
        if (expected == null || expected.length() != 9) return false;
        for (int i = 0; i < 9; i++) if (expected.getDouble(i) != (double) values[i]) return false;
        return true;
    }

    /** Geometry and pixels belong to one UI task, not the earlier selection pass. */
    static CapturedFrame captureFrame(View view, View root, boolean evidence, CaptureTiming timing) throws Exception {
        return captureFrame(view, root, evidence, timing, false);
    }

    static CapturedFrame captureFrame(View view, View root, boolean evidence, CaptureTiming timing, boolean immutable) throws Exception {
        return captureFrame(view, root, evidence, timing, immutable, null);
    }

    static CapturedFrame captureFrame(View view, View root, boolean evidence, CaptureTiming timing, boolean immutable, VisibleTreeGuard guard) throws Exception {
        final Object lock = new Object();
        final boolean[] abandoned = { false };
        AtomicReference<CapturedFrame> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        long posted = System.nanoTime();
        AtomicReference<CapturePhase> phase = new AtomicReference<>(new CapturePhase("ui-queue", posted));
        if (!new Handler(Looper.getMainLooper()).post(() -> {
            long taskStarted = System.nanoTime();
            synchronized (lock) { if (abandoned[0]) return; CapturePhase.taskEntered(phase, taskStarted); }
            timing.queue.addAndGet(taskStarted - posted);
            timing.queued(taskStarted - posted);
            Bitmap bitmap = null;
            try {
                if (guard != null) guard.verify(view, root, ref(view), ref(root), "before");
                long checkStarted = System.nanoTime();
                long checkCpuStarted = Debug.threadCpuTimeNanos();
                boolean qualified = evidence && supportsRectangleContext(view, root);
                timing.addCpu(timing.contextCpu, checkCpuStarted);
                timing.context.addAndGet(System.nanoTime() - checkStarted);
                CapturedFrame frame = captureFrameOnUiThread(view, root, true, qualified, timing, immutable, phase,
                        timing.shortParentDiagnostics && evidence && !qualified && immutable);
                if (frame != null) bitmap = frame.bitmap;
                // Self-drawing can mutate layout synchronously. Keep ownership until rechecked.
                if (guard != null) guard.verify(view, root, ref(view), ref(root), "after");
                if (frame == null) return;
                synchronized (lock) {
                    if (!abandoned[0]) {
                        result.set(frame);
                        bitmap = null; // Ownership passes to the encoder.
                    }
                }
            } catch (Throwable error) {
                failure.set(error);
            } finally {
                if (bitmap != null) bitmap.recycle();
                timing.uiTaskMax.accumulateAndGet(System.nanoTime() - taskStarted, Math::max);
                timing.task(ref(view), posted, taskStarted, System.nanoTime());
                ready.countDown();
            }
        })) throw new IllegalStateException("View capture could not reach UI thread");
        try {
            if (!ready.await(3, TimeUnit.SECONDS)) throw new CaptureTaskTimeout(phase.get(), ref(view), posted, System.nanoTime(), timing);
            if (failure.get() != null) throw new IllegalStateException("View capture failed", failure.get());
            return result.get();
        } catch (Exception error) {
            synchronized (lock) {
                abandoned[0] = true;
                CapturedFrame late = result.getAndSet(null);
                if (late != null) late.bitmap.recycle();
            }
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            throw error;
        }
    }

    static boolean customDispatchDraw(Class<?> type) {
        for (Class<?> current = type; current != View.class && current != ViewGroup.class; current = current.getSuperclass()) {
            try { current.getDeclaredMethod("dispatchDraw", Canvas.class); return true; }
            catch (NoSuchMethodException ignored) { }
            catch (RuntimeException unknown) { return true; }
        }
        return false;
    }

    static boolean supportsRectangleContext(View view, View root) {
        View current = view;
        for (int depth = 0; current != null && depth < 9; depth++) {
            if (current.getClipToOutline()) return false;
            float[] matrix = new float[9];
            current.getMatrix().getValues(matrix);
            if (!(matrix[0] > 0 && matrix[4] > 0) || matrix[1] != 0 || matrix[3] != 0
                    || matrix[6] != 0 || matrix[7] != 0 || matrix[8] != 1) return false;
            if (depth > 0) {
                String name = current.getClass().getName();
                if (!name.equals("android.widget.FrameLayout") && !name.equals("android.widget.LinearLayout")
                        && !name.equals("android.widget.RelativeLayout") && !name.equals("android.widget.ScrollView")
                        && !name.equals("android.widget.HorizontalScrollView") && !name.equals("com.android.internal.policy.DecorView")) return false;
            }
            if (current == root) return true;
            current = current.getParent() instanceof View ? (View) current.getParent() : null;
        }
        return false;
    }

    static final class RefLayer {
        JSONObject geometry;
        final String ref;
        final SurfaceView surface;
        final char special;
        final boolean pure;
        final int x, y;
        Bitmap bitmap;
        String failure;
        RefLayer(String ref, String failure, char special) { this(ref, failure, special, false); }
        RefLayer(String ref, String failure, char special, boolean pure) {
            this.ref = ref;
            this.surface = null;
            this.special = special;
            this.pure = pure;
            this.x = 0;
            this.y = 0;
            this.failure = failure;
        }
        RefLayer(String ref, Bitmap bitmap, int x, int y, char special) {
            this.ref = ref;
            this.surface = null;
            this.special = special;
            this.pure = false;
            this.x = x;
            this.y = y;
            this.bitmap = bitmap;
        }
        RefLayer(String ref, SurfaceView surface, int x, int y) {
            this.ref = ref;
            this.surface = surface;
            this.special = 'S';
            this.pure = false;
            this.x = x;
            this.y = y;
        }
    }

    static void copySurfaceLayer(RefLayer layer) {
        if (Build.VERSION.SDK_INT < 24) {
            layer.failure = "系统版本不支持独立缓冲采集";
            return;
        }
        Bitmap bitmap = Bitmap.createBitmap(layer.surface.getWidth(), layer.surface.getHeight(), Bitmap.Config.ARGB_8888);
        CountDownLatch copied = new CountDownLatch(1);
        int[] status = new int[1];
        try {
            PixelCopy.request(layer.surface, bitmap, (result) -> { status[0] = result; copied.countDown(); }, new Handler(Looper.getMainLooper()));
        } catch (Throwable error) {
            bitmap.recycle();
            layer.failure = "缓冲层读取失败";
            return;
        }
        try {
            if (!copied.await(2, TimeUnit.SECONDS)) {
                bitmap.recycle();
                layer.failure = "缓冲层未在限定时间内返回画面";
                return;
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            bitmap.recycle();
            layer.failure = "缓冲层读取失败";
            return;
        }
        if (status[0] != PixelCopy.SUCCESS) {
            bitmap.recycle();
            layer.failure = "缓冲层读取失败";
            return;
        }
        layer.bitmap = bitmap;
    }
}

package com.androiduiinspector.sdk;

import android.app.Activity;
import android.app.Application;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Debug;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.SurfaceView;
import android.view.TextureView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.DataOutputStream;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.HashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.lsposed.hiddenapibypass.HiddenApiBypass;
import static com.androiduiinspector.sdk.HierarchyTree.*;
import static com.androiduiinspector.sdk.CaptureFrame.*;
import static com.androiduiinspector.sdk.CaptureOutput.*;

/** Serialized capture work; the Provider owns authorization, lifecycle and request locking. */
final class HierarchyCapture {
    private final String processInstance;
    private final CaptureOutput output;
    // Callable is available on API 21; java.util.function.Supplier would require API 24.
    private final java.util.concurrent.Callable<Activity> resumed;
    private final ThreadLocal<TreeQueueDiagnostics.Task> treeQueueTask;
    private final TreeQueueDiagnostics.Sink notifyTreeReady;

    HierarchyCapture(String processInstance, java.util.concurrent.Callable<Activity> resumed,
            ThreadLocal<TreeQueueDiagnostics.Task> treeQueueTask, TreeQueueDiagnostics.Sink notifyTreeReady) {
        this.processInstance = processInstance;
        this.output = new CaptureOutput(processInstance);
        this.resumed = resumed;
        this.treeQueueTask = treeQueueTask;
        this.notifyTreeReady = notifyTreeReady;
    }

    Bundle readBranchGeometry(Application app, String arg, Bundle extras) {
        Bundle answer = new Bundle();
        String nonce = extras == null ? null : extras.getString("nonce");
        if (nonce == null || !nonce.matches("[0-9a-f]{16}") || arg == null || arg.length() > 9000) {
            answer.putString("error", "Invalid branch geometry request"); return answer;
        }
        String[] path = arg.split(";", -1);
        HashSet<String> unique = new HashSet<>();
        if (path.length < 2 || path.length > 33) {
            answer.putString("error", "Branch geometry path limit exceeded"); return answer;
        }
        for (String ref : path) if (ref.length() > 256 || !ref.matches("[\\w.$]+@[0-9a-f]{1,8}") || !unique.add(ref)) {
            answer.putString("error", "Invalid branch geometry identity"); return answer;
        }
        AtomicReference<BranchGeometry.Snapshot> copied = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        java.util.concurrent.atomic.AtomicBoolean abandoned = new java.util.concurrent.atomic.AtomicBoolean();
        CountDownLatch ready = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            if (abandoned.get()) { ready.countDown(); return; }
            try {
                Activity activity = resumed.call();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                BranchGeometry.Snapshot snapshot = BranchGeometry.read(root, path);
                if (resumed.call() != activity || activity.getWindow().getDecorView() != root || !root.isAttachedToWindow())
                    throw new IllegalStateException("Branch geometry window changed");
                if (!abandoned.get()) copied.set(snapshot);
            } catch (Throwable error) { failure.set(error); }
            finally { ready.countDown(); }
        });
        try {
            if (!ready.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("Branch geometry UI task timed out");
            if (failure.get() != null) throw new IllegalStateException(failure.get().toString());
            BranchGeometry.Snapshot snapshot = copied.get();
            if (snapshot == null) throw new IllegalStateException("Branch geometry unavailable");
            byte[] data = snapshot.json().put("nonce", nonce).put("packageName", app.getPackageName())
                .put("pid", Process.myPid()).put("processInstance", processInstance)
                .put("rootRef", path[0]).put("branchRef", path[path.length - 1]).toString().getBytes(StandardCharsets.UTF_8);
            if (data.length > 48_000) throw new IllegalStateException("Branch geometry byte limit exceeded");
            answer.putString("result", "ok");
            answer.putString("data", Base64.encodeToString(data, Base64.NO_WRAP));
        } catch (Exception error) {
            abandoned.set(true);
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            answer.putString("error", String.valueOf(error));
        }
        return answer;
    }

    /** Builds the hierarchy JSON on the main thread and publishes it atomically. */
    JSONObject writeTreeFile(Application app, String fileName) throws Exception {
        TreeQueueDiagnostics.Task diagnostic = treeQueueTask.get();
        long posted = SystemClock.elapsedRealtime();
        java.util.concurrent.atomic.AtomicLong entered = new java.util.concurrent.atomic.AtomicLong(-1);
        java.util.concurrent.atomic.AtomicLong ended = new java.util.concurrent.atomic.AtomicLong(-1);
        java.util.concurrent.FutureTask<JSONObject> task = new java.util.concurrent.FutureTask<>(() -> {
            if (diagnostic != null) diagnostic.entered();
            entered.set(SystemClock.elapsedRealtime());
            try {
                Activity activity = resumed.call();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                if (!root.isAttachedToWindow()) throw new IllegalStateException("Window is detached");
                return captureTree(app, root, processInstance);
            } finally {
                ended.set(SystemClock.elapsedRealtime());
                if (diagnostic != null) diagnostic.ended();
            }
        });
        Handler handler = new Handler(Looper.getMainLooper());
        if (diagnostic != null) diagnostic.posted();
        if (!handler.post(task)) throw new IllegalStateException("Main queue unavailable");
        JSONObject data;
        try {
            data = task.get(3, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException error) {
            throw new IllegalStateException("View tree timed out");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw error;
        } catch (java.util.concurrent.ExecutionException error) {
            throw new IllegalStateException(error.getCause().toString());
        } finally {
            // Do not interrupt an Android UI thread. Cancel queued work and discard a
            // running task's late result; only this caller publishes the private file.
            task.cancel(false);
            handler.removeCallbacks(task);
            if (diagnostic != null) diagnostic.settle();
            android.util.Log.d("InspectorTree", "posted=" + posted + " entered=" + entered.get()
                    + " ended=" + ended.get() + " settled=" + SystemClock.elapsedRealtime());
        }
        // ponytail: stringify off the main thread; serializing a large tree costs seconds and used to sit inside the 3 s main-thread budget.
        long encodingStarted = SystemClock.elapsedRealtime();
        byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 4_000_000) throw new IllegalStateException("View tree exceeds 4 MB");
        File file = new File(app.getNoBackupFilesDir(), fileName);
        File pending = new File(app.getNoBackupFilesDir(), fileName + ".tmp");
        try (FileOutputStream stream = new FileOutputStream(pending)) {
            stream.write(bytes);
        }
        if (!pending.renameTo(file)) throw new IllegalStateException("Could not publish View tree");
        android.util.Log.d("InspectorTree", "posted=" + posted + " encodingStarted=" + encodingStarted
                + " published=" + SystemClock.elapsedRealtime() + " bytes=" + bytes.length);
        return data;
    }

    Bundle captureOwn(Application app, String wanted) {
        return captureView(app, wanted, "inspector-own-image.png", 20_000_000, 4_000_000, false);
    }

    Bundle captureStyle(String wanted) {
        Bundle answer = new Bundle();
        if (wanted == null || wanted.length() > 256 || !wanted.matches("[\\w.$]+@[0-9a-f]{1,8}")) {
            answer.putString("error", "Invalid View identity");
            return answer;
        }
        AtomicReference<Bundle> data = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        if (!new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Activity activity = resumed.call();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                if (!root.isAttachedToWindow()) throw new IllegalStateException("Window is detached");
                View target = findUnique(root, wanted);
                if (target == null) throw new IllegalStateException("View is missing");
                Bundle style = new Bundle();
                style.putString("result", "ok");
                style.putString("processInstance", processInstance);
                style.putString("rootRef", ref(root));
                style.putString("ref", wanted);
                int[] position = new int[2];
                target.getLocationOnScreen(position);
                style.putInt("x", position[0]);
                style.putInt("y", position[1]);
                style.putInt("width", target.getWidth());
                style.putInt("height", target.getHeight());
                Drawable background = target.getBackground();
                if (background != null) {
                    style.putString("backgroundType", background.getClass().getName());
                    Integer color = null;
                    if (background instanceof ColorDrawable) color = ((ColorDrawable) background).getColor();
                    else if (Build.VERSION.SDK_INT >= 24 && background instanceof GradientDrawable
                            && ((GradientDrawable) background).getColor() != null) {
                        android.content.res.ColorStateList colors = ((GradientDrawable) background).getColor();
                        color = colors.getColorForState(target.getDrawableState(), colors.getDefaultColor());
                    }
                    if (color != null) style.putString("backgroundColor", String.format(java.util.Locale.ROOT, "#%08X", color));
                }
                if (target instanceof TextView) {
                    TextView text = (TextView) target;
                    style.putString("textColor", String.format(java.util.Locale.ROOT, "#%08X", text.getCurrentTextColor()));
                    style.putFloat("textSizePx", text.getTextSize());
                }
                style.putLong("capturedAtMillis", System.currentTimeMillis());
                data.set(style);
            } catch (Throwable error) {
                failure.set(error);
            } finally {
                ready.countDown();
            }
        })) {
            answer.putString("error", "UI thread is unavailable");
            return answer;
        }
        try {
            if (!ready.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("View style timed out");
            if (failure.get() != null) throw new IllegalStateException(failure.get().toString());
            return data.get();
        } catch (Exception error) {
            answer.putString("error", error.getMessage());
            return answer;
        }
    }

    private static final class VisibleLayer {
        final View view;
        final String ref;
        final boolean inViewport;
        final long visibleArea;
        VisibleLayer(View view, boolean inViewport, long visibleArea) {
            this.view = view;
            this.ref = ref(view);
            this.inViewport = inViewport;
            this.visibleArea = visibleArea;
        }
    }

    private static final int MAX_PIPELINE_DEPTH = 4;

    /** Validate live window state on its owning thread, including the final capture check. */
    private void verifyCaptureRoot(View expected) throws Exception {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        Runnable check = () -> {
            try {
                Activity activity = resumed.call();
                if (activity == null || expected == null || activity.getWindow().getDecorView() != expected
                        || !expected.isAttachedToWindow()) throw new IllegalStateException("Activity changed during capture");
            } catch (Throwable error) { failure.set(error); }
            finally { ready.countDown(); }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) check.run();
        else if (!new Handler(Looper.getMainLooper()).post(check)) throw new IllegalStateException("Window verification could not reach UI thread");
        if (!ready.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("Window verification timed out");
        if (failure.get() != null) throw new IllegalStateException("Window verification failed", failure.get());
    }

    /** Target plus at most eight ancestors; no business text, listeners or arbitrary getters. */

    // Read both bounded chains in one walk; never retain live View state across UI tasks.

    // Immutable identity only, scoped to one UI task. Never reuse geometry or View state.

    /** Public API on Android 10+: includes ancestors, scroll and window offsets. */

    /** Compare the bounded snapshots without serializing their JSON on the UI thread. */

    // Compare native matrix values directly; no temporary JSON array after drawing.

    /** Geometry and pixels belong to one UI task, not the earlier selection pass. */

    // Do not serialize two full ancestor chains for contexts the renderer explicitly cannot use.
    // Called on the UI thread; accepted contexts still receive the before/after consistency check.

    Bundle captureVisible(Application app, String nonce, Bundle extras) {
        Bundle answer = new Bundle();
        VisibleTreeGuard treeGuard = null;
        boolean geometryRequested = extras != null && extras.getBoolean("geometryFile", false);
        GeometryRecords geometry = new GeometryRecords();
        if (nonce != null && !nonce.matches("[0-9a-f]{16}")) {
            answer.putString("error", "Invalid capture nonce");
            return answer;
        }
        String priorityRef = extras == null ? null : extras.getString("priorityViewRef");
        if (priorityRef != null && !priorityRef.matches("[\\w.$]+@[0-9a-fA-F]{1,8}")) {
            answer.putString("error", "Invalid priority View identity");
            return answer;
        }
        // Merged capture: write the hierarchy first so the desktop can adopt it while the
        // layers render; the layer request itself is unchanged and independent of the tree.
        if (extras != null && extras.getBoolean("withTree", false) && nonce != null) {
            android.util.Log.d("InspectorTree", "request=" + nonce + " phase=merged-tree pid=" + Process.myPid()
                    + " started=" + SystemClock.elapsedRealtime());
            try {
                treeGuard = new VisibleTreeGuard(writeTreeFile(app, "inspector-tree-" + nonce + ".json"));
                answer.putString("tree", "ok");
                notifyTreeReady.write(nonce);
            } catch (Exception error) {
                answer.putString("tree", "failed");
                String reason = error instanceof InterruptedException ? "interrupted"
                        : "View tree timed out".equals(error.getMessage()) ? "ui-timeout"
                        : "Main queue unavailable".equals(error.getMessage()) ? "ui-unavailable" : null;
                if (reason != null) {
                    // A busy UI queue is not a missing feature. Do not queue selection or
                    // drawing after this failure, or invite another classic tree request.
                    answer.putString("treeFailure", reason);
                    answer.putString("nonce", nonce);
                    answer.putString("processInstance", processInstance);
                    answer.putString("error", error.toString());
                    return answer;
                }
                // Other failures keep the independent-layer/legacy compatibility path.
            } finally {
                android.util.Log.d("InspectorTree", "request=" + nonce + " phase=merged-tree settled=" + SystemClock.elapsedRealtime());
            }
        }
        File file = new File(app.getNoBackupFilesDir(), "inspector-visible-layers.bin");
        File pending = new File(app.getNoBackupFilesDir(), "inspector-visible-layers.bin.tmp");
        file.delete();
        pending.delete();
        AtomicReference<ArrayList<VisibleLayer>> selected = new AtomicReference<>();
        AtomicReference<String> pureRefs = new AtomicReference<>("-");
        AtomicReference<View> selectedRoot = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Activity activity = resumed.call();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                if (!root.isAttachedToWindow()) throw new IllegalStateException("Window is detached");
                Field flags = null, overlay = null;
                for (Field field : HiddenApiBypass.getInstanceFields(View.class)) {
                    if ("mPrivateFlags".equals(field.getName())) flags = field;
                    if ("mOverlay".equals(field.getName())) overlay = field;
                }
                if (flags == null) throw new IllegalStateException("View draw flags unavailable");
                flags.setAccessible(true);
                try { if (overlay != null) overlay.setAccessible(true); }
                catch (RuntimeException unavailable) { overlay = null; }
                ArrayList<VisibleLayer> result = new ArrayList<>();
                StringBuilder pure = new StringBuilder();
                HashMap<Class<?>, Boolean> customDraw = new HashMap<>();
                ArrayDeque<View> queue = new ArrayDeque<>();
                queue.add(root);
                int visited = 0;
                while (!queue.isEmpty()) {
                    if (++visited > MAX_NODES) throw new IllegalStateException("View tree exceeds node budget");
                    View view = queue.removeFirst();
                    if (view.getVisibility() != View.VISIBLE || view.getAlpha() <= 0) continue;
                    int width = view.getWidth(), height = view.getHeight();
                    if (width > 0 && height > 0) {
                        if ((flags.getInt(view) & 0x80) == 0) {
                            if ((long) width * height <= 4_000_000) {
                                Rect visibleRect = new Rect();
                                boolean inViewport = view.getGlobalVisibleRect(visibleRect);
                                long visibleArea = inViewport ? (long) visibleRect.width() * visibleRect.height() : 0;
                                result.add(new VisibleLayer(view, inViewport, visibleArea));
                            }
                        } else if (overlay != null && !(view instanceof SurfaceView) && !(view instanceof TextureView)
                                && !customDraw.computeIfAbsent(view.getClass(), CaptureFrame::customDispatchDraw)) {
                            try {
                                if (overlay.get(view) == null) {
                                    String identity = ref(view);
                                    // ponytail: bounded hint list; omitted refs use the existing JDWP fallback.
                                    if (identity.length() <= 256 && pure.length() + identity.length() + 1 <= 16_000) {
                                        if (pure.length() > 0) pure.append(';');
                                        pure.append(identity);
                                    }
                                }
                            } catch (IllegalAccessException ignored) { }
                        }
                    }
                    if (view instanceof ViewGroup) {
                        ViewGroup group = (ViewGroup) view;
                        for (int i = 0; i < group.getChildCount(); i++) queue.addLast(group.getChildAt(i));
                    }
                }
                Collections.sort(result, (left, right) -> {
                    boolean leftSelected = priorityRef != null && priorityRef.equals(left.ref);
                    boolean rightSelected = priorityRef != null && priorityRef.equals(right.ref);
                    if (leftSelected != rightSelected) return leftSelected ? -1 : 1;
                    if (left.inViewport != right.inViewport) return left.inViewport ? -1 : 1;
                    return left.inViewport ? Long.compare(left.visibleArea, right.visibleArea) : 0;
                });
                selectedRoot.set(root);
                selected.set(result);
                pureRefs.set(pure.length() == 0 ? "-" : pure.toString());
            } catch (Throwable error) {
                failure.set(error);
            } finally {
                ready.countDown();
            }
        });
        long started = SystemClock.uptimeMillis();
        ExecutorService encoders = null;
        HashSet<Bitmap> pendingBitmaps = new HashSet<>();
        int count = 0;
        CaptureTiming captureTiming = new CaptureTiming();
        captureTiming.shortParentDiagnostics = extras != null && extras.getBoolean("shortParentDiagnostics", false);
        try {
            if (!ready.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("View selection timed out");
            if (failure.get() != null) throw new IllegalStateException(failure.get().toString());
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            int empty = 0;
            StringBuilder specialRefs = new StringBuilder();
            long renderMs = 0;
            AtomicLong geometryWriteNanos = new AtomicLong();
            AtomicLong encodeMs = new AtomicLong();
            boolean webpLossless = Build.VERSION.SDK_INT >= 30;
            // ponytail: render and encode used to run back-to-back in one loop; a bounded two-worker
            // pipeline now overlaps WEBP/PNG compression with the next View capture, while the ordered
            // writer keeps the streaming file and its digest identical to the serial loop.
            encoders = Executors.newFixedThreadPool(2, runnable -> {
                Thread thread = new Thread(runnable, "inspector-encode");
                thread.setDaemon(true);
                return thread;
            });
            ArrayDeque<Future<VisibleRecord>> inFlight = new ArrayDeque<>();
            try (DataOutputStream output = new DataOutputStream(new BufferedOutputStream(
                    new DigestOutputStream(new FileOutputStream(pending), digest), CAPTURE_OUTPUT_BUFFER_BYTES))) {
                output.writeLong(nonce == null ? 0 : Long.parseUnsignedLong(nonce, 16)); // Request identity in the DDMS header.
                for (VisibleLayer layer : selected.get()) {
                    if (SystemClock.uptimeMillis() - started > 60_000) throw new IllegalStateException("Visible capture time budget exceeded");
                    char special = layer.view instanceof SurfaceView ? 'S' : layer.view instanceof TextureView ? 'T' : '-';
                    if (special != '-') {
                        if (specialRefs.length() > 6000) throw new IllegalStateException("Too many special Views");
                        if (specialRefs.length() > 0) specialRefs.append(';');
                        specialRefs.append(special).append(':').append(layer.ref);
                    }
                    long imageStarted = SystemClock.uptimeMillis();
                    CapturedFrame frame = captureFrame(layer.view, selectedRoot.get(), geometryRequested && special == '-', captureTiming, true, treeGuard);
                    renderMs += SystemClock.uptimeMillis() - imageStarted;
                    if (frame == null) {
                        empty++; continue;
                    }
                    boolean handedOff = false;
                    try {
                        while (inFlight.size() >= MAX_PIPELINE_DEPTH) count += writeVisibleRecord(output, inFlight.pollFirst(), geometry);
                        registerPendingBitmap(pendingBitmaps, frame.bitmap);
                        inFlight.addLast(encoders.submit(() -> {
                            if (!claimPendingBitmap(pendingBitmaps, frame.bitmap))
                                throw new IllegalStateException("Visible capture cancelled before encoding");
                            // Bitmap ownership/recycling stays in the encoder. Only immutable capture
                            // evidence moves here; the worker never reads live View properties.
                            return encodeFrame(frame, layer.ref, webpLossless, encodeMs, captureTiming, geometryWriteNanos);
                        }));
                        handedOff = true;
                    } finally {
                        if (!handedOff) {
                            claimPendingBitmap(pendingBitmaps, frame.bitmap);
                            frame.bitmap.recycle();
                        }
                    }
                }
                while (!inFlight.isEmpty()) count += writeVisibleRecord(output, inFlight.pollFirst(), geometry);
                output.writeByte(2);
            }
            verifyCaptureRoot(selectedRoot.get());
            if (pending.length() > 64_000_000 || !pending.renameTo(file)) throw new IllegalStateException("Visible capture file could not be published");
            answer.putString("result", "ok");
            if (nonce != null) answer.putString("nonce", nonce);
            answer.putString("processInstance", processInstance);
            answer.putString("rootRef", ref(selectedRoot.get()));
            if (geometryRequested) {
                long fileStarted = System.nanoTime();
                long fileCpuStarted = Debug.threadCpuTimeNanos();
                this.output.writeGeometryFile(app, nonce, ref(selectedRoot.get()), geometry.finish(), answer, captureTiming);
                captureTiming.addCpu(captureTiming.geometryWriteCpu, fileCpuStarted);
                geometryWriteNanos.addAndGet(System.nanoTime() - fileStarted);
            }
            answer.putInt("count", count);
            answer.putInt("selected", selected.get().size());
            answer.putInt("empty", empty);
            answer.putString("specialRefs", specialRefs.length() == 0 ? "-" : specialRefs.toString());
            answer.putString("pureRefs", pureRefs.get());
            answer.putLong("renderMs", renderMs);
            captureTiming.reply(answer);
            answer.putLong("geometryWriteMs", geometryWriteNanos.get() / 1_000_000);
            answer.putLong("encodeMs", encodeMs.get());
            answer.putLong("durationMs", SystemClock.uptimeMillis() - started);
            answer.putLong("bytes", file.length());
            StringBuilder sha256 = new StringBuilder(64);
            for (byte value : digest.digest()) sha256.append(String.format("%02x", value & 0xff));
            answer.putString("sha256", sha256.toString());
        } catch (Throwable error) {
            file.delete();
            answer.putString("error", error.toString());
            VisibleTreeGuard.Changed changed = VisibleTreeGuard.changed(error);
            if (changed != null && treeGuard != null) {
                answer.putString("failureKind", "stale-tree");
                answer.putString("failureTarget", changed.target);
                answer.putString("failureGeometry", changed.geometry);
                answer.putInt("failureCompleted", count);
                answer.putInt("failureSelected", selected.get() == null ? 0 : selected.get().size());
                captureTiming.taskReply(answer);
                if (nonce != null) answer.putString("nonce", nonce);
                answer.putString("processInstance", processInstance);
                answer.putString("rootRef", treeGuard.rootRef);
            }
            if (error instanceof CaptureTaskTimeout) {
                captureTiming.taskReply(answer);
                CaptureTaskTimeout timeout = (CaptureTaskTimeout) error;
                answer.putString("failurePhase", timeout.phase);
                answer.putString("failureTarget", timeout.target);
                answer.putLong("failureWaitMs", timeout.waitMs);
                answer.putLong("failurePhaseStartedMs", timeout.phaseStartedMs);
                answer.putLong("failurePhaseWaitMs", timeout.phaseWaitMs);
                answer.putInt("failureCompleted", count);
                // Diagnostic serialization must not replace the original timeout or authorize pixels.
                try { answer.putString("failureTiming", timeout.timing().toString()); }
                catch (JSONException ignored) { }
                if (nonce != null) answer.putString("nonce", nonce);
                answer.putString("processInstance", processInstance);
                answer.putString("rootRef", ref(selectedRoot.get()));
            }
        } finally {
            if (encoders != null) encoders.shutdownNow();
            recyclePendingBitmaps(pendingBitmaps);
            pending.delete();
        }
        return answer;
    }

    Bundle captureRefs(Application app, String arg, Bundle extras) {
        Bundle answer = new Bundle();
        final boolean debugCanvas = extras != null && extras.getBoolean("debugCanvas", false);
        if (arg == null || arg.length() > 12_000) {
            answer.putString("error", "Invalid ref list");
            return answer;
        }
        String[] refs = arg.split(";", -1);
        if (refs.length < 1 || refs.length > 80) {
            answer.putString("error", "Ref batch supports 1-80 Views");
            return answer;
        }
        if (debugCanvas && refs.length != 1) {
            answer.putString("error", "Debug canvas supports one text leaf");
            return answer;
        }
        HashSet<String> unique = new HashSet<>();
        for (String ref : refs) {
            if (ref.length() > 256 || !ref.matches("[\\w.$]+@[0-9a-f]{1,8}") || !unique.add(ref)) {
                answer.putString("error", "Invalid or duplicate View identity");
                return answer;
            }
        }
        String nonce = extras == null ? null : extras.getString("nonce");
        final boolean geometryEvidence = extras != null && (extras.getBoolean("geometryEvidence", false) || extras.getBoolean("geometryFile", false));
        if (geometryEvidence && refs.length > 8 && !extras.getBoolean("geometryFile", false)) {
            answer.putString("error", "Geometry evidence supports at most 8 Views");
            return answer;
        }
        if (nonce != null && !nonce.matches("[0-9a-f]{16}")) {
            answer.putString("error", "Invalid capture nonce");
            return answer;
        }
        File file = new File(app.getNoBackupFilesDir(), "inspector-ref-layers.bin");
        File pending = new File(app.getNoBackupFilesDir(), "inspector-ref-layers.bin.tmp");
        file.delete();
        pending.delete();
        AtomicReference<ArrayList<RefLayer>> selected = new AtomicReference<>();
        AtomicReference<View> selectedRoot = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Activity activity = resumed.call();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                if (!root.isAttachedToWindow()) throw new IllegalStateException("Window is detached");
                Field flags = null, overlay = null;
                for (Field field : HiddenApiBypass.getInstanceFields(View.class)) {
                    if ("mPrivateFlags".equals(field.getName())) flags = field;
                    if ("mOverlay".equals(field.getName())) overlay = field;
                }
                if (flags == null) throw new IllegalStateException("View draw flags unavailable");
                flags.setAccessible(true);
                try { if (overlay != null) overlay.setAccessible(true); }
                catch (RuntimeException unavailable) { overlay = null; }
                ArrayList<RefLayer> result = new ArrayList<>();
                int[] position = new int[2];
                for (String wanted : refs) {
                    View view = findUnique(root, wanted);
                    if (view == null || !view.isShown() || view.getWidth() <= 0 || view.getHeight() <= 0) {
                        result.add(new RefLayer(wanted, "控件缺失或不可见", '-'));
                        continue;
                    }
                    view.getLocationOnScreen(position);
                    int x = position[0], y = position[1];
                    if (debugCanvas && (!(view instanceof android.widget.TextView) || view instanceof ViewGroup))
                        throw new IllegalStateException("Debug canvas requires a text leaf");
                    if (debugCanvas && !view.isHardwareAccelerated())
                        throw new IllegalStateException("Debug canvas requires hardware acceleration");
                    if (view instanceof SurfaceView) {
                        // ponytail: surface buffers are copied after the main-thread pass; a live frame is required.
                        result.add(new RefLayer(wanted, (SurfaceView) view, x, y));
                        continue;
                    }
                    if (view instanceof TextureView) {
                        Bitmap frame = ((TextureView) view).getBitmap(view.getWidth(), view.getHeight());
                        result.add(frame == null ? new RefLayer(wanted, "缓冲层读取失败", 'T') : new RefLayer(wanted, frame, x, y, 'T'));
                        continue;
                    }
                    if ((flags.getInt(view) & 0x80) != 0 && (overlay == null || overlay.get(view) == null) && !customDispatchDraw(view.getClass())) {
                        result.add(new RefLayer(wanted, "结构容器，系统跳过自身绘制", '-', true));
                        continue;
                    }
                    CapturedFrame own = captureFrameOnUiThread(view, root, debugCanvas, geometryEvidence);
                    RefLayer layer = own == null ? new RefLayer(wanted, "位图缺失或绘制期间位置/尺寸变化", '-') : new RefLayer(wanted, own.bitmap, own.x, own.y, '-');
                    if (own != null) layer.geometry = own.geometry;
                    result.add(layer);
                }
                selectedRoot.set(root);
                selected.set(result);
            } catch (Throwable error) {
                failure.set(error);
            } finally {
                ready.countDown();
            }
        });
        long started = SystemClock.uptimeMillis();
        ExecutorService encoders = null;
        try {
            if (!ready.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("View selection timed out");
            if (failure.get() != null) throw new IllegalStateException(failure.get().toString());
            StringBuilder special = new StringBuilder();
            StringBuilder pure = new StringBuilder();
            StringBuilder failures = new StringBuilder();
            StringBuilder empties = new StringBuilder();
            for (RefLayer layer : selected.get()) {
                if (layer.surface != null) copySurfaceLayer(layer);
                if (layer.pure) {
                    if (pure.length() > 0) pure.append(';');
                    pure.append(layer.ref);
                } else if (layer.failure != null) {
                    if (failures.length() > 0) failures.append(';');
                    failures.append(layer.ref).append(':').append(layer.failure);
                } else {
                    boolean blank;
                    try { blank = isEmptyBitmap(layer.bitmap); }
                    catch (Throwable unreadable) {
                        layer.bitmap.recycle();
                        layer.bitmap = null;
                        layer.geometry = null; // No image is published for this failed alpha check.
                        layer.failure = "Bitmap alpha inspection failed; empty state is unknown";
                        if (failures.length() > 0) failures.append(';');
                        failures.append(layer.ref).append(':').append(layer.failure);
                        continue;
                    }
                    if (layer.special != '-' && blank) {
                        layer.bitmap.recycle();
                        layer.bitmap = null;
                        if (failures.length() > 0) failures.append(';');
                        failures.append(layer.ref).append(':').append(BUFFER_EMPTY_REASON);
                        continue;
                    }
                    if (layer.special != '-') {
                        if (special.length() > 0) special.append(';');
                        special.append(layer.special).append(':').append(layer.ref);
                    }
                    if (blank) {
                        if (empties.length() > 0) empties.append(';');
                        empties.append(layer.ref);
                    }
                }
                if (special.length() > 6_000 || pure.length() > 16_000 || failures.length() > 16_000 || empties.length() > 16_000)
                    throw new IllegalStateException("Ref capture result exceeds budget");
            }
            long renderMs = SystemClock.uptimeMillis() - started;
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            // Match the legacy text refresh's PNG decode path, including browser alpha rounding.
            boolean webpLossless = !debugCanvas && Build.VERSION.SDK_INT >= 30;
            int count = 0;
            AtomicLong encodeMs = new AtomicLong();
            // ponytail: same bounded render/encode pipeline as capture-visible; records keep the request order.
            encoders = Executors.newFixedThreadPool(2, runnable -> {
                Thread thread = new Thread(runnable, "inspector-encode");
                thread.setDaemon(true);
                return thread;
            });
            ArrayDeque<Future<VisibleRecord>> inFlight = new ArrayDeque<>();
            try (DataOutputStream output = new DataOutputStream(new BufferedOutputStream(
                    new DigestOutputStream(new FileOutputStream(pending), digest), CAPTURE_OUTPUT_BUFFER_BYTES))) {
                output.writeLong(nonce == null ? 0 : Long.parseUnsignedLong(nonce, 16));
                for (RefLayer layer : selected.get()) {
                    if (layer.bitmap == null) continue;
                    if (SystemClock.uptimeMillis() - started > 60_000) throw new IllegalStateException("Ref capture time budget exceeded");
                    while (inFlight.size() >= MAX_PIPELINE_DEPTH) count += writeVisibleRecord(output, inFlight.pollFirst());
                    Bitmap bitmap = layer.bitmap;
                    String ref = layer.ref;
                    int x = layer.x, y = layer.y;
                    inFlight.addLast(encoders.submit(() -> encodeVisibleLayer(bitmap, ref, x, y, webpLossless, encodeMs)));
                }
                while (!inFlight.isEmpty()) count += writeVisibleRecord(output, inFlight.pollFirst());
                output.writeByte(2);
            } finally {
                encoders.shutdownNow();
            }
            verifyCaptureRoot(selectedRoot.get());
            if (pending.length() > 64_000_000 || !pending.renameTo(file)) throw new IllegalStateException("Ref capture file could not be published");
            answer.putString("result", "ok");
            if (nonce != null) answer.putString("nonce", nonce);
            answer.putString("processInstance", processInstance);
            answer.putString("rootRef", ref(selectedRoot.get()));
            answer.putInt("count", count);
            answer.putInt("requested", refs.length);
            if (debugCanvas) answer.putBoolean("debugCanvas", true);
            answer.putString("special", special.length() == 0 ? "-" : special.toString());
            answer.putString("pure", pure.length() == 0 ? "-" : pure.toString());
            answer.putString("failures", failures.length() == 0 ? "-" : failures.toString());
            answer.putString("empty", empties.length() == 0 ? "-" : empties.toString());
            if (geometryEvidence) {
                JSONArray evidence = new JSONArray();
                for (RefLayer layer : selected.get()) if (layer.geometry != null) evidence.put(layer.geometry);
                byte[] json = evidence.toString().getBytes(StandardCharsets.UTF_8);
                if (refs.length > 8) this.output.writeGeometryFile(app, nonce, ref(selectedRoot.get()), new String(json, StandardCharsets.UTF_8), answer);
                else {
                    if (json.length > 48_000) throw new IllegalStateException("Geometry evidence exceeds budget");
                    answer.putString("geometryEvidence", Base64.encodeToString(json, Base64.NO_WRAP));
                }
            }
            answer.putLong("renderMs", renderMs);
            answer.putLong("encodeMs", encodeMs.get());
            answer.putLong("durationMs", SystemClock.uptimeMillis() - started);
            answer.putLong("bytes", file.length());
            StringBuilder sha256 = new StringBuilder(64);
            for (byte value : digest.digest()) sha256.append(String.format("%02x", value & 0xff));
            answer.putString("sha256", sha256.toString());
        } catch (Throwable error) {
            file.delete();
            answer.putString("error", error.toString());
        } finally {
            if (encoders != null) encoders.shutdownNow();
            pending.delete();
        }
        return answer;
    }

    private static final String BUFFER_EMPTY_REASON = "独立缓冲区返回全透明像素，未确认取得视频画面；不代表控件本身没有内容";

    Bundle captureOwn(Application app, String wanted, String fileName, int byteLimit, int pixelLimit) {
        return captureView(app, wanted, fileName, byteLimit, pixelLimit, false);
    }

    Bundle captureView(Application app, String wanted, String fileName, int byteLimit, int pixelLimit, boolean group) {
        Bundle answer = new Bundle();
        if (wanted == null || wanted.length() > 256 || !wanted.matches("[\\w.$]+@[0-9a-f]{1,8}")) {
            answer.putString("error", "Invalid View identity");
            return answer;
        }
        CompletableFuture<Bitmap> image = new CompletableFuture<>();
        AtomicReference<String> rootRef = new AtomicReference<>();
        boolean posted = new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Activity activity = resumed.call();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                if (!root.isAttachedToWindow()) throw new IllegalStateException("Window is detached");
                rootRef.set(ref(root));
                View target = findUnique(root, wanted);
                if (target == null || !target.isShown()) throw new IllegalStateException("View is missing or not shown");
                if ((long) target.getWidth() * target.getHeight() > pixelLimit) throw new IllegalStateException("View exceeds capture pixel budget");
                image.complete(group ? IsolatedCapture.group(target) : IsolatedCapture.own(target));
            } catch (Throwable error) {
                image.completeExceptionally(error);
            }
        });
        if (!posted) {
            answer.putString("error", "UI thread is unavailable");
            return answer;
        }
        Bitmap bitmap = null;
        try {
            try {
                bitmap = image.get(3, TimeUnit.SECONDS);
            } catch (java.util.concurrent.TimeoutException error) {
                image.thenAccept(Bitmap::recycle);
                throw new IllegalStateException("View image timed out", error);
            }
            String sha256 = writePng(app, fileName, bitmap, byteLimit);
            answer.putString("result", "ok");
            answer.putString("ref", wanted);
            answer.putString("processInstance", processInstance);
            answer.putString("rootRef", rootRef.get());
            answer.putString("sha256", sha256);
            answer.putInt("width", bitmap.getWidth());
            answer.putInt("height", bitmap.getHeight());
        } catch (Exception error) {
            Throwable cause = error.getCause() != null ? error.getCause() : error;
            answer.putString("error", cause.toString());
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
        return answer;
    }

    Bundle captureOwnBatch(Application app, String arg) {
        // ponytail: cap each batch at 2 million pixels; revisit only after real-page memory checks.
        Bundle answer = new Bundle();
        if (arg == null || arg.length() > 2600) {
            answer.putString("error", "Invalid batch request");
            return answer;
        }
        String[] refs = arg.split(",", -1);
        HashSet<String> unique = new HashSet<>();
        if (refs.length < 1 || refs.length > 10) {
            answer.putString("error", "Batch supports 1–10 Views");
            return answer;
        }
        for (String ref : refs) {
            if (ref.length() > 256 || !ref.matches("[\\w.$]+@[0-9a-f]{1,8}") || !unique.add(ref)) {
                answer.putString("error", "Invalid or duplicate View identity");
                return answer;
            }
        }
        File directory = app.getNoBackupFilesDir();
        File manifest = new File(directory, "inspector-own-batch.json");
        File pending = new File(directory, "inspector-own-batch.json.tmp");
        boolean complete = false;
        try {
            manifest.delete();
            JSONArray images = new JSONArray();
            long started = SystemClock.uptimeMillis();
            int pixels = 0;
            String rootRef = null;
            for (int index = 0; index < refs.length; index++) {
                if (SystemClock.uptimeMillis() - started > 5000) throw new IllegalStateException("Batch time budget exceeded");
                String name = "inspector-own-batch-" + index + ".png";
                Bundle one = captureOwn(app, refs[index], name, 1_000_000, Math.min(1_000_000, 2_000_000 - pixels));
                if (!"ok".equals(one.getString("result"))) throw new IllegalStateException(one.getString("error", "View capture failed"));
                if (rootRef != null && !rootRef.equals(one.getString("rootRef"))) throw new IllegalStateException("Activity root changed during batch");
                rootRef = one.getString("rootRef");
                pixels += one.getInt("width") * one.getInt("height");
                if (SystemClock.uptimeMillis() - started > 5000) throw new IllegalStateException("Batch time budget exceeded");
                JSONObject item = new JSONObject();
                item.put("ref", refs[index]);
                item.put("file", name);
                item.put("sha256", one.getString("sha256"));
                item.put("width", one.getInt("width"));
                item.put("height", one.getInt("height"));
                images.put(item);
            }
            JSONObject report = new JSONObject();
            report.put("version", 1);
            report.put("processInstance", processInstance);
            report.put("rootRef", rootRef);
            report.put("capturedAtMillis", System.currentTimeMillis());
            report.put("images", images);
            byte[] bytes = report.toString().getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream stream = new FileOutputStream(pending)) {
                stream.write(bytes);
            }
            if (!pending.renameTo(manifest)) throw new IllegalStateException("Batch manifest could not be published");
            answer.putInt("count", refs.length);
            answer.putString("processInstance", processInstance);
            answer.putString("rootRef", rootRef);
            StringBuilder sha256 = new StringBuilder(64);
            for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) sha256.append(String.format("%02x", value & 0xff));
            answer.putString("sha256", sha256.toString());
            answer.putString("result", "ok");
            complete = true;
        } catch (Exception error) {
            answer.putString("error", error.getMessage());
        } finally {
            pending.delete();
            if (!complete) manifest.delete();
            for (int index = complete ? refs.length : 0; index < 10; index++) new File(directory, "inspector-own-batch-" + index + ".png").delete();
        }
        return answer;
    }
}

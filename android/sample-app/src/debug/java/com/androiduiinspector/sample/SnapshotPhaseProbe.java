package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Picture;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.text.Spanned;
import android.widget.TextView;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import org.json.JSONArray;
import org.json.JSONObject;
import org.lsposed.hiddenapibypass.HiddenApiBypass;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;

/** Disposable sample-only profiling. Never installed in a business SDK or Release build. */
final class SnapshotPhaseProbe {
    private final Activity activity;
    private final View root;
    private final List<View> views = new ArrayList<>();
    private final IdentityHashMap<View, byte[]> pixels = new IdentityHashMap<>();
    private final JSONArray rounds = new JSONArray();
    private final boolean batchMode;
    private final boolean conservative;
    private final String mutation;
    private Runnable restoreMutation;
    private JSONObject pixelMismatch;
    private final boolean fullPipeline;
    private final boolean optimized;
    private final boolean hashComparison, chunkedHash;
    private final String strategyComparison;
    private final String cadenceComparison;
    private int workPosts, workDelayMs;
    private long sliceStarted;
    private SnapshotTiming sliceTiming = new SnapshotTiming();
    private SnapshotTiming originalSliceTiming = new SnapshotTiming(), batchSliceTiming = new SnapshotTiming();
    private boolean capturingBatch;
    private final long[] waitNanos = new long[3]; // capacity, fill batch, final drain (wall time, not worker CPU)
    private long waitStarted, longestWaitNanos, scheduledAt, uiDelayNanos, maxUiDelayNanos;
    private int waitKind = -1, waitEpisodes;
    private boolean hashSelfTestPassed;
    private boolean timingSelfTestPassed;
    private boolean envelopeSelfTestPassed;
    private static final String[] OPERATION_KEYS = {"originalSnapshot", "originalReadback", "batchRecord", "atlasBitmap", "atlasReadback", "rawPixelHash"};
    private SnapshotTiming[] operations = newOperationTimings();
    private SnapshotPixelHash pixelHash = new SnapshotPixelHash(false);
    private SnapshotMemorySampler memory;
    private final int[] batchSizes = new int[9];
    private boolean pipelineReleased = true;
    private SnapshotPipeline pipeline;
    private final java.util.concurrent.ConcurrentHashMap<String, byte[]> encodedReferences = new java.util.concurrent.ConcurrentHashMap<>();
    private final long deadline = SystemClock.uptimeMillis() + 150_000;
    private Class<?> providerClass, canvasType;
    private Method getCanvas, createBitmap;
    private int round = -1, index, hardwareBitmaps, originalFallbacks;
    private long wallStarted;
    // preparation, canvas creation, command recording, bitmap conversion, invocation, CPU copy
    private long[] total = new long[6];

    private SnapshotPhaseProbe(Activity activity) {
        this.activity = activity;
        this.root = activity.getWindow().getDecorView();
        this.batchMode = activity.getIntent().getBooleanExtra("snapshotBatchProbe", false);
        this.conservative = activity.getIntent().getBooleanExtra("snapshotBatchConservative", false);
        this.fullPipeline = activity.getIntent().getBooleanExtra("snapshotFullPipeline", false);
        this.optimized = activity.getIntent().getBooleanExtra("snapshotPipelineOptimized", false);
        this.hashComparison = activity.getIntent().getBooleanExtra("snapshotHashComparison", false);
        this.chunkedHash = activity.getIntent().getBooleanExtra("snapshotChunkedHash", false);
        this.strategyComparison = activity.getIntent().getStringExtra("snapshotStrategyComparison");
        this.cadenceComparison = activity.getIntent().getStringExtra("snapshotCadenceComparison");
        if (strategyComparison != null && (!fullPipeline || !chunkedHash || optimized || hashComparison
                || !("fill".equals(strategyComparison) || "transfer".equals(strategyComparison))))
            throw new IllegalArgumentException("Strategy comparison requires an isolated pipeline strategy and chunked hash");
        if (cadenceComparison != null && (!fullPipeline || !conservative || !batchMode || !chunkedHash
                || optimized || hashComparison || strategyComparison != null
                || !("batch2".equals(cadenceComparison) || "yield1".equals(cadenceComparison))))
            throw new IllegalArgumentException("Cadence comparison requires a conservative pipeline and chunked hash");
        this.mutation = activity.getIntent().getStringExtra("snapshotBatchMutation");
    }

    static void start(Activity activity) {
        SnapshotPhaseProbe probe = new SnapshotPhaseProbe(activity);
        try {
            SnapshotPixelHash.selfTest(); probe.hashSelfTestPassed = true;
            SnapshotTiming.selfTest(); probe.timingSelfTestPassed = true;
            probe.canvasType = Class.forName("android.view.ViewDebug$CanvasProvider");
            probe.providerClass = Class.forName("android.view.ViewDebug$HardwareCanvasProvider");
            probe.getCanvas = HiddenApiBypass.getDeclaredMethod(probe.providerClass, "getCanvas", View.class, int.class, int.class);
            probe.createBitmap = HiddenApiBypass.getDeclaredMethod(probe.providerClass, "createBitmap");
            probe.getCanvas.setAccessible(true);
            probe.createBitmap.setAccessible(true);
            probe.collect(probe.root);
            if (probe.views.size() < 400) throw new IllegalStateException("Requires stress-rectangle with 400 drawable views");
            probe.wallStarted = SystemClock.uptimeMillis();
            if (probe.fullPipeline) probe.pipeline = new SnapshotPipeline(activity, probe.root, activity.getIntent().getStringExtra("probeToken"), probe.encodedReferences, probe.pixelHash, true);
            if (probe.fullPipeline) { probe.memory = new SnapshotMemorySampler(); probe.memory.begin(); }
            probe.postStep(0);
        } catch (Throwable failure) { probe.finish(failure); }
    }

    private void collect(View view) {
        long area = (long) view.getWidth() * view.getHeight();
        if (views.size() >= 500) throw new IllegalStateException("Probe view budget exceeded");
        if (view.isShown() && area > 0 && area <= 4_000_000
                && (!view.willNotDraw() || view.getBackground() != null)) views.add(view);
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) collect(group.getChildAt(i));
        }
    }

    private boolean measured() { return round == 1 || round == 2 || round == 5; }
    private boolean comparisonMode() { return strategyComparison != null || cadenceComparison != null; }
    private boolean batched() { return batchMode && (measured() || comparisonMode() && round >= 0) && !hashComparison; }
    private boolean fillBatch() { return cadenceComparison != null && round >= 0 || measured() && (optimized || "fill".equals(strategyComparison)); }
    private boolean transferBitmap() { return cadenceComparison != null && round >= 0 || measured() && (optimized || "transfer".equals(strategyComparison)); }
    private int batchLimit() { return !fullPipeline ? 8 : "batch2".equals(cadenceComparison) && measured() ? 2 : 4; }
    private int workDelay() { return "yield1".equals(cadenceComparison) && measured() ? 1 : 0; }

    private static SnapshotTiming[] newOperationTimings() {
        SnapshotTiming[] result = new SnapshotTiming[OPERATION_KEYS.length];
        for (int i = 0; i < result.length; i++) result[i] = new SnapshotTiming();
        return result;
    }

    private void postStep(int delayMs) {
        scheduledAt = System.nanoTime() + delayMs * 1_000_000L;
        root.postDelayed(this::step, delayMs);
    }

    private void waitFor(int kind) {
        if (waitKind != kind) {
            endWait(); waitKind = kind; waitStarted = System.nanoTime(); waitEpisodes++;
        }
        postStep(1);
    }

    private void endWait() {
        if (waitKind < 0) return;
        long elapsed = System.nanoTime() - waitStarted;
        waitNanos[waitKind] += elapsed;
        longestWaitNanos = Math.max(longestWaitNanos, elapsed);
        waitKind = -1;
    }

    private void step() {
        try {
            long delay = Math.max(0, System.nanoTime() - scheduledAt);
            uiDelayNanos += delay; maxUiDelayNanos = Math.max(maxUiDelayNanos, delay);
            if (activity.isFinishing() || !activity.hasWindowFocus() || !root.isAttachedToWindow() || SystemClock.uptimeMillis() > deadline)
                throw new IllegalStateException("Probe detached or exceeded deadline");
            if (fullPipeline && activity.getIntent().getBooleanExtra("snapshotPipelineCancel", false) && round == 1 && index >= 16)
                throw new IllegalStateException("Sample pipeline canceled");
            if (pipeline != null && !pipeline.ready()) { waitFor(index == views.size() ? 2 : 0); return; }
            if (index == views.size()) { advance(0); return; }
            View view = views.get(index);
            if (pipeline != null && fillBatch() && eligible(view) && pipeline.capacity() < 4) {
                waitFor(1); return; // Empty the bounded queue; never enlarge it to fill a batch.
            }
            endWait();
            sliceStarted = System.nanoTime();
            capturingBatch = batched() && (!conservative || eligible(view));
            if (capturingBatch) { stepBatch(); return; }
            if (batched()) originalFallbacks++;
            if (!view.isHardwareAccelerated() || !view.isShown()) throw new IllegalStateException("Hardware fixture changed");
            long[] timing = new long[6];
            String before = fullPipeline ? geometry(view) : null;
            JSONObject evidence = pipeline == null ? null : pipeline.captureGeometry(view);
            long prepared = System.nanoTime();
            Object provider = HiddenApiBypass.newInstance(providerClass);
            Object wrapped = provider;
            if (measured() && !batchMode) {
                final long[] recordingStart = {0};
                wrapped = Proxy.newProxyInstance(canvasType.getClassLoader(), new Class<?>[]{canvasType}, (proxy, method, args) -> {
                    long started = System.nanoTime();
                    if (method.getName().equals("getCanvas")) {
                        Object canvas = getCanvas.invoke(provider, args);
                        timing[1] += System.nanoTime() - started;
                        recordingStart[0] = System.nanoTime();
                        return canvas;
                    }
                    if (method.getName().equals("createBitmap")) {
                        if (recordingStart[0] == 0) throw new IllegalStateException("Canvas was not created");
                        timing[2] += started - recordingStart[0];
                        try { return createBitmap.invoke(provider); }
                        finally { timing[3] += System.nanoTime() - started; }
                    }
                    throw new UnsupportedOperationException(method.getName());
                });
            }
            timing[0] = System.nanoTime() - prepared;
            long invoked = System.nanoTime();
            Bitmap bitmap = (Bitmap) HiddenApiBypass.invoke(View.class, view, "createSnapshot", wrapped, true);
            timing[4] = System.nanoTime() - invoked;
            operations[0].record(invoked, invoked + timing[4], 0, SnapshotPipeline.ref(view), view.getWidth(), view.getHeight(), 1);
            if (bitmap == null) throw new IllegalStateException("Snapshot returned no bitmap");
            Bitmap readable = bitmap;
            try {
                if (bitmap.getConfig() == Bitmap.Config.HARDWARE) {
                    hardwareBitmaps++;
                    long copied = System.nanoTime();
                    readable = bitmap.copy(Bitmap.Config.ARGB_8888, false);
                    timing[5] = System.nanoTime() - copied;
                    operations[1].record(copied, copied + timing[5], 0, SnapshotPipeline.ref(view), view.getWidth(), view.getHeight(), 1);
                    if (readable == null) throw new IllegalStateException("CPU copy failed");
                }
                if (readable.getWidth() != view.getWidth() || readable.getHeight() != view.getHeight())
                    throw new IllegalStateException("Snapshot dimensions changed");
                checkPixels(view, readable);
                if (pipeline != null) {
                    if (!before.equals(geometry(view))) throw new IllegalStateException("Geometry changed during original capture");
                    boolean transfer = transferBitmap();
                    pipeline.submit(readable, evidence, pixels.get(view), transfer);
                    if (transfer) {
                        if (readable == bitmap) bitmap = null;
                        readable = null; // Encoder now owns the allocation.
                    }
                }
            } finally {
                if (readable != null && readable != bitmap) readable.recycle();
                if (bitmap != null) bitmap.recycle();
            }
            for (int i = 0; i < total.length; i++) total[i] += timing[i];
            advance(1);
        } catch (Throwable failure) { finish(failure); }
    }

    private void advance(int amount) throws Exception {
        if (amount > 0) {
            View first = views.get(index);
            long ended = System.nanoTime();
            String ref = SnapshotPipeline.ref(first);
            sliceTiming.record(sliceStarted, ended, 0, ref, first.getWidth(), first.getHeight(), amount);
            (capturingBatch ? batchSliceTiming : originalSliceTiming)
                    .record(sliceStarted, ended, 0, ref, first.getWidth(), first.getHeight(), amount);
        }
        index += amount;
        if (index == views.size()) {
            if (pipeline != null) {
                pipeline.beginTail();
                // End actual queue waiting before synchronous file finalization.
                if (pipeline.capacity() == 4) endWait();
            }
            JSONObject pipelineResult = pipeline == null ? null : pipeline.finish();
            if (pipeline != null && pipelineResult == null) { waitFor(2); return; }
            endWait();
            if (round == -1 && pipelineResult != null) envelopeSelfTestPassed = pipelineResult.getBoolean("envelopeVerified");
            if (round >= 0) {
                JSONObject result = new JSONObject().put("instrumented", measured()).put("count", index)
                        .put("hardwareBitmaps", hardwareBitmaps).put("batch", batched())
                        .put("originalFallbacks", originalFallbacks)
                        .put("fillBatch", fillBatch()).put("transferBitmap", transferBitmap())
                        .put("cadence", new JSONObject().put("batchLimit", batchLimit()).put("workDelayMs", workDelay())
                                .put("workPosts", workPosts).put("scheduledWorkDelayMs", workDelayMs).put("slice", sliceTiming.report())
                                .put("originalSlice", originalSliceTiming.report()).put("batchSlice", batchSliceTiming.report()))
                        .put("waiting", new JSONObject().put("capacityMs", waitNanos[0] / 1_000_000.0)
                                .put("fillMs", waitNanos[1] / 1_000_000.0).put("drainMs", waitNanos[2] / 1_000_000.0)
                                .put("episodes", waitEpisodes).put("longestMs", longestWaitNanos / 1_000_000.0)
                                .put("uiDelayMs", uiDelayNanos / 1_000_000.0).put("maxUiDelayMs", maxUiDelayNanos / 1_000_000.0))
                        .put("wallMs", SystemClock.uptimeMillis() - wallStarted);
                String[] keys = {"prepareMs", "canvasMs", "recordMs", "bitmapMs", "invokeMs", "cpuCopyMs"};
                for (int i = 0; i < keys.length; i++) result.put(keys[i], total[i] / 1_000_000.0);
                if (pipelineResult != null) result.put("pipeline", pipelineResult);
                if (memory != null) result.put("memory", memory.report());
                JSONObject operationReport = new JSONObject();
                for (int i = 0; i < operations.length; i++) operationReport.put(OPERATION_KEYS[i], operations[i].report());
                result.put("operations", operationReport);
                result.put("pixelHash", pixelHash.report());
                JSONArray histogram = new JSONArray(); for (int size : batchSizes) histogram.put(size);
                result.put("batchSizes", histogram);
                rounds.put(result);
            }
            index = 0;
            hardwareBitmaps = 0;
            originalFallbacks = 0;
            total = new long[6];
            operations = newOperationTimings();
            sliceTiming = new SnapshotTiming(); workPosts = workDelayMs = 0;
            originalSliceTiming = new SnapshotTiming(); batchSliceTiming = new SnapshotTiming();
            java.util.Arrays.fill(batchSizes, 0);
            java.util.Arrays.fill(waitNanos, 0);
            waitEpisodes = 0; longestWaitNanos = uiDelayNanos = maxUiDelayNanos = 0;
            wallStarted = SystemClock.uptimeMillis();
            if (++round == 6) { finish(null); return; }
            pixelHash = new SnapshotPixelHash(chunkedHash || hashComparison && measured());
            if (fullPipeline) pipeline = new SnapshotPipeline(activity, root, activity.getIntent().getStringExtra("probeToken"), encodedReferences, pixelHash, false);
            if (memory != null) memory.begin();
        }
        // Yield between layers/batches; never hold the main thread for an entire page.
        int delay = index > 0 ? workDelay() : 0;
        if (index > 0) { workPosts++; workDelayMs += delay; }
        postStep(delay);
    }

    private void checkPixels(View view, Bitmap readable) throws Exception {
        long started = System.nanoTime();
        byte[] digest = pixelHash.digest(readable);
        operations[5].record(started, System.nanoTime(), 0, SnapshotPipeline.ref(view), readable.getWidth(), readable.getHeight(), 1);
        byte[] expected = pixels.get(view);
        if (expected == null) pixels.put(view, digest);
        else if (!java.util.Arrays.equals(expected, digest)) {
            diagnosePixels(view, readable, expected);
            throw new IllegalStateException("Measured and original pixels differ: " + view.getClass().getName());
        }
    }

    /** On a failed disposable experiment only: verify the reference itself has not changed. */
    private void diagnosePixels(View view, Bitmap measured, byte[] expected) throws Exception {
        Object provider = HiddenApiBypass.newInstance(providerClass);
        Bitmap original = (Bitmap) HiddenApiBypass.invoke(View.class, view, "createSnapshot", provider, true);
        if (original == null) throw new IllegalStateException("Diagnostic reference returned no bitmap");
        Bitmap reference = null;
        try {
            reference = original.copy(Bitmap.Config.ARGB_8888, false);
            int width = measured.getWidth(), height = measured.getHeight();
            if (reference == null || reference.getWidth() != width || reference.getHeight() != height)
                throw new IllegalStateException("Diagnostic reference size changed");
            int[] before = new int[width * height], after = new int[before.length];
            reference.getPixels(before, 0, width, 0, 0, width, height);
            measured.getPixels(after, 0, width, 0, 0, width, height);
            ByteBuffer bytes = ByteBuffer.allocate(before.length * 4); bytes.asIntBuffer().put(before);
            int changed = 0, maxChannelDelta = 0, maxAlphaDelta = 0;
            int left = width, top = height, right = -1, bottom = -1;
            for (int i = 0; i < before.length; i++) {
                if (before[i] == after[i]) continue;
                changed++; left = Math.min(left, i % width); right = Math.max(right, i % width);
                top = Math.min(top, i / width); bottom = Math.max(bottom, i / width);
                maxAlphaDelta = Math.max(maxAlphaDelta, Math.abs((before[i] >>> 24) - (after[i] >>> 24)));
                for (int shift = 0; shift < 32; shift += 8)
                    maxChannelDelta = Math.max(maxChannelDelta, Math.abs(((before[i] >>> shift) & 255) - ((after[i] >>> shift) & 255)));
            }
            pixelMismatch = new JSONObject().put("class", view.getClass().getName())
                    .put("referenceStillMatches", java.util.Arrays.equals(expected, MessageDigest.getInstance("SHA-256").digest(bytes.array())))
                    .put("width", width).put("height", height).put("differentPixels", changed)
                    .put("maxChannelDelta", maxChannelDelta).put("maxAlphaDelta", maxAlphaDelta)
                    .put("left", left).put("top", top).put("right", right).put("bottom", bottom);
            pixelMismatch.put("renderVariants", renderVariants(view, before, width, height));
        } finally {
            if (reference != null) reference.recycle();
            original.recycle();
        }
    }

    /** Pinpoints recording vs atlas placement, without accepting even a one-channel difference. */
    private JSONArray renderVariants(View view, int[] reference, int width, int height) throws Exception {
        Picture source = new Picture();
        Object provider = Proxy.newProxyInstance(canvasType.getClassLoader(), new Class<?>[]{canvasType}, (proxy, method, args) -> {
            if (method.getName().equals("getCanvas")) return source.beginRecording((int) args[1], (int) args[2]);
            if (method.getName().equals("createBitmap")) { source.endRecording(); return null; }
            throw new UnsupportedOperationException(method.getName());
        });
        HiddenApiBypass.invoke(View.class, view, "createSnapshot", provider, true);
        JSONArray variants = new JSONArray();
        String[] names = {"same-size-origin", "padded-origin", "shifted-unclipped", "shifted-clipped"};
        for (int variant = 0; variant < names.length; variant++) {
            int offset = variant < 2 ? 0 : 2;
            Picture target = new Picture();
            Canvas canvas = target.beginRecording(width + (variant == 0 ? 0 : 4), height + (variant == 0 ? 0 : 4));
            canvas.translate(offset, offset);
            if (variant == 3) canvas.clipRect(0, 0, width, height);
            canvas.drawPicture(source); target.endRecording();
            Bitmap hardware = Bitmap.createBitmap(target), readable = null;
            try {
                readable = hardware.copy(Bitmap.Config.ARGB_8888, false);
                if (readable == null) throw new IllegalStateException("Variant readback failed");
                int[] pixels = new int[reference.length];
                readable.getPixels(pixels, 0, width, offset, offset, width, height);
                int changed = 0, maximum = 0;
                for (int i = 0; i < pixels.length; i++) {
                    if (pixels[i] == reference[i]) continue;
                    changed++;
                    for (int shift = 0; shift < 32; shift += 8)
                        maximum = Math.max(maximum, Math.abs(((pixels[i] >>> shift) & 255) - ((reference[i] >>> shift) & 255)));
                }
                variants.put(new JSONObject().put("variant", names[variant]).put("differentPixels", changed).put("maxChannelDelta", maximum));
            } finally {
                if (readable != null) readable.recycle();
                hardware.recycle();
            }
        }
        return variants;
    }

    /** Experimental allowlist, not a claim that every framework TextView is safe in production. */
    static boolean eligible(View view) {
        if (view.getClass() != TextView.class || view.getBackground() != null || view.getForeground() != null) return false;
        TextView text = (TextView) view;
        if (text.getText() instanceof Spanned || text.getShadowRadius() != 0 || text.getPaint().getShader() != null
                || text.getPaint().getColorFilter() != null || text.getPaint().getMaskFilter() != null
                || text.getPaint().getPathEffect() != null) return false;
        for (Drawable drawable : text.getCompoundDrawables()) if (drawable != null) return false;
        for (Drawable drawable : text.getCompoundDrawablesRelative()) if (drawable != null) return false;
        for (View current = view; current != null; current = current.getParent() instanceof View ? (View) current.getParent() : null) {
            if (current.getClipToOutline() || current.getClipBounds() != null || current.getAlpha() != 1f
                    || !current.getMatrix().isIdentity()) return false;
            if (current != view) {
                String name = current.getClass().getName();
                if (!name.equals("android.widget.FrameLayout") && !name.equals("android.widget.LinearLayout")
                        && !name.equals("com.android.internal.policy.DecorView")) return false;
            }
        }
        return true;
    }

    private static String geometry(View view) {
        StringBuilder stamp = new StringBuilder();
        for (View current = view; current != null; current = current.getParent() instanceof View ? (View) current.getParent() : null) {
            int[] position = new int[2]; current.getLocationOnScreen(position);
            Matrix matrix = new Matrix(); current.transformMatrixToGlobal(matrix);
            stamp.append(System.identityHashCode(current)).append(':').append(current.getWidth()).append(':').append(current.getHeight())
                    .append(':').append(position[0]).append(':').append(position[1]).append(':').append(current.getAlpha())
                    .append(':').append(current.getVisibility()).append(':').append(current.getScrollX()).append(':').append(current.getScrollY())
                    .append(':').append(matrix.toString()).append(':').append(current.getClipBounds())
                    .append(':').append(current.getPaddingLeft()).append(':').append(current.getPaddingTop())
                    .append(':').append(current.getPaddingRight()).append(':').append(current.getPaddingBottom())
                    .append(':').append(current.getClipToOutline());
            if (current instanceof ViewGroup) {
                ViewGroup group = (ViewGroup) current;
                stamp.append(':').append(group.getClipChildren()).append(':').append(group.getClipToPadding());
            }
        }
        return stamp.toString();
    }

    private static final class Slot {
        final View view;
        final int width, height, top;
        final String before;
        final Picture picture = new Picture();
        JSONObject evidence;
        Slot(View view, int top) {
            this.view = view; this.width = view.getWidth(); this.height = view.getHeight(); this.top = top;
            this.before = geometry(view);
        }
    }

    /** Each View records into its own Picture; an atlas is a transport, never a parent snapshot. */
    private void stepBatch() throws Exception {
        List<Slot> slots = new ArrayList<>();
        long recordNanos = 0;
        int atlasWidth = 0, atlasHeight = 0;
        int limit = pipeline == null ? 8 : Math.min(pipeline.capacity(), batchLimit());
        for (int i = index; i < views.size() && slots.size() < limit; i++) {
            View view = views.get(i);
            if (conservative && !eligible(view)) break; // Decide before recording; never retry a drawn custom view.
            int width = Math.max(atlasWidth, view.getWidth() + 4), height = atlasHeight + view.getHeight() + 4;
            if (width > 4096 || height > 4096 || (long) width * height > 4_000_000) {
                if (slots.isEmpty()) throw new IllegalStateException("Atlas pixel/dimension budget exceeded");
                break;
            }
            if (!view.isHardwareAccelerated() || !view.isShown()) throw new IllegalStateException("Batch fixture changed");
            Slot slot = new Slot(view, atlasHeight + 2);
            if (pipeline != null) slot.evidence = pipeline.captureGeometry(view);
            long started = System.nanoTime();
            final boolean[] ended = {false};
            Object provider = Proxy.newProxyInstance(canvasType.getClassLoader(), new Class<?>[]{canvasType}, (proxy, method, args) -> {
                if (method.getName().equals("getCanvas")) {
                    if ((int) args[1] != slot.width || (int) args[2] != slot.height) throw new IllegalStateException("Recording size differs");
                    return slot.picture.beginRecording(slot.width, slot.height);
                }
                if (method.getName().equals("createBitmap")) {
                    slot.picture.endRecording(); ended[0] = true;
                    if ("record-alpha".equals(mutation) && (!comparisonMode() || measured())) mutate(slot.view);
                    return null; // Sample only: postpone rasterization until the small batch is recorded.
                }
                throw new UnsupportedOperationException(method.getName());
            });
            Object returned = HiddenApiBypass.invoke(View.class, view, "createSnapshot", provider, true);
            long recorded = System.nanoTime() - started;
            operations[2].record(started, started + recorded, 0, SnapshotPipeline.ref(view), slot.width, slot.height, 1);
            total[2] += recorded; recordNanos += recorded;
            if (returned != null || !ended[0] || !slot.before.equals(geometry(view)))
                throw new IllegalStateException("Recording changed geometry or ignored deferred provider");
            slots.add(slot); atlasWidth = width; atlasHeight = height;
        }
        if (mutation != null && mutation.startsWith("after-") && (!comparisonMode() || measured())) mutate(slots.get(0).view);
        Picture atlas = new Picture();
        long generated = System.nanoTime();
        Canvas canvas = atlas.beginRecording(atlasWidth, atlasHeight);
        for (Slot slot : slots) {
            int saved = canvas.save();
            canvas.translate(2, slot.top);
            canvas.clipRect(0, 0, slot.width, slot.height);
            canvas.drawPicture(slot.picture);
            canvas.restoreToCount(saved);
        }
        atlas.endRecording();
        Bitmap hardware = Bitmap.createBitmap(atlas), readable = null;
        long generatedNanos = System.nanoTime() - generated;
        String batchRef = SnapshotPipeline.ref(slots.get(0).view);
        operations[3].record(generated, generated + generatedNanos, 0, batchRef, atlasWidth, atlasHeight, slots.size());
        total[3] += generatedNanos;
        hardwareBitmaps++;
        try {
            if (hardware.getConfig() != Bitmap.Config.HARDWARE) throw new IllegalStateException("Atlas is not hardware-backed");
            long copied = System.nanoTime();
            readable = hardware.copy(Bitmap.Config.ARGB_8888, false);
            long copyNanos = System.nanoTime() - copied;
            total[5] += copyNanos;
            operations[4].record(copied, copied + copyNanos, 0, batchRef, atlasWidth, atlasHeight, slots.size());
            if (readable == null) throw new IllegalStateException("Atlas readback failed");
            for (Slot slot : slots) {
                if (!slot.before.equals(geometry(slot.view))) throw new IllegalStateException("Geometry changed before batch readback finished");
                if ((readable.getPixel(0, slot.top) >>> 24) != 0 || (readable.getPixel(slot.width + 2, slot.top) >>> 24) != 0)
                    throw new IllegalStateException("Atlas gutter contains neighboring pixels");
                Bitmap crop = Bitmap.createBitmap(readable, 2, slot.top, slot.width, slot.height);
                try {
                    checkPixels(slot.view, crop);
                    if (pipeline != null) {
                        boolean transfer = transferBitmap();
                        pipeline.submit(crop, slot.evidence, pixels.get(slot.view), transfer);
                        if (transfer) crop = null;
                    }
                }
                finally { if (crop != null && crop != readable) crop.recycle(); }
            }
        } finally {
            if (readable != null) readable.recycle();
            hardware.recycle();
        }
        total[4] += recordNanos + generatedNanos;
        batchSizes[slots.size()]++;
        advance(slots.size());
    }

    /** Fault injection is sample-only and restored even when capture is rejected. */
    private void mutate(View target) {
        if (restoreMutation != null) return;
        if ("record-alpha".equals(mutation)) {
            float alpha = target.getAlpha();
            restoreMutation = () -> target.setAlpha(alpha);
            target.setAlpha(alpha == 1f ? 0.5f : 1f);
        } else if ("after-clip".equals(mutation)) {
            Rect clip = target.getClipBounds();
            restoreMutation = () -> target.setClipBounds(clip);
            target.setClipBounds(new Rect(0, 0, target.getWidth() - 1, target.getHeight()));
        } else if ("after-position".equals(mutation)) {
            float x = target.getTranslationX();
            restoreMutation = () -> target.setTranslationX(x);
            target.setTranslationX(x + 1);
        } else throw new IllegalArgumentException("Unknown sample mutation");
    }

    private void finish(Throwable failure) {
        try {
            if (pipeline != null) {
                pipeline.close(); pipelineReleased = pipeline.released();
                if (failure != null) pipeline.discard();
                pipeline = null;
            }
            if (restoreMutation != null) { restoreMutation.run(); restoreMutation = null; }
            if (memory != null) { memory.close(); memory = null; }
            JSONObject report = new JSONObject().put("passed", failure == null)
                    .put("probeToken", activity.getIntent().getStringExtra("probeToken"))
                    .put("sdkInt", android.os.Build.VERSION.SDK_INT).put("count", views.size())
                    .put("stableImages", pixels.size()).put("rounds", rounds);
            if (failure != null) report.put("error", failure.toString()).put("failedRound", round);
            if (pixelMismatch != null) report.put("pixelMismatch", pixelMismatch);
            report.put("batchMode", batchMode);
            report.put("conservative", conservative);
            report.put("fullPipeline", fullPipeline);
            report.put("optimized", optimized);
            report.put("strategyComparison", strategyComparison == null ? "none" : strategyComparison);
            report.put("cadenceComparison", cadenceComparison == null ? "none" : cadenceComparison);
            report.put("hashComparison", hashComparison).put("chunkedHash", chunkedHash).put("hashSelfTestPassed", hashSelfTestPassed);
            report.put("timingSelfTestPassed", timingSelfTestPassed);
            report.put("envelopeSelfTestPassed", envelopeSelfTestPassed);
            report.put("pipelineReleased", pipelineReleased);
            report.put("transformedFixture", activity.getIntent().getBooleanExtra("snapshotBatchTransforms", false));
            report.put("mutation", mutation).put("mutationRestored", restoreMutation == null);
            File directory = new File(activity.getFilesDir(), "isolation-probe");
            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Probe directory unavailable");
            try (FileOutputStream stream = new FileOutputStream(new File(directory, batchMode ? "snapshot-batches.json" : "snapshot-phases.json"))) {
                stream.write(report.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception error) { android.util.Log.e("SnapshotPhaseProbe", "Report failed", error); }
    }
}

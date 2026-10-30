package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.os.Debug;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.DataOutputStream;
import java.io.DataInputStream;
import java.io.FileInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Arrays;
import java.security.MessageDigest;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/** Sample-only load comparison using the SDK capture, encoder and image-stream writer. */
final class GeometryPipelineProbe {
    static void start(Activity activity) {
        View root = activity.getWindow().getDecorView();
        String token = activity.getIntent().getStringExtra("probeToken");
        boolean reverse = activity.getIntent().getBooleanExtra("geometryCandidateFirst", false);
        String pipelineCase = activity.getIntent().getStringExtra("geometryPipelineCase");
        boolean firstCapture = activity.getIntent().getBooleanExtra("geometryFirstCapture", false);
        int idleMillis = activity.getIntent().getIntExtra("geometryIdleMillis", 0);
        new Thread(() -> {
            JSONObject report = new JSONObject();
            try {
                report.put("probeToken", token);
                if (idleMillis != 0 && idleMillis != 40_000) throw new IllegalArgumentException("Invalid idle interval");
                if (firstCapture && !"original".equals(pipelineCase) && !"lightweight".equals(pipelineCase)
                        && !pipelineCase.startsWith("buffered-output-first-"))
                    throw new IllegalArgumentException("First capture needs one path");
                long idleStarted = System.nanoTime();
                if (idleMillis > 0) Thread.sleep(idleMillis);
                long idleNanos = System.nanoTime() - idleStarted;
                boolean safety = "lightweight-safety".equals(pipelineCase);
                boolean sdkProof = "sdk-geometry".equals(pipelineCase);
                boolean longClean = "continuous-long-clean".equals(pipelineCase);
                boolean matched = "continuous-matched-control".equals(pipelineCase) || "continuous-matched-stages".equals(pipelineCase)
                        || "continuous-pipeline-waits".equals(pipelineCase) || "continuous-pipeline-waits-control".equals(pipelineCase);
                boolean managed = "continuous-managed-control".equals(pipelineCase) || "continuous-managed-profile".equals(pipelineCase);
                boolean cpuControl = "continuous-cpu-control".equals(pipelineCase) || managed;
                boolean clean = "continuous-clean".equals(pipelineCase) || longClean || cpuControl || matched;
                boolean faultsOnly = "continuous-faults".equals(pipelineCase);
                boolean protocolOnly = "continuous-protocol".equals(pipelineCase);
                boolean preflightProtocol = "continuous-preflight-protocol".equals(pipelineCase);
                boolean preflightFaults = "continuous-preflight-faults".equals(pipelineCase);
                boolean protocolFaults = "continuous-protocol-faults".equals(pipelineCase);
                boolean softwareGate = "software-pixel-gate".equals(pipelineCase);
                boolean hardwareGate = "hardware-reuse-pixel-gate".equals(pipelineCase);
                boolean hardwareComparison = "hardware-reuse-comparison".equals(pipelineCase);
                boolean hardwareSafety = "hardware-reuse-safety".equals(pipelineCase);
                boolean hardwarePipeline = "hardware-pipeline-comparison".equals(pipelineCase);
                boolean outputExperiment = pipelineCase != null && pipelineCase.startsWith("buffered-output-");
                boolean formatExperiment = "format-cache-pipeline".equals(pipelineCase);
                boolean snapshotWaits = "snapshot-wait-diagnostic".equals(pipelineCase);
                boolean systemTrace = "snapshot-system-trace".equals(pipelineCase);
                boolean methodTrace = "snapshot-method-trace".equals(pipelineCase);
                boolean noPreflight = clean || faultsOnly || protocolOnly || protocolFaults || softwareGate || hardwareGate || hardwareComparison || hardwareSafety || hardwarePipeline || outputExperiment || formatExperiment || snapshotWaits || systemTrace || methodTrace;
                GeometryPipelineProbe probe = new GeometryPipelineProbe(activity, root, firstCapture || safety || sdkProof || noPreflight);
                if (sdkProof) {
                    report.put("passed", true).put("sdkGeometry", probe.verifySdkFrames());
                } else if (safety) {
                    report.put("passed", true).put("safety", probe.verifyLightCaptureFaults());
                } else {
                JSONArray rounds = new JSONArray();
                report.put("rounds", rounds); // Preserve completed rounds even if a later one fails.
                if (clean || faultsOnly || protocolOnly || preflightProtocol || preflightFaults || protocolFaults
                        || "continuous-preflight".equals(pipelineCase) || "continuous-fixtures".equals(pipelineCase)) {
                    report.put("setup", clean ? "none" : faultsOnly ? "faults-only" : protocolOnly ? "protocol-only"
                            : preflightProtocol ? "preflight-and-protocol" : preflightFaults ? "preflight-and-faults-only"
                            : protocolFaults ? "protocol-and-faults"
                            : "continuous-preflight".equals(pipelineCase) ? "preflight-only" : "preflight-and-faults");
                    if (protocolOnly || protocolFaults) probe.verifyImmutableProtocol(Class.forName("com.androiduiinspector.sdk.CaptureFrame"));
                    if (faultsOnly || preflightFaults || protocolFaults || "continuous-fixtures".equals(pipelineCase))
                        report.put("uiBatchSafety", probe.verifyUiBatchSafety());
                    FixedCpuProbe cpuProbe = cpuControl ? new FixedCpuProbe(managed) : null;
                    for (int index = 0; index < (longClean ? 12 : 6); index++) {
                        if ((cpuControl || matched) && index == 3) {
                            long remaining = 40_000 - (android.os.SystemClock.uptimeMillis() - android.os.Process.getStartUptimeMillis());
                            if (remaining > 0) Thread.sleep(remaining);
                        }
                        JSONObject cpuBefore = cpuControl ? cpuProbe.measure() : null;
                        probe.sampleRound = "continuous-managed-profile".equals(pipelineCase) && (index == 1 || index == 4) ? index : -1;
                        JSONObject row = probe.round(false, false, false, 1);
                        rounds.put(row);
                        if (cpuControl) row.put("fixedCpuBefore", cpuBefore).put("fixedCpuAfter", cpuProbe.measure());
                    }
                } else if (systemTrace || methodTrace) {
                    report.put("productionSdkChanged", false);
                    probe.formatMode = "platform";
                    probe.sampleRound = methodTrace ? 0 : -1;
                    JSONObject row = probe.round(false, false, false, 1);
                    rounds.put(row);
                    if (row.getLong("wallNanos") > 15_000_000_000L)
                        throw new IllegalStateException("System trace capture exceeded health gate; stopped");
                } else if (snapshotWaits) {
                    report.put("productionSdkChanged", false);
                    for (int index = 0; index < 2; index++) {
                        if (index == 1) {
                            long remaining = 40_000 - (android.os.SystemClock.uptimeMillis() - android.os.Process.getStartUptimeMillis());
                            if (remaining > 0) Thread.sleep(remaining);
                        }
                        probe.formatMode = "platform";
                        JSONObject row = probe.round(false, false, false, 1);
                        rounds.put(row);
                        if (row.getLong("wallNanos") > 15_000_000_000L)
                            throw new IllegalStateException("Diagnostic exceeded 15 second health gate; stopped");
                        JSONObject end = row.getJSONObject("boundaryAfterPipeline");
                        if (index == 0 && end.getLong("uptimeMs") - end.getLong("processStartUptimeMs") >= 30_000)
                            throw new IllegalStateException("Early diagnostic left startup period; stopped");
                    }
                } else if (formatExperiment) {
                    report.put("productionSdkChanged", false).put("reversed", reverse);
                    String[] modes = reverse ? new String[]{"cached", "uncached", "platform", "platform", "uncached", "cached"}
                            : new String[]{"platform", "uncached", "cached", "cached", "uncached", "platform"};
                    for (int index = 0; index < modes.length; index++) {
                        if (index == 3) {
                            long remaining = 40_000 - (android.os.SystemClock.uptimeMillis() - android.os.Process.getStartUptimeMillis());
                            if (remaining > 0) Thread.sleep(remaining);
                        }
                        probe.formatMode = modes[index];
                        JSONObject row = probe.round(false, false, false);
                        rounds.put(row);
                        if (row.getLong("wallNanos") > 15_000_000_000L)
                            throw new IllegalStateException("Full pipeline exceeded 15 second health gate; stopped");
                        JSONObject end = row.getJSONObject("boundaryAfterPipeline");
                        if (index < 3 && end.getLong("uptimeMs") - end.getLong("processStartUptimeMs") >= 30_000)
                            throw new IllegalStateException("Early full pipeline left startup period; stopped");
                    }
                } else if (outputExperiment) {
                    report.put("reversed", reverse);
                    if (pipelineCase.startsWith("buffered-output-first-")) {
                        rounds.put(probe.round(false, false, false, 1, false, false, pipelineCase.endsWith("buffered")));
                    } else if ("buffered-output-safety".equals(pipelineCase) || "buffered-output-chain-safety".equals(pipelineCase)) {
                        boolean chainSafety = "buffered-output-chain-safety".equals(pipelineCase);
                        rounds.put(probe.round(false, false, false, 1, false, false, true));
                        JSONArray faults = new JSONArray(); report.put("outputFaults", faults);
                        for (String fault : chainSafety ? new String[]{"write", "flush", "close", "publish"} : new String[]{"write", "flush", "close"}) {
                            probe.outputFault = fault;
                            boolean rejected = false;
                            try { probe.round(false, false, false, 1, false, false, true); }
                            catch (Exception error) {
                                for (Throwable cause = error; cause != null; cause = cause.getCause())
                                    if (("sample-output-" + fault).equals(cause.getMessage())) rejected = true;
                                if (!rejected) throw error;
                            } finally { probe.outputFault = null; }
                            if (!rejected || !probe.lastOutput.injected || !probe.lastOutput.descriptorClosed()
                                    || new File(probe.directory, "geometry-load-images.bin").exists() || probe.lastOutputGeometry.exists()
                                    || probe.lastOutput.target.exists())
                                throw new IllegalStateException("Output fault cleanup failed");
                            faults.put(new JSONObject().put("phase", fault).put("rejected", true).put("descriptorClosed", true).put("partialFilesRemoved", true));
                            rounds.put(probe.round(false, false, false, 1, false, false, true));
                        }
                    } else for (int index = 0; index < 6; index++) {
                        if (index == 3) {
                            long remaining = 40_000 - (android.os.SystemClock.uptimeMillis() - android.os.Process.getStartUptimeMillis());
                            if (remaining > 0) Thread.sleep(remaining);
                        }
                        rounds.put(probe.round(false, false, false, 1, false, false, (index % 2 == 1) != reverse));
                    }
                } else if (hardwarePipeline) {
                    report.put("reversed", reverse);
                    for (int index = 0; index < 6; index++) {
                        if (index == 3) {
                            long remaining = 40_000 - (android.os.SystemClock.uptimeMillis() - android.os.Process.getStartUptimeMillis());
                            if (remaining > 0) Thread.sleep(remaining);
                        }
                        rounds.put(probe.round(false, false, false, 1, false, (index % 2 == 1) != reverse));
                    }
                } else if (hardwareComparison || hardwareSafety) {
                    rounds.put(probe.round(false, false, false, 1));
                    if (hardwareSafety) report.put("hardwareReuseSafety", HardwareReuseSafety.verify(probe.views.get(32), probe.views.get(0), probe.pixelHash, probe.referencePixels.get(SnapshotPipeline.ref(probe.views.get(32)))));
                    else {
                        JSONArray comparisons = new JSONArray(); report.put("hardwareReuseComparisons", comparisons);
                        for (int index = 0; index < 6; index++) {
                            if (index == 3) {
                                long remaining = 40_000 - (android.os.SystemClock.uptimeMillis() - android.os.Process.getStartUptimeMillis());
                                if (remaining > 0) Thread.sleep(remaining);
                            }
                            JSONObject block = new JSONObject(); comparisons.put(block);
                            probe.hardwareComparison(index, reverse, block);
                        }
                    }
                    rounds.put(probe.round(false, false, false, 1)); // Original SDK still works after reuse/fault cleanup.
                } else if (softwareGate || hardwareGate) {
                    rounds.put(probe.round(false, false, false, 1));
                    report.put(hardwareGate ? "hardwareReuseGate" : "softwareGate", probe.pixelGate(hardwareGate));
                } else if ("ui-dispatch-comparison".equals(pipelineCase)) {
                    report.put("uiDispatchFixtures", UiDispatchProbe.verify());
                    report.put("uiDispatchSafety", probe.verifyUiBatchSafety(true));
                    for (boolean side : new boolean[] { false, true, true, false, false, true })
                        rounds.put(probe.round(false, false, false, 1, side != reverse));
                } else if ("ui-batch-comparison".equals(pipelineCase)) {
                    report.put("uiBatchSafety", probe.verifyUiBatchSafety());
                    for (boolean side : new boolean[] { false, true, true, false, false, true })
                        rounds.put(probe.round(false, false, false, side != reverse ? 2 : 1));
                } else if ("lightweight-comparison".equals(pipelineCase)) {
                    for (boolean side : new boolean[] { false, true, true, false, false, true })
                        rounds.put(probe.round(false, false, side != reverse));
                } else if (pipelineCase != null) {
                    if (!pipelineCase.equals("original") && !pipelineCase.equals("candidate") && !pipelineCase.equals("serial") && !pipelineCase.equals("lightweight"))
                        throw new IllegalArgumentException("Unknown pipeline case");
                    rounds.put(probe.round(pipelineCase.equals("serial"), pipelineCase.equals("candidate"), pipelineCase.equals("lightweight")));
                } else for (int comparison = 0; comparison < 2; comparison++) {
                    for (boolean side : new boolean[] { false, true, true, false }) {
                        boolean alternate = side != reverse;
                        rounds.put(probe.round(comparison == 0 && alternate, comparison == 1 && alternate, false));
                    }
                }
                report.put("passed", true).put("workers", 2).put("queueBudget", 4)
                        .put("retention", "bounded-metadata").put("pipelineCase", pipelineCase == null ? "abba" : pipelineCase)
                        .put("rounds", rounds).put("validatedLayers", probe.referencePixels.size())
                        .put("preflightCapture", !firstCapture && !noPreflight).put("firstCaptureBenchmark", firstCapture)
                        .put("idleNanos", idleNanos).put("requestedIdleMillis", idleMillis)
                        .put("immutableProtocolVerified", probe.immutableProtocolVerified);
                }
            } catch (Throwable error) {
                try {
                    JSONArray causes = new JSONArray();
                    for (Throwable cause = error; cause != null; cause = cause.getCause()) causes.put(cause.toString());
                    report.put("passed", false).put("error", error.toString()).put("causes", causes);
                } catch (Exception ignored) {}
            }
            try {
                File directory = new File(activity.getFilesDir(), "isolation-probe");
                if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Probe directory unavailable");
                try (FileOutputStream output = new FileOutputStream(new File(directory, "geometry-pipeline.json"))) {
                    output.write(report.toString().getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception ignored) {}
        }, "geometry-pipeline-probe").start();
    }

    private JSONObject hardwareComparison(int index, boolean reverse, JSONObject block) throws Exception {
        JSONArray rows = new JSONArray();
        ReusableHardwareCapture reusable = new ReusableHardwareCapture();
        long age = android.os.SystemClock.uptimeMillis() - android.os.Process.getStartUptimeMillis();
        block.put("index", index).put("reverse", reverse).put("processAgeMs", age).put("rows", rows);
        long[] closeNanos = new long[2];
        try {
            for (int ordinal = 32; ordinal < 96; ordinal++) {
                if (activity.isDestroyed() || android.os.SystemClock.uptimeMillis() > deadline)
                    throw new IllegalStateException("Hardware comparison expired");
                View view = views.get(ordinal);
                JSONObject row = new JSONObject().put("ordinal", ordinal).put("ref", SnapshotPipeline.ref(view));
                rows.put(row); // Preserve per-target evidence in a completed block.
                boolean reuseFirst = ((ordinal + index) % 2 == 0) != reverse;
                row.put("reuseFirst", reuseFirst);
                for (boolean reuse : new boolean[]{reuseFirst, !reuseFirst}) {
                    long[] timing = new long[2];
                    UiTaskBatch.Result batch = UiTaskBatch.capture(1, offset -> {
                        if (!SnapshotPhaseProbe.eligible(view)) throw new IllegalStateException("Comparison target changed");
                        java.util.IdentityHashMap<View, String> identities = new java.util.IdentityHashMap<>();
                        ImmutableGeometry geometry = ImmutableGeometry.read(view, root, identities);
                        long wall = System.nanoTime(), cpu = Debug.threadCpuTimeNanos();
                        Bitmap readable;
                        if (reuse) readable = reusable.capture(view);
                        else {
                            Bitmap hardware = (Bitmap) snapshot.invoke(null, view, null);
                            if (hardware == null) throw new IllegalStateException("Original snapshot missing");
                            try { readable = hardware.copy(Bitmap.Config.ARGB_8888, false); }
                            finally { hardware.recycle(); }
                        }
                        timing[0] = System.nanoTime() - wall; timing[1] = Debug.threadCpuTimeNanos() - cpu;
                        if (readable == null) throw new IllegalStateException("Comparison readback missing");
                        try {
                            if (readable.getWidth() != view.getWidth() || readable.getHeight() != view.getHeight()
                                    || !geometry.matches(view, root, identities)) throw new IllegalStateException("Comparison geometry changed");
                            return readable;
                        } catch (Throwable error) { readable.recycle(); throw error; }
                    }, item -> ((Bitmap) item).recycle(), new java.util.concurrent.atomic.AtomicBoolean());
                    Bitmap pixels = (Bitmap) batch.frames.get(0);
                    try {
                        byte[] actual = pixelHash.digest(pixels), expected = referencePixels.get(SnapshotPipeline.ref(view));
                        if (!Arrays.equals(actual, expected)) throw new IllegalStateException("Comparison pixels differ");
                        row.put(reuse ? "reusedRgbaSha256" : "sdkRgbaSha256", hex(actual))
                                .put("width", pixels.getWidth()).put("height", pixels.getHeight())
                                .put(reuse ? "reuseWallNanos" : "originalWallNanos", timing[0])
                                .put(reuse ? "reuseCpuNanos" : "originalCpuNanos", timing[1])
                                .put(reuse ? "reuseQueueNanos" : "originalQueueNanos", batch.queueNanos);
                    } finally { pixels.recycle(); }
                }
            }
        } finally {
            UiTaskBatch.capture(1, offset -> {
                long wall = System.nanoTime(), cpu = Debug.threadCpuTimeNanos();
                reusable.close(); closeNanos[0] = System.nanoTime() - wall; closeNanos[1] = Debug.threadCpuTimeNanos() - cpu;
                return Boolean.TRUE;
            }, item -> {}, new java.util.concurrent.atomic.AtomicBoolean());
        }
        return block
                .put("endAgeMs", android.os.SystemClock.uptimeMillis() - android.os.Process.getStartUptimeMillis())
                .put("rows", rows).put("rendererCreations", reusable.creations).put("resourcesClosed", reusable.closed)
                .put("captures", reusable.captures).put("closeWallNanos", closeNanos[0]).put("closeCpuNanos", closeNanos[1])
                .put("initializationIncluded", true).put("bothPathsIncludeCpuCopy", true).put("productionSdkChanged", false);
    }

    /** Pixel gate only: stop before benchmarking if the rendering backend changes pixels. */
    private JSONObject pixelGate(boolean hardwareReuse) throws Exception {
        long ageMs = android.os.SystemClock.uptimeMillis() - android.os.Process.getStartUptimeMillis();
        JSONArray rows = new JSONArray();
        ReusableHardwareCapture reusable = hardwareReuse ? new ReusableHardwareCapture() : null;
        java.util.IdentityHashMap<View, String> identities = new java.util.IdentityHashMap<>();
        try {
        for (int ordinal = MatchedStageProbe.FIRST; ordinal < MatchedStageProbe.END; ordinal++) {
            if (activity.isDestroyed() || android.os.SystemClock.uptimeMillis() > deadline)
                throw new IllegalStateException("Software gate expired");
            View current = views.get(ordinal);
            UiTaskBatch.Result batch = UiTaskBatch.capture(1, offset -> {
                if (!SnapshotPhaseProbe.eligible(current) || !current.isShown() || !current.isHardwareAccelerated())
                    throw new IllegalStateException("Software target is not a simple TextView");
                int width = current.getWidth(), height = current.getHeight();
                if ((long) width * height <= 0 || (long) width * height > 4_000_000)
                    throw new IllegalStateException("Software bitmap exceeds SDK size budget");
                ImmutableGeometry geometry = ImmutableGeometry.read(current, root, identities);
                Bitmap bitmap;
                if (reusable != null) bitmap = reusable.capture(current);
                else {
                    Object canvas = org.lsposed.hiddenapibypass.HiddenApiBypass.newInstance(
                            Class.forName("android.view.ViewDebug$SoftwareCanvasProvider"));
                    bitmap = (Bitmap) org.lsposed.hiddenapibypass.HiddenApiBypass.invoke(
                            View.class, current, "createSnapshot", canvas, true);
                }
                if (bitmap == null) throw new IllegalStateException("Software snapshot missing");
                try {
                    if (bitmap.getConfig() != Bitmap.Config.ARGB_8888 || bitmap.getWidth() != width || bitmap.getHeight() != height
                            || !geometry.matches(current, root, identities))
                        throw new IllegalStateException("Software dimensions/geometry changed");
                    return bitmap;
                } catch (Throwable failure) { bitmap.recycle(); throw failure; }
            }, item -> ((Bitmap) item).recycle(), new java.util.concurrent.atomic.AtomicBoolean());
            Bitmap bitmap = (Bitmap) batch.frames.get(0);
            boolean matches;
            try {
                byte[] actual = pixelHash.digest(bitmap), expected = referencePixels.get(SnapshotPipeline.ref(current));
                if (expected == null) throw new IllegalStateException("Missing SDK pixel reference");
                matches = Arrays.equals(expected, actual);
                rows.put(new JSONObject().put("ordinal", ordinal).put("ref", SnapshotPipeline.ref(current))
                        .put("width", bitmap.getWidth()).put("height", bitmap.getHeight())
                        .put("sdkRgbaSha256", hex(expected)).put(hardwareReuse ? "reusedRgbaSha256" : "softwareRgbaSha256", hex(actual))
                        .put("pixelsMatch", matches).put("geometryVerified", true));
            } finally { bitmap.recycle(); }
            if (!matches) break;
        }
        } finally {
            if (reusable != null) UiTaskBatch.capture(1, offset -> {
                reusable.close(); return Boolean.TRUE;
            }, item -> {}, new java.util.concurrent.atomic.AtomicBoolean()); // Queued after any late active draw.
        }
        boolean accepted = rows.length() == MatchedStageProbe.END - MatchedStageProbe.FIRST
                && rows.getJSONObject(rows.length() - 1).getBoolean("pixelsMatch");
        JSONObject report = new JSONObject().put("first", MatchedStageProbe.FIRST).put("end", MatchedStageProbe.END)
                .put("processAgeMs", ageMs)
                .put("accepted", accepted).put("stoppedOnMismatch", !accepted).put("rows", rows)
                .put("performanceBenchmarkRun", false).put("productionSdkChanged", false);
        if (reusable != null) report.put("rendererCreations", reusable.creations).put("captures", reusable.captures)
                .put("resourcesClosed", reusable.closed).put("fixedSizeOnly", true);
        return report;
    }

    private final Activity activity;
    private final View root;
    private final ArrayList<View> views = new ArrayList<>();
    private final HashMap<String, byte[]> referencePixels = new HashMap<>();
    private final HashMap<String, byte[]> referenceEncoded = new HashMap<>();
    private String outputFault;
    private String formatMode;
    private SampleOutput lastOutput;
    private File lastOutputGeometry;
    private OutputTimings activeWrites;
    private static final class OutputTimings {
        long records, recordWriteNanos, geometryAppendNanos;
        JSONObject report() throws Exception { return new JSONObject().put("records", records)
                .put("recordWriteNanos", recordWriteNanos).put("geometryAppendNanos", geometryAppendNanos); }
    }
    private final ConcurrentHashMap<String, byte[]> referenceGeometry = new ConcurrentHashMap<>();
    private final SnapshotPixelHash pixelHash = new SnapshotPixelHash(true);
    private final Method capture, encode, write, timingReply, addGeometry, finishGeometry, writeGeometry, rectangle, snapshot;
    private boolean immutableProtocolVerified;
    private int sampleRound = -1;
    private final boolean firstCapture;
    private final Constructor<?> timingConstructor, geometryConstructor, recordConstructor;
    private final Object provider;
    private final Field frameBitmap, frameGeometry, frameX, frameY, imageBytes, imageCrc;
    private final File directory;
    private final long deadline = android.os.SystemClock.uptimeMillis() + 180_000;

    private GeometryPipelineProbe(Activity activity, View root, boolean firstCapture) throws Exception {
        this.activity = activity; this.root = root;
        this.firstCapture = firstCapture;
        CountDownLatch selected = new CountDownLatch(1);
        AtomicReference<Throwable> error = new AtomicReference<>();
        activity.runOnUiThread(() -> {
            try { GeometrySerializationProbe.collect(root, views); }
            catch (Throwable failure) { error.set(failure); }
            finally { selected.countDown(); }
        });
        if (!selected.await(3, TimeUnit.SECONDS) || error.get() != null) throw new IllegalStateException("Sample selection failed", error.get());
        if (views.size() != 407) throw new IllegalStateException("Need static stress-rectangle sample");
        Class<?> sdk = Class.forName("com.androiduiinspector.sdk.CaptureFrame");
        Class<?> timing = Class.forName(sdk.getName() + "$CaptureTiming");
        timingConstructor = timing.getDeclaredConstructor(); timingConstructor.setAccessible(true);
        capture = method(sdk, "captureFrame", View.class, View.class, boolean.class, timing);
        rectangle = method(sdk, "supportsRectangleContext", View.class, View.class);
        snapshot = method(Class.forName("com.androiduiinspector.sdk.IsolatedCapture"), "debugSnapshot", View.class, long[].class);
        Class<?> outputType = Class.forName("com.androiduiinspector.sdk.CaptureOutput");
        encode = method(outputType, "encodeVisibleLayer", Bitmap.class, String.class, int.class, int.class, boolean.class, AtomicLong.class);
        write = method(outputType, "writeVisibleRecord", DataOutputStream.class, Future.class);
        timingReply = method(timing, "reply", Bundle.class);
        Class<?> owner = Class.forName("com.androiduiinspector.sdk.HierarchyProvider");
        Object windowProvider = owner.getDeclaredConstructor().newInstance();
        // This test creates a provider after the real Activity has resumed. Replay only
        // that lifecycle notification; do not draw or preflight the first-capture page.
        UiTaskBatch.capture(1, offset -> {
            owner.getMethod("onActivityResumed", Activity.class).invoke(windowProvider, activity);
            return Boolean.TRUE;
        }, ignored -> {}, new java.util.concurrent.atomic.AtomicBoolean(), false);
        Field captureOwner = owner.getDeclaredField("capture"); captureOwner.setAccessible(true);
        provider = captureOwner.get(windowProvider);
        writeGeometry = method(outputType, "writeGeometryFile", android.app.Application.class, String.class, String.class, String.class, Bundle.class);
        Class<?> geometry = Class.forName(outputType.getName() + "$GeometryRecords");
        geometryConstructor = geometry.getDeclaredConstructor(); geometryConstructor.setAccessible(true);
        Class<?> record = Class.forName(outputType.getName() + "$VisibleRecord");
        recordConstructor = record.getDeclaredConstructor(String.class, int.class, int.class, byte[].class, int.class, boolean.class, String.class, int.class);
        recordConstructor.setAccessible(true);
        addGeometry = method(geometry, "add", record); finishGeometry = method(geometry, "finish");
        Class<?> frame = Class.forName(sdk.getName() + "$CapturedFrame");
        frameBitmap = field(frame, "bitmap"); frameGeometry = field(frame, "geometry");
        frameX = field(frame, "x"); frameY = field(frame, "y");
        imageBytes = field(Class.forName(outputType.getName() + "$VisibleRecord"), "image");
        imageCrc = field(Class.forName(outputType.getName() + "$VisibleRecord"), "crc");
        directory = new File(activity.getFilesDir(), "isolation-probe");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Probe directory unavailable");
        if (firstCapture) return; // No preflight draw, JSON warmup, or mutation tests before first capture.
        // Static fixture only: retain validation digests, never reuse these records for capture.
        Object preflightTiming = timingConstructor.newInstance();
        for (View view : views) {
            if (activity.isDestroyed() || android.os.SystemClock.uptimeMillis() > deadline)
                throw new IllegalStateException("Preflight expired");
            Object baselineFrame = capture.invoke(null, view, root, true, preflightTiming);
            if (baselineFrame == null) throw new IllegalStateException("Preflight View changed");
            Bitmap bitmap = (Bitmap) frameBitmap.get(baselineFrame);
            try {
                JSONObject baselineGeometry = (JSONObject) frameGeometry.get(baselineFrame);
                if (baselineGeometry != null) referenceGeometry.put(SnapshotPipeline.ref(view),
                        geometryDigest(baselineGeometry.toString(), baselineGeometry));
            } finally { bitmap.recycle(); }
        }
        if (referenceGeometry.size() != 405) throw new IllegalStateException("Preflight geometry count changed");
        String setup = activity.getIntent().getStringExtra("geometryPipelineCase");
        if (!"continuous-preflight".equals(setup) && !"continuous-preflight-faults".equals(setup)) verifyImmutableProtocol(sdk);
    }

    private static Method method(Class<?> type, String name, Class<?>... arguments) throws Exception {
        Method value = type.getDeclaredMethod(name, arguments); value.setAccessible(true); return value;
    }
    private static Field field(Class<?> type, String name) throws Exception {
        Field value = type.getDeclaredField(name); value.setAccessible(true); return value;
    }
    private static final class Result {
        Object image;
        String ref;
        int width, height, x, y, geometryBytes, ordinal;
    }

    private JSONObject verifyUiBatchSafety() throws Exception {
        return verifyUiBatchSafety(false);
    }

    private JSONObject verifyUiBatchSafety(boolean async) throws Exception {
        JSONArray cases = new JSONArray();
        Bitmap first = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
        try {
            UiTaskBatch.Result unexpected = UiTaskBatch.capture(2, offset -> {
                if (offset == 1) throw new IllegalStateException("fixture second capture failure");
                return first;
            }, frame -> ((Bitmap) frame).recycle(), new java.util.concurrent.atomic.AtomicBoolean(), async);
            for (Object frame : unexpected.frames) ((Bitmap) frame).recycle();
            throw new IllegalStateException("Partial failure was accepted");
        } catch (IllegalStateException expected) {
            if (!first.isRecycled() || expected.getCause() == null) throw expected;
            cases.put("partial-failure-recycled");
        } finally { if (!first.isRecycled()) first.recycle(); }
        for (boolean cancel : new boolean[] { false, true }) {
            Bitmap completed = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
            Bitmap active = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
            java.util.concurrent.atomic.AtomicBoolean cancelled = new java.util.concurrent.atomic.AtomicBoolean();
            CountDownLatch entered = new CountDownLatch(1);
            Thread canceller = cancel ? new Thread(() -> {
                try { if (entered.await(3, TimeUnit.SECONDS)) cancelled.set(true); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }, "sample-batch-cancel") : null;
            if (canceller != null) canceller.start();
            try {
                UiTaskBatch.Result unexpected = UiTaskBatch.capture(2, offset -> {
                    if (offset == 0) return completed;
                    entered.countDown(); Thread.sleep(4200); return active;
                }, frame -> ((Bitmap) frame).recycle(), cancelled, async);
                for (Object frame : unexpected.frames) ((Bitmap) frame).recycle();
                throw new IllegalStateException("Late batch was accepted");
            } catch (Exception expected) {
                if (entered.getCount() != 0 || completed.isRecycled() || active.isRecycled()
                        || (cancel ? !(expected instanceof InterruptedException)
                            : !"Batch UI task timed out".equals(expected.getMessage()))) throw expected;
                onUi(() -> { }); // Wait for the late callback and its cleanup, not a new capture.
                if (!completed.isRecycled() || !active.isRecycled()) throw new IllegalStateException("Late batch leaked");
                cases.put(cancel ? "cancel-late-recycled" : "timeout-late-recycled");
            } finally {
                if (canceller != null) canceller.join(1000);
                if (!completed.isRecycled()) completed.recycle();
                if (!active.isRecycled()) active.recycle();
            }
        }
        java.util.concurrent.atomic.AtomicBoolean canceled = new java.util.concurrent.atomic.AtomicBoolean(true);
        java.util.concurrent.atomic.AtomicInteger callbacks = new java.util.concurrent.atomic.AtomicInteger();
        try {
            UiTaskBatch.capture(2, offset -> { callbacks.incrementAndGet(); return new Object(); }, frame -> { }, canceled, async);
            throw new IllegalStateException("Canceled queue accepted");
        } catch (InterruptedException expected) { onUi(() -> { }); }
        if (callbacks.get() != 0) throw new IllegalStateException("Canceled callback ran");
        cases.put("canceled-before-start");
        UiTaskBatch.Result recovered = UiTaskBatch.capture(1, offset -> new Object(), frame -> { }, new java.util.concurrent.atomic.AtomicBoolean(), async);
        if (recovered.frames.size() != 1) throw new IllegalStateException("Batch did not recover");
        return new JSONObject().put("cases", cases).put("recovered", true).put("lateResultsRejected", true);
    }

    private JSONObject round(boolean serial, boolean candidate, boolean lightweight) throws Exception {
        return round(serial, candidate, lightweight, 0);
    }

    private JSONObject round(boolean serial, boolean candidate, boolean lightweight, int uiBatchSize) throws Exception {
        return round(serial, candidate, lightweight, uiBatchSize, false);
    }

    private JSONObject round(boolean serial, boolean candidate, boolean lightweight, int uiBatchSize, boolean async) throws Exception {
        return round(serial, candidate, lightweight, uiBatchSize, async, false);
    }

    private JSONObject round(boolean serial, boolean candidate, boolean lightweight, int uiBatchSize, boolean async, boolean hardwareReuse) throws Exception {
        return round(serial, candidate, lightweight, uiBatchSize, async, hardwareReuse, false);
    }

    private JSONObject round(boolean serial, boolean candidate, boolean lightweight, int uiBatchSize, boolean async, boolean hardwareReuse, boolean buffered) throws Exception {
        String outputCase = activity.getIntent().getStringExtra("geometryPipelineCase");
        boolean outputExperiment = outputCase != null && outputCase.startsWith("buffered-output-");
        boolean snapshotWaits = "snapshot-wait-diagnostic".equals(outputCase);
        boolean systemTrace = "snapshot-system-trace".equals(outputCase);
        boolean methodTrace = "snapshot-method-trace".equals(outputCase);
        boolean formatExperiment = "format-cache-pipeline".equals(outputCase) || snapshotWaits || systemTrace || methodTrace;
        ConcurrentHashMap<Thread, ScalarFormatCache> formatters = new ConcurrentHashMap<>();
        Method immutableCapture = formatExperiment ? method(capture.getDeclaringClass(), "captureFrame", View.class, View.class,
                boolean.class, timingConstructor.getDeclaringClass(), boolean.class) : null;
        activeWrites = "buffered-output-diagnostic".equals(outputCase) ? new OutputTimings() : null;
        Object timing = timingConstructor.newInstance();
        PipelineWaitProbe waits = "continuous-pipeline-waits".equals(activity.getIntent().getStringExtra("geometryPipelineCase")) || snapshotWaits
                ? new PipelineWaitProbe(timing, snapshotWaits) : null;
        HardwarePipelineCapture reused = hardwareReuse ? new HardwarePipelineCapture(timing) : null;
        MatchedStageProbe stages = "continuous-matched-stages".equals(activity.getIntent().getStringExtra("geometryPipelineCase"))
                ? new MatchedStageProbe(timing) : null;
        boolean managed = activity.getIntent().getStringExtra("geometryPipelineCase") != null
                && activity.getIntent().getStringExtra("geometryPipelineCase").startsWith("continuous-managed-");
        ExecutorService workers = stages != null ? Executors.newFixedThreadPool(2, task -> new Thread(() -> {
            stages.workerStarted(); task.run();
        }, "geometry-stages")) : managed || methodTrace ? Executors.newFixedThreadPool(2, task -> new Thread(task, "geometry-encode")) : Executors.newFixedThreadPool(2);
        ArrayDeque<Future<Result>> pending = new ArrayDeque<>();
        ArrayList<Result> completed = new ArrayList<>();
        Set<Bitmap> owned = ConcurrentHashMap.newKeySet();
        AtomicLong encodeWall = new AtomicLong(), encodeCpu = new AtomicLong(), jsonWall = new AtomicLong(), jsonCpu = new AtomicLong();
        AtomicLong geometryCheckWall = new AtomicLong();
        AtomicLong unusedEncodeMs = new AtomicLong();
        SnapshotMemorySampler memory = activity.getIntent().getBooleanExtra("geometryMemoryProbe", false) ? new SnapshotMemorySampler() : null;
        JSONObject memoryReport = null;
        boolean boundaries = activity.getIntent().getStringExtra("geometryPipelineCase") != null
                && (activity.getIntent().getStringExtra("geometryPipelineCase").startsWith("continuous-")
                || "hardware-pipeline-comparison".equals(activity.getIntent().getStringExtra("geometryPipelineCase")) || outputExperiment || formatExperiment);
        JSONObject before = boundaries ? SnapshotBoundary.read(activity) : null;
        JSONObject after = null;
        Object geometryRecords = geometryConstructor.newInstance();
        String nonce = java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        File geometryFile = new File(activity.getNoBackupFilesDir(), "inspector-geometry-" + nonce + ".json");
        File file = new File(directory, "geometry-load-images.bin");
        boolean success = false;
        boolean traceActive = false;
        MethodWindow methodWindow = sampleRound >= 0 ? new MethodWindow(directory, sampleRound) : null;
        int peakDepth = 0;
        long elapsed, bytes = 0;
        int uiPosts = 0, twoFrameTasks = 0;
        long uiQueueNanos = 0, uiTaskNanos = 0, uiTaskMaxNanos = 0;
        ArrayDeque<Object> readyFrames = new ArrayDeque<>();
        Method uiCapture = method(capture.getDeclaringClass(), "captureFrameOnUiThread", View.class, View.class,
                boolean.class, boolean.class, timingConstructor.getDeclaringClass(), boolean.class);
        long outputStarted = outputExperiment ? System.nanoTime() : 0;
        boolean publishedOutput = outputCase != null && (outputCase.startsWith("buffered-output-first-") || "buffered-output-chain-safety".equals(outputCase));
        File pendingOutput = new File(directory, "geometry-load-images-" + nonce + ".tmp");
        SampleOutput sampleOutput = outputExperiment ? new SampleOutput(publishedOutput ? pendingOutput : file, buffered, outputFault, publishedOutput) : null;
        String outputSha256 = null;
        if (sampleOutput != null) { lastOutput = sampleOutput; lastOutputGeometry = geometryFile; }
        try (DataOutputStream output = sampleOutput == null ? new DataOutputStream(formatExperiment
                ? new java.io.BufferedOutputStream(new FileOutputStream(file), 65536) : new FileOutputStream(file)) : sampleOutput.data) {
            output.writeLong(Long.parseUnsignedLong(nonce, 16));
            if (memory != null) memory.begin();
            if (methodWindow != null) methodWindow.start();
            long started = outputExperiment ? outputStarted : System.nanoTime();
            if (systemTrace) {
                if (!android.os.Trace.isEnabled()) throw new IllegalStateException("System trace is not enabled for sample");
                android.os.Trace.beginSection("InspectorPipeline"); traceActive = true;
            }
            for (int index = 0; index < views.size(); index++) {
                if (methodWindow != null) methodWindow.poll();
                View view = views.get(index);
                if (activity.isDestroyed() || android.os.SystemClock.uptimeMillis() > deadline) throw new IllegalStateException("Load probe expired");
                if (uiBatchSize > 0 && readyFrames.isEmpty()) {
                    int limit = Math.min(uiBatchSize, views.size() - index);
                    // Encoding + completed unclaimed frames never exceed the existing depth of four.
                    while (pending.size() + limit > 4) completed.add(drain(output, pending, geometryRecords, waits, false));
                    final int first = index;
                    long captureBegan = waits == null ? 0 : System.nanoTime();
                    UiTaskBatch.Result batch = UiTaskBatch.capture(limit, offset -> {
                        View current = views.get(first + offset);
                        boolean qualified = (boolean) rectangle.invoke(null, current, root);
                        long[] measured = stages != null && stages.selected(first + offset) ? stages.beforeUi() : null;
                        if (waits != null) waits.beforeUi(first + offset);
                        if (systemTrace) android.os.Trace.beginSection("InspectorCapture");
                        try { return reused != null && first + offset >= 32 && first + offset < 96
                                ? reused.capture(current, root, qualified)
                                : uiCapture.invoke(null, current, root, true, qualified, timing, true); }
                        finally {
                            if (systemTrace) android.os.Trace.endSection();
                            if (measured != null) stages.afterUi(measured);
                            if (waits != null) waits.afterUi(first + offset);
                        }
                    }, item -> ((Bitmap) frameBitmap.get(item)).recycle(), new java.util.concurrent.atomic.AtomicBoolean(), async);
                    if (waits != null) waits.captureReturned(first, System.nanoTime() - captureBegan, batch);
                    readyFrames.addAll(batch.frames);
                    for (Object item : batch.frames) owned.add((Bitmap) frameBitmap.get(item));
                    uiPosts++; if (batch.frames.size() == 2) twoFrameTasks++;
                    uiQueueNanos += batch.queueNanos; uiTaskNanos += batch.taskNanos;
                    uiTaskMaxNanos = Math.max(uiTaskMaxNanos, batch.taskNanos);
                }
                Object frame = lightweight ? null : uiBatchSize > 0 ? readyFrames.removeFirst() : formatExperiment
                        ? immutableCapture.invoke(null, view, root, true, timing, true) : capture.invoke(null, view, root, true, timing);
                LightFrame light = lightweight ? captureLight(view, timing) : null;
                if (frame == null && light == null) throw new IllegalStateException("Static sample View changed");
                Bitmap bitmap = light == null ? (Bitmap) frameBitmap.get(frame) : light.bitmap;
                owned.add(bitmap);
                JSONObject geometry = light == null ? (JSONObject) frameGeometry.get(frame) : null;
                Object immutableGeometry = uiBatchSize > 0 || formatExperiment ? field(frame.getClass(), "immutableGeometry").get(frame) : null;
                if (formatExperiment && geometry != null && immutableGeometry == null)
                    throw new IllegalStateException("Format experiment requires immutable geometry, not legacy JSON");
                long immutableStarted = immutableGeometry == null ? 0 : field(frame.getClass(), "started").getLong(frame);
                long immutableEnded = immutableGeometry == null ? 0 : field(frame.getClass(), "ended").getLong(frame);
                String ref = SnapshotPipeline.ref(view);
                int x = light == null ? frameX.getInt(frame) : light.x, y = light == null ? frameY.getInt(frame) : light.y;
                int width = bitmap.getWidth(), height = bitmap.getHeight();
                final int ordinal = index;
                while (pending.size() >= 4) completed.add(drain(output, pending, geometryRecords, waits, false));
                long submitted = waits == null ? 0 : System.nanoTime();
                pending.addLast(workers.submit(() -> {
                    if (waits != null) waits.workerStarted(ordinal, submitted);
                    try {
                        Result result = new Result(); result.ref = ref; result.ordinal = ordinal;
                        result.width = width; result.height = height; result.x = x; result.y = y;
                        long phase = System.nanoTime(), cpu = Debug.threadCpuTimeNanos();
                        result.image = encode.invoke(null, bitmap, ref, x, y, android.os.Build.VERSION.SDK_INT >= 30, unusedEncodeMs);
                        if (stages != null && stages.selected(ordinal)) stages.encoded(phase, cpu);
                        if (waits != null) waits.stage(ordinal, "encode", phase, cpu);
                        addCpu(encodeCpu, cpu); encodeWall.addAndGet(System.nanoTime() - phase);
                        if (geometry != null || immutableGeometry != null || (light != null && light.evidence != null)) {
                            phase = System.nanoTime(); cpu = Debug.threadCpuTimeNanos();
                            JSONObject emitted = immutableGeometry != null ? (JSONObject) method(immutableGeometry.getClass(), "json", long.class, long.class)
                                    .invoke(immutableGeometry, immutableStarted, immutableEnded)
                                    : light == null ? geometry : light.evidence.json(light.started, light.ended);
                            String json = formatExperiment && !"platform".equals(formatMode)
                                    ? formatters.computeIfAbsent(Thread.currentThread(), thread -> new ScalarFormatCache("cached".equals(formatMode))).write(emitted)
                                    : candidate ? GeometrySerializationProbe.candidate(emitted) : emitted.toString();
                            if (stages != null && stages.selected(ordinal)) stages.json(phase, cpu);
                            if (waits != null) waits.stage(ordinal, "json", phase, cpu);
                            addCpu(jsonCpu, cpu); jsonWall.addAndGet(System.nanoTime() - phase);
                            // Compare a bounded preflight digest, not a second serialization in the timed loop.
                            phase = System.nanoTime();
                            byte[] utf8 = json.getBytes(StandardCharsets.UTF_8);
                            if (boundaries && firstCapture) {
                                // Clean setup still performs exactly the same timed digest work.
                                // First round establishes it; later rounds must match, without preflight capture.
                                byte[] digest = geometryDigest(json, emitted);
                                byte[] previous = referenceGeometry.putIfAbsent(ref, digest);
                                if (previous != null && !Arrays.equals(previous, digest))
                                    throw new IllegalStateException("Geometry bytes changed");
                            } else if (!firstCapture && !Arrays.equals(referenceGeometry.get(ref), geometryDigest(json, emitted)))
                                throw new IllegalStateException("Geometry bytes changed");
                            if (waits != null) waits.stage(ordinal, "hash", phase, 0);
                            geometryCheckWall.addAndGet(System.nanoTime() - phase);
                            result.geometryBytes = utf8.length + 1;
                            result.image = recordConstructor.newInstance(ref, x, y, imageBytes.get(result.image), imageCrc.getInt(result.image),
                                    android.os.Build.VERSION.SDK_INT >= 30, json, result.geometryBytes);
                        } else if (referenceGeometry.containsKey(ref)) throw new IllegalStateException("Geometry record missing");
                        return result;
                    } finally { if (!bitmap.isRecycled()) bitmap.recycle(); owned.remove(bitmap); }
                }));
                peakDepth = Math.max(peakDepth, pending.size());
                if (serial) while (!pending.isEmpty()) completed.add(drain(output, pending, geometryRecords, waits, false));
            }
            while (!pending.isEmpty()) completed.add(drain(output, pending, geometryRecords, waits, true));
            long finishBegan = waits == null ? 0 : System.nanoTime();
            output.writeByte(2);
            if (sampleOutput == null) output.close(); else sampleOutput.finish();
            if (publishedOutput) {
                method(provider.getClass(), "verifyCaptureRoot", View.class).invoke(provider, root);
                // Real rename failure against a test-owned directory, not a mocked success flag.
                if ("publish".equals(outputFault)) {
                    if (file.exists() && !file.delete()) throw new IllegalStateException("Publish fixture cleanup failed");
                    if (!file.mkdir()) throw new IllegalStateException("Publish fixture unavailable");
                }
                if (pendingOutput.length() > 64_000_000 || !pendingOutput.renameTo(file)) {
                    if ("publish".equals(outputFault)) {
                        sampleOutput.injected = true;
                        throw new java.io.IOException("sample-output-publish");
                    }
                    throw new IllegalStateException("Sample output could not be published");
                }
                StringBuilder hash = new StringBuilder(64);
                for (byte value : sampleOutput.digest.digest()) hash.append(String.format("%02x", value & 0xff));
                outputSha256 = hash.toString();
            }
            Bundle geometryAnswer = new Bundle();
            if (formatExperiment) method(provider.getClass(), "verifyCaptureRoot", View.class).invoke(provider, root);
            writeGeometry.invoke(field(provider.getClass(), "output").get(provider), activity.getApplication(), nonce, SnapshotPipeline.ref(root), finishGeometry.invoke(geometryRecords), geometryAnswer);
            if (waits != null) waits.fileFinishNanos = System.nanoTime() - finishBegan;
            if (reused != null) {
                reused.close(); // Count UI dispatch and destruction in the real pipeline, not after validation.
                if (reused.renderer.captures != 64 || reused.renderer.creations != 1 || !reused.renderer.closed
                        || reused.renderer.active || reused.renderer.acquiredImages != 0)
                    throw new IllegalStateException("Hardware pipeline resource/count mismatch");
            }
            if (traceActive) { android.os.Trace.endSection(); traceActive = false; }
            elapsed = System.nanoTime() - started;
            if (stages != null) stages.finishThreads();
            if (methodWindow != null) methodWindow.close();
            if (boundaries) after = SnapshotBoundary.read(activity);
            if (memory != null) { memory.close(); memoryReport = memory.report(); }
            // Image decoding and file checks are outside the measured pipeline.
            long validationStarted = System.nanoTime();
            if (completed.size() != 407 || file.length() > 64_000_000) throw new IllegalStateException("Image output budget/count differs");
            int geometryCount = 0;
            MessageDigest pagePixels = MessageDigest.getInstance("SHA-256");
            try (DataInputStream input = new DataInputStream(new FileInputStream(file))) {
              if (input.readLong() != Long.parseUnsignedLong(nonce, 16)) throw new IllegalStateException("Image nonce changed");
              for (Result result : completed) {
                if (input.readUnsignedByte() != 1 || !input.readUTF().equals(result.ref) || !input.readBoolean()
                        || input.readInt() != result.x || input.readInt() != result.y) throw new IllegalStateException("Image metadata changed");
                int size = input.readInt();
                if (size <= 0 || size > 10_000_000) throw new IllegalStateException("Image budget exceeded");
                byte[] image = new byte[size]; input.readFully(image);
                if (outputExperiment || formatExperiment) {
                    byte[] digest = MessageDigest.getInstance("SHA-256").digest(image);
                    byte[] previous = referenceEncoded.putIfAbsent(result.ref, digest);
                    if (previous != null && !Arrays.equals(previous, digest)) throw new IllegalStateException("Encoded image bytes changed");
                }
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    java.util.zip.CRC32 crc = new java.util.zip.CRC32(); crc.update(image);
                    if (input.readInt() != (int) crc.getValue()) throw new IllegalStateException("Image CRC changed");
                }
                Bitmap decoded = BitmapFactory.decodeByteArray(image, 0, image.length);
                if (decoded == null) throw new IllegalStateException("Image did not decode");
                try {
                    if (decoded.getWidth() != result.width || decoded.getHeight() != result.height) throw new IllegalStateException("Image dimensions changed");
                    byte[] pixels = pixelHash.digest(decoded);
                    pagePixels.update(pixels);
                    byte[] previous = referencePixels.putIfAbsent(result.ref, pixels);
                    if (previous != null && !Arrays.equals(previous, pixels)) throw new IllegalStateException("Pixels changed: " + result.ref);
                } finally { decoded.recycle(); }
                if (result.geometryBytes > 0) {
                    bytes += result.geometryBytes;
                    geometryCount++;
                }
                }
                if (input.readUnsignedByte() != 2 || input.read() != -1) throw new IllegalStateException("Image trailer changed");
            }
            if (geometryCount != 405 || bytes > 3_900_000) throw new IllegalStateException("Geometry budget/count differs");
            if (!owned.isEmpty()) throw new IllegalStateException("Bitmap not released");
            long validationNanos = System.nanoTime() - validationStarted;
            Bundle phases = new Bundle(); timingReply.invoke(timing, phases);
            JSONObject answer = new JSONObject().put("serial", serial).put("candidate", candidate)
                    .put("lightweight", lightweight)
                    .put("uiBatchSize", uiBatchSize).put("uiPosts", uiPosts).put("twoFrameTasks", twoFrameTasks)
                    .put("uiDispatch", async ? "async" : "normal")
                    .put("uiBatchGeometry", uiBatchSize > 0 || formatExperiment ? "sdk-immutable" : "unchanged")
                    .put("uiQueueNanos", uiQueueNanos).put("uiTaskNanos", uiTaskNanos).put("uiTaskMaxNanos", uiTaskMaxNanos)
                    .put("wallNanos", elapsed).put("images", completed.size()).put("geometryRecords", geometryCount)
                    .put("geometryBytes", bytes).put("peakDepth", peakDepth).put("pixelsVerified", true)
                    .put("pixelSha256", hex(pagePixels.digest())).put("geometryCheckWallNanos", geometryCheckWall.get())
                    .put("geometryNonce", nonce).put("geometryFileBytes", geometryAnswer.getLong("geometryBytes"))
                    .put("geometrySha256", geometryAnswer.getString("geometrySha256"))
                    .put("processInstance", field(provider.getClass(), "processInstance").get(provider))
                    .put("rootRef", SnapshotPipeline.ref(root))
                    .put("encodeWallNanos", encodeWall.get()).put("jsonWallNanos", jsonWall.get());
            if (encodeCpu.get() >= 0) answer.put("encodeCpuNanos", encodeCpu.get());
            if (jsonCpu.get() >= 0) answer.put("jsonCpuNanos", jsonCpu.get());
            if (systemTrace) answer.put("traceMarkers", true).put("traceCaptureCount", 407)
                    .put("schedulerFileReads", 0).put("extraCaptures", 0);
            if (methodTrace) answer.put("methodTrace", true).put("schedulerFileReads", 0).put("extraCaptures", 0);
            if (formatExperiment) {
                JSONArray caches = new JSONArray();
                for (ScalarFormatCache formatter : formatters.values()) caches.put(formatter.stats());
                answer.put("formatMode", formatMode).put("cacheWorkers", caches)
                        .put("cacheMaxEntries", ScalarFormatCache.MAX_ENTRIES).put("cacheMaxBytes", ScalarFormatCache.MAX_BYTES)
                        .put("requestLocalCache", true).put("encodedBytesVerified", true).put("outputRootVerified", true)
                        .put("outputBufferBytes", 65536);
            }
            JSONObject sdkPhases = new JSONObject();
            for (String key : phases.keySet()) {
                if (key.startsWith("geometryJson") || key.startsWith("geometryUtf8") || key.startsWith("geometryDisk")
                        || key.startsWith("geometryWrite") || key.startsWith("encode")) continue;
                sdkPhases.put(key, phases.getLong(key));
            }
            answer.put("sdkPhases", sdkPhases);
            if (sampleOutput != null) {
                if (!sampleOutput.descriptorClosed()) throw new IllegalStateException("Output descriptor leaked");
                answer.put("bufferedOutput", buffered).put("outputBufferBytes", buffered ? SampleOutput.BUFFER_BYTES : 0)
                        .put("outputDescriptorClosed", true).put("encodedBytesVerified", true)
                        .put("outputCloseNanos", sampleOutput.closeNanos).put("outputInitFlushCloseIncluded", true);
                if (activeWrites != null) answer.put("outputTimings", activeWrites.report());
                if (publishedOutput) {
                    MessageDigest storedDigest = MessageDigest.getInstance("SHA-256");
                    try (java.io.FileInputStream stored = new java.io.FileInputStream(file)) {
                        byte[] block = new byte[65536]; int length;
                        while ((length = stored.read(block)) != -1) storedDigest.update(block, 0, length);
                    }
                    StringBuilder storedHash = new StringBuilder(64);
                    for (byte value : storedDigest.digest()) storedHash.append(String.format("%02x", value & 0xff));
                    if (!outputSha256.equals(storedHash.toString())) throw new IllegalStateException("Published output digest mismatch");
                    answer.put("outputSha256", outputSha256).put("outputDigestVerified", true).put("outputPublished", file.isFile())
                            .put("outputPendingRemoved", !pendingOutput.exists()).put("outputRootVerified", true);
                }
            }
            if (waits != null) answer.put("pipelineWaits", waits.report(elapsed));
            if ("hardware-pipeline-comparison".equals(activity.getIntent().getStringExtra("geometryPipelineCase")))
                answer.put("hardwareReuse", hardwareReuse).put("replacedLayers", reused == null ? 0 : reused.renderer.captures)
                        .put("rendererCreations", reused == null ? 0 : reused.renderer.creations)
                        .put("rendererClosed", reused == null || reused.renderer.closed)
                        .put("rendererCloseNanos", reused == null ? 0 : reused.closeNanos)
                        .put("reuseDrawIncludesCpuCopy", hardwareReuse);
            if (boundaries) answer.put("boundaryBefore", before).put("boundaryAfterPipeline", after)
                    .put("boundaryAfterValidation", SnapshotBoundary.read(activity)).put("validationNanos", validationNanos)
                    .put("timedGeometryDigest", true);
            if (memoryReport != null) answer.put("sampledMemory", memoryReport);
            if (stages != null) {
                // Extra diagnostic work is after the full SDK timing/validation, not a replacement capture path.
                long diagnosticStarted = System.nanoTime();
                for (int ordinal = MatchedStageProbe.FIRST; ordinal < MatchedStageProbe.END; ordinal++) {
                    if (activity.isDestroyed() || android.os.SystemClock.uptimeMillis() > deadline)
                        throw new IllegalStateException("Matched diagnostic expired");
                    final int target = ordinal;
                    View current = views.get(target);
                    UiTaskBatch.Result extra = UiTaskBatch.capture(1, offset -> {
                        java.util.IdentityHashMap<View, String> identities = new java.util.IdentityHashMap<>(16);
                        ImmutableGeometry evidence = ImmutableGeometry.read(current, root, identities);
                        Bitmap diagnostic = stages.proxyCapture(current, target);
                        try {
                            if (!evidence.matches(current, root, identities)) throw new IllegalStateException("Diagnostic View changed");
                            return diagnostic;
                        } catch (Throwable failure) { diagnostic.recycle(); throw failure; }
                    }, item -> ((Bitmap) item).recycle(), new java.util.concurrent.atomic.AtomicBoolean());
                    Bitmap diagnostic = (Bitmap) extra.frames.get(0);
                    try {
                        if (!Arrays.equals(referencePixels.get(SnapshotPipeline.ref(current)), pixelHash.digest(diagnostic)))
                            throw new IllegalStateException("Diagnostic pixels differ");
                    } finally { diagnostic.recycle(); }
                }
                answer.put("matchedStages", stages.report().put("extraDiagnosticNanos", System.nanoTime() - diagnosticStarted));
            }
            if (methodWindow != null) answer.put("methodWindow", methodWindow.report());
            success = true;
            return answer;
        } finally {
            if (traceActive) android.os.Trace.endSection();
            activeWrites = null;
            try {
                try { if (reused != null) reused.close(); }
                finally { if (methodWindow != null) methodWindow.close(); }
            }
            finally {
                if (memory != null) memory.close();
                workers.shutdownNow();
                if (!workers.awaitTermination(5, TimeUnit.SECONDS)) throw new IllegalStateException("Load workers did not stop");
                formatters.clear();
                for (Bitmap bitmap : owned) if (!bitmap.isRecycled()) bitmap.recycle();
                if (pendingOutput.exists() && !pendingOutput.delete()) throw new IllegalStateException("Pending output could not be discarded");
                if (!success && file.exists() && !file.delete()) throw new IllegalStateException("Failed load output could not be discarded");
                if (!success && geometryFile.exists() && !geometryFile.delete()) throw new IllegalStateException("Failed geometry output could not be discarded");
            }
        }
    }

    private Result drain(DataOutputStream output, ArrayDeque<Future<Result>> pending, Object geometryRecords) throws Exception {
        return drain(output, pending, geometryRecords, null, false);
    }

    private Result drain(DataOutputStream output, ArrayDeque<Future<Result>> pending, Object geometryRecords, PipelineWaitProbe waits, boolean tail) throws Exception {
        long began = waits == null ? 0 : System.nanoTime();
        Result result = pending.removeFirst().get(10, TimeUnit.SECONDS);
        long got = waits == null ? 0 : System.nanoTime();
        long writeBegan = activeWrites == null ? 0 : System.nanoTime();
        write.invoke(null, output, CompletableFuture.completedFuture(result.image));
        long appended = activeWrites == null ? 0 : System.nanoTime();
        addGeometry.invoke(geometryRecords, result.image);
        if (activeWrites != null) {
            activeWrites.records++;
            activeWrites.recordWriteNanos += appended - writeBegan;
            activeWrites.geometryAppendNanos += System.nanoTime() - appended;
        }
        result.image = null; // Keep only bounded verification metadata, like production draining.
        if (waits != null) waits.drained(result.ordinal, got - began, System.nanoTime() - got, tail);
        return result;
    }

    private void verifyImmutableProtocol(Class<?> sdk) throws Exception {
        Method legacy = method(sdk, "captureParentContext", View.class, View.class, JSONArray.class);
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        activity.runOnUiThread(() -> {
            try {
                for (View view : views) {
                    java.util.IdentityHashMap<View, String> identities = new java.util.IdentityHashMap<>(16);
                    ImmutableGeometry evidence = ImmutableGeometry.read(view, root, identities);
                    JSONArray clips = new JSONArray();
                    JSONArray chain = (JSONArray) legacy.invoke(null, view, root, clips);
                    JSONObject expected = new JSONObject().put("ref", SnapshotPipeline.ref(view)).put("rootRef", SnapshotPipeline.ref(root))
                            .put("started", 1L).put("ended", 2L)
                            .put("rootReached", chain.getJSONArray(chain.length() - 1).getString(0).equals(SnapshotPipeline.ref(root)))
                            .put("chain", chain).put("clipContext", clips);
                    JSONArray screen = clips.getJSONObject(0).optJSONArray("localToScreen");
                    if (screen != null) expected.put("localToScreen", screen).put("bitmapSpace", "view-local");
                    if (!expected.toString().equals(evidence.json(1, 2).toString()) || !evidence.matches(view, root, identities))
                        throw new IllegalStateException("Immutable geometry protocol mismatch");
                    float alpha = view.getAlpha();
                    try {
                        view.setAlpha(alpha == 0.5f ? 0.75f : 0.5f);
                        if (evidence.matches(view, root, identities)) throw new IllegalStateException("Alpha mutation accepted");
                    } finally { view.setAlpha(alpha); }
                }
                // Isolated fixture: mutations must be rejected without touching the page.
                android.widget.FrameLayout parent = new android.widget.FrameLayout(activity);
                View child = new View(activity); parent.addView(child);
                Runnable[] changes = {
                    () -> parent.setAlpha(0.5f), () -> parent.setTranslationX(3),
                    () -> parent.setPadding(1, 2, 3, 4), () -> parent.scrollTo(2, 3),
                    () -> parent.setClipBounds(new android.graphics.Rect(1, 2, 9, 10)),
                    () -> parent.setClipChildren(false), () -> parent.setClipToPadding(false),
                    () -> parent.setClipToOutline(true), () -> parent.setVisibility(View.INVISIBLE),
                    () -> parent.removeView(child)
                };
                for (Runnable change : changes) {
                    java.util.IdentityHashMap<View, String> identities = new java.util.IdentityHashMap<>(16);
                    ImmutableGeometry evidence = ImmutableGeometry.read(child, parent, identities);
                    try {
                        change.run();
                        if (evidence.matches(child, parent, identities)) throw new IllegalStateException("Parent mutation accepted");
                    } finally {
                        parent.setAlpha(1); parent.setTranslationX(0); parent.setPadding(0, 0, 0, 0); parent.scrollTo(0, 0);
                        parent.setClipBounds(null); parent.setClipChildren(true); parent.setClipToPadding(true);
                        parent.setClipToOutline(false); parent.setVisibility(View.VISIBLE);
                        if (child.getParent() == null) parent.addView(child);
                    }
                }
                immutableProtocolVerified = true;
            } catch (Throwable error) { failure.set(error); }
            finally { done.countDown(); }
        });
        if (!done.await(15, TimeUnit.SECONDS)) throw new IllegalStateException("Immutable verification timeout");
        if (failure.get() != null) throw new IllegalStateException("Immutable verification failed", failure.get());
    }

    private static final class LightFrame {
        final Bitmap bitmap;
        final int x, y;
        final ImmutableGeometry evidence;
        final long started, ended;
        LightFrame(Bitmap bitmap, int x, int y, ImmutableGeometry evidence, long started, long ended) {
            this.bitmap = bitmap; this.x = x; this.y = y; this.evidence = evidence; this.started = started; this.ended = ended;
        }
    }

    // Fault injection only in the Debug sample; never used by performance rounds.
    private static final class CaptureHooks {
        final CountDownLatch posted = new CountDownLatch(1), finished = new CountDownLatch(1);
        volatile Bitmap bitmap;
        Runnable beforeSnapshot, afterDraw, afterSnapshot, afterHandoff;
        long waitMillis = 3000;
    }

    private LightFrame captureLight(View view, Object timing) throws Exception {
        return captureLight(view, timing, null);
    }

    private LightFrame captureLight(View view, Object timing, CaptureHooks hooks) throws Exception {
        // Same queue/ownership boundary as SDK capture; no prototype switch in the SDK.
        Object lock = new Object();
        boolean[] abandoned = { false };
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<LightFrame> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        java.util.HashMap<String, AtomicLong> counters = new java.util.HashMap<>();
        for (String name : new String[] { "queue", "context", "contextCpu", "draw", "drawCpu", "verify", "verifyCpu", "uiTaskMax", "snapshotPrepare", "snapshotInvoke", "snapshotInvokeMax" })
            counters.put(name, (AtomicLong) field(timing.getClass(), name).get(timing));
        long posted = System.nanoTime();
        if (!new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            long task = System.nanoTime();
            counters.get("queue").addAndGet(task - posted);
            Bitmap bitmap = null;
            try {
                synchronized (lock) { if (abandoned[0]) return; }
                long phase = System.nanoTime(), cpu = Debug.threadCpuTimeNanos();
                if (!view.isAttachedToWindow() || view.getRootView() != root || !view.isShown()) return;
                int[] before = new int[2]; view.getLocationOnScreen(before);
                int width = view.getWidth(), height = view.getHeight();
                java.util.IdentityHashMap<View, String> identities = new java.util.IdentityHashMap<>(16);
                ImmutableGeometry evidence = (boolean) rectangle.invoke(null, view, root) ? ImmutableGeometry.read(view, root, identities) : null;
                counters.get("context").addAndGet(System.nanoTime() - phase); addCpu(counters.get("contextCpu"), cpu);
                long started = android.os.SystemClock.uptimeMillis();
                phase = System.nanoTime(); cpu = Debug.threadCpuTimeNanos();
                long[] phases = new long[2];
                try {
                    if (hooks != null && hooks.beforeSnapshot != null) hooks.beforeSnapshot.run();
                    bitmap = (Bitmap) snapshot.invoke(null, view, phases);
                }
                finally {
                    if (hooks != null && hooks.afterDraw != null) hooks.afterDraw.run();
                    counters.get("draw").addAndGet(System.nanoTime() - phase); addCpu(counters.get("drawCpu"), cpu);
                    counters.get("snapshotPrepare").addAndGet(phases[0]); counters.get("snapshotInvoke").addAndGet(phases[1]);
                    counters.get("snapshotInvokeMax").accumulateAndGet(phases[1], Math::max);
                }
                if (bitmap == null) return;
                if (hooks != null) { hooks.bitmap = bitmap; if (hooks.afterSnapshot != null) hooks.afterSnapshot.run(); }
                phase = System.nanoTime(); cpu = Debug.threadCpuTimeNanos();
                try {
                    int[] after = new int[2]; view.getLocationOnScreen(after);
                    if (!view.isAttachedToWindow() || view.getRootView() != root || !view.isShown()
                            || width != view.getWidth() || height != view.getHeight() || before[0] != after[0] || before[1] != after[1]
                            || bitmap.getWidth() != width || bitmap.getHeight() != height) return;
                    long ended = android.os.SystemClock.uptimeMillis();
                    if (evidence != null && !evidence.matches(view, root, identities)) return;
                    synchronized (lock) {
                        if (!abandoned[0]) { result.set(new LightFrame(bitmap, before[0], before[1], evidence, started, ended)); bitmap = null; }
                    }
                    if (hooks != null && hooks.afterHandoff != null) hooks.afterHandoff.run();
                } finally { counters.get("verify").addAndGet(System.nanoTime() - phase); addCpu(counters.get("verifyCpu"), cpu); }
            } catch (Throwable error) { failure.set(error); }
            finally {
                if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
                counters.get("uiTaskMax").accumulateAndGet(System.nanoTime() - task, Math::max); done.countDown();
                if (hooks != null) hooks.finished.countDown();
            }
        })) throw new IllegalStateException("UI queue unavailable");
        if (hooks != null) hooks.posted.countDown();
        boolean completed;
        try { completed = done.await(hooks == null ? 3000 : hooks.waitMillis, TimeUnit.MILLISECONDS); }
        catch (InterruptedException error) {
            synchronized (lock) { abandoned[0] = true; LightFrame late = result.getAndSet(null); if (late != null) late.bitmap.recycle(); }
            Thread.currentThread().interrupt();
            throw error;
        }
        if (!completed) {
            synchronized (lock) { abandoned[0] = true; LightFrame late = result.getAndSet(null); if (late != null) late.bitmap.recycle(); }
            throw new IllegalStateException("UI capture timeout");
        }
        if (failure.get() != null) {
            synchronized (lock) { abandoned[0] = true; LightFrame late = result.getAndSet(null); if (late != null) late.bitmap.recycle(); }
            throw new IllegalStateException("UI capture failed", failure.get());
        }
        if (counters.get("contextCpu").get() < 0 || counters.get("drawCpu").get() < 0 || counters.get("verifyCpu").get() < 0)
            ((java.util.concurrent.atomic.AtomicBoolean) field(timing.getClass(), "cpuAvailable").get(timing)).set(false);
        return result.get();
    }

    private JSONObject verifySdkFrames() throws Exception {
        Class<?> sdk = capture.getDeclaringClass();
        Method current = method(sdk, "captureFrame", View.class, View.class, boolean.class, timingConstructor.getDeclaringClass(), boolean.class);
        Field immutable = field(frameBitmap.getDeclaringClass(), "immutableGeometry");
        Field started = field(frameBitmap.getDeclaringClass(), "started"), ended = field(frameBitmap.getDeclaringClass(), "ended");
        Method json = method(Class.forName(sdk.getPackage().getName() + ".CaptureGeometrySnapshot"), "json", long.class, long.class);
        Object timing = timingConstructor.newInstance();
        int records = 0;
        for (View view : views) {
            Object old = capture.invoke(null, view, root, true, timing);
            if (old == null) throw new IllegalStateException("Legacy fixture changed");
            Bitmap oldBitmap = (Bitmap) frameBitmap.get(old);
            Bitmap newBitmap = null;
            try {
                Object frame = current.invoke(null, view, root, true, timing, true);
                if (frame == null) throw new IllegalStateException("SDK fixture changed");
                newBitmap = (Bitmap) frameBitmap.get(frame);
                if (frameX.getInt(old) != frameX.getInt(frame) || frameY.getInt(old) != frameY.getInt(frame)
                        || oldBitmap.getWidth() != newBitmap.getWidth() || oldBitmap.getHeight() != newBitmap.getHeight()
                        || !Arrays.equals(bitmapDigest(oldBitmap), bitmapDigest(newBitmap)))
                    throw new IllegalStateException("SDK pixels/position changed");
                JSONObject expected = (JSONObject) frameGeometry.get(old);
                Object evidence = immutable.get(frame);
                if ((expected == null) != (evidence == null) || frameGeometry.get(frame) != null)
                    throw new IllegalStateException("SDK geometry qualification changed");
                if (evidence != null) {
                    JSONObject actual = (JSONObject) json.invoke(evidence, started.getLong(frame), ended.getLong(frame));
                    if (!Arrays.equals(geometryDigest(expected.toString(), expected), geometryDigest(actual.toString(), actual)))
                        throw new IllegalStateException("SDK geometry bytes changed");
                    records++;
                }
            } finally { oldBitmap.recycle(); if (newBitmap != null) newBitmap.recycle(); }
        }
        if (records != 405) throw new IllegalStateException("SDK geometry record count changed");
        return new JSONObject().put("images", views.size()).put("records", records)
                .put("pixelAndProtocolVerified", true).put("noUiJson", true);
    }

    private byte[] bitmapDigest(Bitmap source) throws Exception {
        Bitmap bitmap = android.os.Build.VERSION.SDK_INT >= 26 && source.getConfig() == Bitmap.Config.HARDWARE
                ? source.copy(Bitmap.Config.ARGB_8888, false) : source;
        if (bitmap == null) throw new IllegalStateException("Pixel readback unavailable");
        try { return pixelHash.digest(bitmap); } finally { if (bitmap != source) bitmap.recycle(); }
    }

    private static final class FaultView extends View {
        Runnable mutation;
        boolean armed;
        FaultView(Activity activity) { super(activity); }
        @Override protected void onDraw(android.graphics.Canvas canvas) {
            canvas.drawColor(android.graphics.Color.RED);
            if (armed && mutation != null) mutation.run();
        }
    }

    private void onUi(Runnable action) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        activity.runOnUiThread(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } finally { done.countDown(); } });
        if (!done.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Fixture UI timeout");
        if (failure.get() != null) throw new IllegalStateException("Fixture UI failed", failure.get());
    }

    private static void await(CountDownLatch latch) {
        try { if (!latch.await(2, TimeUnit.SECONDS)) throw new IllegalStateException("Fault latch timeout"); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException(error); }
    }

    private JSONObject verifyLightCaptureFaults() throws Exception {
        android.widget.FrameLayout parent = new android.widget.FrameLayout(activity);
        FaultView view = new FaultView(activity);
        onUi(() -> {
            ((android.view.ViewGroup) root).addView(parent, new android.view.ViewGroup.LayoutParams(32, 32));
            parent.addView(view, new android.widget.FrameLayout.LayoutParams(32, 32));
            parent.layout(0, 0, 32, 32); view.layout(0, 0, 32, 32);
        });
        JSONArray results = new JSONArray();
        try {
            String[] names = { "parent-alpha", "parent-clip", "parent-translation", "child-size", "detach" };
            Runnable[] changes = { () -> parent.setAlpha(0.5f),
                    () -> parent.setClipBounds(new android.graphics.Rect(1, 1, 20, 20)),
                    () -> parent.setTranslationX(3), () -> view.layout(0, 0, 33, 32), () -> parent.removeView(view) };
            for (int i = 0; i < names.length; i++) {
                final Runnable change = changes[i];
                CaptureHooks hooks = new CaptureHooks();
                hooks.beforeSnapshot = () -> view.armed = true;
                hooks.afterDraw = () -> view.armed = false;
                onUi(() -> view.mutation = change);
                LightFrame frame = captureLight(view, timingConstructor.newInstance(), hooks);
                if (frame != null) { frame.bitmap.recycle(); throw new IllegalStateException("Draw mutation accepted: " + names[i]); }
                await(hooks.finished);
                if (hooks.bitmap == null || !hooks.bitmap.isRecycled()) throw new IllegalStateException("Rejected bitmap leaked");
                results.put(new JSONObject().put("case", names[i]).put("rejected", true).put("bitmapRecycled", true));
                onUi(() -> {
                    view.mutation = null; parent.setAlpha(1); parent.setClipBounds(null); parent.setTranslationX(0);
                    if (view.getParent() == null) parent.addView(view, new android.widget.FrameLayout.LayoutParams(32, 32));
                    parent.layout(0, 0, 32, 32); view.layout(0, 0, 32, 32);
                });
            }
            for (String name : new String[] { "cancel-queued", "cancel-after-draw", "cancel-after-handoff", "timeout-late" }) {
                CaptureHooks hooks = new CaptureHooks();
                CountDownLatch reached = new CountDownLatch(1), release = new CountDownLatch(1);
                Runnable block = () -> { reached.countDown(); await(release); };
                if (name.equals("cancel-queued")) {
                    new android.os.Handler(android.os.Looper.getMainLooper()).post(block); await(reached);
                } else if (name.equals("cancel-after-handoff")) hooks.afterHandoff = block;
                else hooks.afterSnapshot = block;
                if (name.equals("timeout-late")) hooks.waitMillis = 50;
                AtomicReference<Throwable> outcome = new AtomicReference<>();
                Object timing = timingConstructor.newInstance();
                Thread caller = new Thread(() -> {
                    try {
                        LightFrame frame = captureLight(view, timing, hooks);
                        if (frame != null) frame.bitmap.recycle();
                        outcome.set(new AssertionError("Canceled frame returned"));
                    } catch (Throwable error) { outcome.set(error); }
                }, "immutable-fault-caller");
                try {
                    caller.start(); await(hooks.posted); await(reached);
                    if (!name.equals("timeout-late")) caller.interrupt();
                    caller.join(1000);
                    Throwable failure = outcome.get();
                    if (caller.isAlive() || failure == null ||
                            (name.equals("timeout-late") ? !failure.toString().contains("UI capture timeout") : !(failure instanceof InterruptedException)))
                        throw new IllegalStateException("Wrong cancellation result: " + name, failure);
                } finally { release.countDown(); caller.join(3000); }
                await(hooks.finished);
                if (name.equals("cancel-queued") ? hooks.bitmap != null : hooks.bitmap == null || !hooks.bitmap.isRecycled())
                    throw new IllegalStateException("Late bitmap leaked: " + name);
                results.put(new JSONObject().put("case", name).put("rejected", true).put("bitmapRecycled", true)
                        .put("callerStopped", !caller.isAlive()));
            }
            int sdkMutations = 0;
            boolean sdkQueueOwnership = false;
            if (activity.getIntent().getBooleanExtra("geometrySdkProbe", false)) {
                java.util.HashSet<Bitmap> pending = new java.util.HashSet<>();
                Bitmap queued = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
                Bitmap claimed = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
                Method register = method(encode.getDeclaringClass(), "registerPendingBitmap", java.util.HashSet.class, Bitmap.class);
                Method claim = method(encode.getDeclaringClass(), "claimPendingBitmap", java.util.HashSet.class, Bitmap.class);
                Method recycle = method(encode.getDeclaringClass(), "recyclePendingBitmaps", java.util.HashSet.class);
                try {
                    register.invoke(null, pending, queued); register.invoke(null, pending, claimed);
                    if (!(boolean) claim.invoke(null, pending, claimed)) throw new IllegalStateException("Encoder cannot claim bitmap");
                    recycle.invoke(null, pending);
                    if (!queued.isRecycled() || claimed.isRecycled() || !pending.isEmpty()
                            || (boolean) claim.invoke(null, pending, queued))
                        throw new IllegalStateException("Queue cancellation ownership differs");
                    sdkQueueOwnership = true;
                } finally { if (!queued.isRecycled()) queued.recycle(); claimed.recycle(); }
                Method uiCapture = method(capture.getDeclaringClass(), "captureFrameOnUiThread", View.class, View.class,
                        boolean.class, boolean.class, timingConstructor.getDeclaringClass(), boolean.class);
                Object timing = timingConstructor.newInstance();
                for (Runnable change : changes) {
                    AtomicReference<Object> frame = new AtomicReference<>();
                    onUi(() -> {
                        view.mutation = change; view.armed = true;
                        try { frame.set(uiCapture.invoke(null, view, root, true, true, timing, true)); }
                        catch (Exception error) { throw new IllegalStateException(error); }
                        finally { view.armed = false; }
                    });
                    if (frame.get() != null) {
                        ((Bitmap) frameBitmap.get(frame.get())).recycle();
                        throw new IllegalStateException("SDK accepted draw mutation");
                    }
                    sdkMutations++;
                    onUi(() -> {
                        view.mutation = null; parent.setAlpha(1); parent.setClipBounds(null); parent.setTranslationX(0);
                        if (view.getParent() == null) parent.addView(view, new android.widget.FrameLayout.LayoutParams(32, 32));
                        parent.layout(0, 0, 32, 32); view.layout(0, 0, 32, 32);
                    });
                }
                Method current = method(capture.getDeclaringClass(), "captureFrame", View.class, View.class, boolean.class,
                        timingConstructor.getDeclaringClass(), boolean.class);
                Object frame = current.invoke(null, view, root, true, timing, true);
                if (frame == null) throw new IllegalStateException("SDK did not recover after mutations");
                ((Bitmap) frameBitmap.get(frame)).recycle();
            }
            LightFrame recovered = captureLight(view, timingConstructor.newInstance());
            if (recovered == null || recovered.evidence == null) throw new IllegalStateException("Capture did not recover");
            try {
                JSONObject geometry = recovered.evidence.json(recovered.started, recovered.ended);
                if (!geometry.getBoolean("rootReached") || recovered.bitmap.getWidth() != 32 || recovered.bitmap.getHeight() != 32)
                    throw new IllegalStateException("Recovered frame differs");
            } finally { recovered.bitmap.recycle(); }
            return new JSONObject().put("cases", results).put("recovered", true).put("fixtureRemoved", true)
                    .put("sdkDrawMutationsRejected", sdkMutations).put("sdkQueueOwnership", sdkQueueOwnership);
        } finally { onUi(() -> ((android.view.ViewGroup) root).removeView(parent)); }
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) value.append(Character.forDigit((item & 255) >>> 4, 16)).append(Character.forDigit(item & 15, 16));
        return value.toString();
    }

    private static byte[] geometryDigest(String json, JSONObject source) throws Exception {
        // Captures have different timestamps. Check their actual emitted values, but normalize
        // only these two fields for fixture comparison; never alter the SDK output record.
        for (String key : new String[] { "started", "ended" }) {
            long value = source.getLong(key);
            String token = "\"" + key + "\":" + value + ",";
            int offset = json.indexOf(token);
            if (value < 0 || offset < 0 || offset != json.lastIndexOf(token))
                throw new IllegalStateException("Geometry timestamp differs");
            json = json.replace(token, "\"" + key + "\":0,");
        }
        if (source.getLong("ended") < source.getLong("started")) throw new IllegalStateException("Geometry time reversed");
        return MessageDigest.getInstance("SHA-256").digest(json.getBytes(StandardCharsets.UTF_8));
    }

    private static void addCpu(AtomicLong target, long started) {
        long ended = Debug.threadCpuTimeNanos();
        if (started < 0 || ended < started) target.set(-1);
        else target.updateAndGet(value -> value < 0 ? value : value + ended - started);
    }
}

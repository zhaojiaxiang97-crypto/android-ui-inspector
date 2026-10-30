package com.androiduiinspector.sample;

import com.androiduiinspector.sdk.DebugCaptureProbe;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.SystemClock;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.ConcurrentHashMap;

/** Debug sample only: reuse the real SDK encoder/writer without adding a production switch. */
final class SnapshotPipeline implements AutoCloseable {
    private final ExecutorService workers = Executors.newFixedThreadPool(2);
    private final ArrayDeque<Future<DebugCaptureProbe.EncodedLayer>> pending = new ArrayDeque<>();
    private final AtomicLong encodeMs = new AtomicLong();
    private final AtomicLong decodedChanges = new AtomicLong();
    private final AtomicLong ownedCount = new AtomicLong();
    private final AtomicLong ownedBytes = new AtomicLong();
    private long peakOwnedBytes, copyNanos;
    private int ownershipCopies;
    private final ConcurrentHashMap<String, byte[]> encodedReferences;
    private final SnapshotPixelHash pixelHash;
    private final DataOutputStream output;
    private final DebugCaptureProbe.GeometryRecords records = new DebugCaptureProbe.GeometryRecords();
    private final View root;
    private final String token;
    private final boolean verifyEnvelope;
    private final File directory;
    private final JSONArray refs = new JSONArray();
    private int count, peakDepth;
    private boolean closed;
    private volatile long tailStarted;
    private int tailPending;
    private final SnapshotTiming queueTiming = new SnapshotTiming(), encodeTiming = new SnapshotTiming(),
            decodeTiming = new SnapshotTiming(), verifyTiming = new SnapshotTiming(), geometryTiming = new SnapshotTiming();
    private long writeNanos, tailWriteNanos;

    SnapshotPipeline(Activity activity, View root, String token, ConcurrentHashMap<String, byte[]> encodedReferences, SnapshotPixelHash pixelHash, boolean verifyEnvelope) throws Exception {
        this.root = root; this.token = token;
        this.verifyEnvelope = verifyEnvelope;
        this.encodedReferences = encodedReferences;
        this.pixelHash = pixelHash;
        directory = new File(activity.getFilesDir(), "isolation-probe");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Pipeline directory unavailable");
        output = new DataOutputStream(new FileOutputStream(new File(directory, "pipeline.bin")));
        output.writeLong(Long.parseUnsignedLong(token, 16));
    }

    private static Method method(Class<?> type, String name, Class<?>... arguments) throws Exception {
        Method method = type.getDeclaredMethod(name, arguments); method.setAccessible(true); return method;
    }

    static String ref(View view) { return view.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(view)); }

    JSONObject captureGeometry(View view) throws Exception {
        Class<?> sdk = Class.forName("com.androiduiinspector.sdk.CaptureFrame");
        JSONArray chain = (JSONArray) method(sdk, "captureParentContext", View.class, View.class).invoke(null, view, root);
        return new JSONObject().put("ref", ref(view)).put("rootRef", ref(root))
                .put("started", SystemClock.uptimeMillis()).put("rootReached", chain.getJSONArray(chain.length() - 1).getString(0).equals(ref(root)))
                .put("chain", chain)
                .put("clipContext", method(sdk, "captureClipContext", View.class, View.class).invoke(null, view, root))
                .put("localToScreen", method(sdk, "captureScreenMatrix", View.class).invoke(null, view))
                .put("bitmapSpace", "view-local");
    }

    boolean ready() throws Exception {
        while (!pending.isEmpty() && pending.peekFirst().isDone()) drain();
        return pending.size() < 4;
    }

    private void drain() throws Exception {
        long started = System.nanoTime();
        Future<DebugCaptureProbe.EncodedLayer> future = pending.removeFirst();
        DebugCaptureProbe.EncodedLayer record = future.get();
        DebugCaptureProbe.writeRecord(output, record);
        records.add(record);
        count++;
        long ended = System.nanoTime();
        writeNanos += ended - started;
        if (tailStarted > 0) tailWriteNanos += Math.max(0, ended - Math.max(started, tailStarted));
    }

    int capacity() { return 4 - pending.size(); }

    void beginTail() {
        if (tailStarted == 0) { tailPending = pending.size(); tailStarted = System.nanoTime(); }
    }

    // true transfers the caller's readable bitmap; false preserves it using a new copy.
    void submit(Bitmap readable, JSONObject geometry, byte[] expected, boolean transfer) throws Exception {
        if (pending.size() >= 4 || closed) throw new IllegalStateException("Pipeline queue budget exceeded");
        String ref = geometry.getString("ref");
        JSONArray self = geometry.getJSONArray("chain").getJSONArray(0);
        int x = self.getInt(2), y = self.getInt(3), width = readable.getWidth(), height = readable.getHeight();
        geometry.put("ended", SystemClock.uptimeMillis()); refs.put(ref);
        long started = System.nanoTime();
        Bitmap owned = transfer ? readable : readable.copy(Bitmap.Config.ARGB_8888, false);
        if (owned == null) throw new IllegalStateException("Pipeline ownership copy failed");
        if (!transfer) { ownershipCopies++; copyNanos += System.nanoTime() - started; }
        long bytesOwned = owned.getAllocationByteCount();
        peakOwnedBytes = Math.max(peakOwnedBytes, ownedBytes.addAndGet(bytesOwned));
        ownedCount.incrementAndGet();
        long queuedAt = System.nanoTime();
        try {
            pending.addLast(workers.submit(() -> {
                try {
                long startedPhase = System.nanoTime();
                queueTiming.record(queuedAt, startedPhase, tailStarted, ref, width, height, 1);
                // No live View reads on this worker. Real SDK encoder owns/recycles the bitmap.
                DebugCaptureProbe.EncodedLayer image = DebugCaptureProbe.encode(owned, ref, x, y, true, encodeMs);
                long endedPhase = System.nanoTime();
                encodeTiming.record(startedPhase, endedPhase, tailStarted, ref, width, height, 1);
                byte[] bytes = image.bytes();
                startedPhase = System.nanoTime();
                Bitmap decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                endedPhase = System.nanoTime();
                decodeTiming.record(startedPhase, endedPhase, tailStarted, ref, width, height, 1);
                if (decoded == null) throw new IllegalStateException("Encoded image cannot be decoded");
                startedPhase = System.nanoTime();
                try {
                    if (decoded.getWidth() != width || decoded.getHeight() != height)
                        throw new IllegalStateException("Encoded dimensions differ");
                    byte[] decodedHash = pixelHash.digest(decoded);
                    if (!java.util.Arrays.equals(decodedHash, expected)) decodedChanges.incrementAndGet();
                    byte[] reference = encodedReferences.putIfAbsent(ref, decodedHash);
                    if (reference != null && !java.util.Arrays.equals(reference, decodedHash))
                        throw new IllegalStateException("Original and batched encoded pixels differ");
                } finally {
                    decoded.recycle();
                    verifyTiming.record(startedPhase, System.nanoTime(), tailStarted, ref, width, height, 1);
                }
                startedPhase = System.nanoTime();
                String json = geometry.toString();
                if (json.getBytes(StandardCharsets.UTF_8).length > 48_000) throw new IllegalStateException("Geometry record budget exceeded");
                DebugCaptureProbe.EncodedLayer record = image.withGeometry(json, json.getBytes(StandardCharsets.UTF_8).length + 1);
                geometryTiming.record(startedPhase, System.nanoTime(), tailStarted, ref, width, height, 1);
                return record;
                } finally { if (!owned.isRecycled()) owned.recycle(); ownedCount.decrementAndGet(); ownedBytes.addAndGet(-bytesOwned); }
            }));
            peakDepth = Math.max(peakDepth, pending.size());
        } catch (RuntimeException failure) { owned.recycle(); ownedCount.decrementAndGet(); ownedBytes.addAndGet(-bytesOwned); throw failure; }
    }

    JSONObject finish() throws Exception {
        if (!pending.isEmpty()) return null;
        long finalStarted = System.nanoTime();
        output.writeByte(2); output.close(); closed = true; workers.shutdown();
        JSONObject envelope = new JSONObject().put("version", 1).put("nonce", token).put("rootRef", ref(root))
                .put("processInstance", "sample-" + android.os.Process.myPid());
        String header = envelope.toString(), recordsJson = records.finish();
        // Match the SDK: records have already been serialized on workers. Do not parse them again.
        byte[] bytes = (header.substring(0, header.length() - 1) + ",\"records\":" + recordsJson + "}").getBytes(StandardCharsets.UTF_8);
        if (verifyEnvelope) {
            // Warmup only: strict equality against the former full-JSON path using all real records.
            byte[] legacy = envelope.put("records", new JSONArray(recordsJson)).toString().getBytes(StandardCharsets.UTF_8);
            if (!java.util.Arrays.equals(bytes, legacy)) throw new IllegalStateException("Geometry envelope bytes differ");
        }
        if (bytes.length > 4_000_000 || new File(directory, "pipeline.bin").length() > 64_000_000)
            throw new IllegalStateException("Pipeline output budget exceeded");
        try (FileOutputStream file = new FileOutputStream(new File(directory, "pipeline-geometry.json"))) { file.write(bytes); }
        if (ownedCount.get() != 0) throw new IllegalStateException("Pipeline bitmap ownership leaked");
        long finalNanos = System.nanoTime() - finalStarted;
        long hashedAt = System.nanoTime();
        String imageHash = fileHash(new File(directory, "pipeline.bin"));
        String geometryHash = fileHash(new File(directory, "pipeline-geometry.json"));
        long hashNanos = System.nanoTime() - hashedAt;
        return new JSONObject().put("encodedCount", count).put("peakDepth", peakDepth).put("encodeMs", encodeMs.get())
                .put("envelopeVerified", verifyEnvelope)
                .put("ownershipCopies", ownershipCopies).put("ownershipCopyMs", copyNanos / 1_000_000.0).put("peakOwnedBytes", peakOwnedBytes)
                .put("imageSha256", imageHash).put("geometrySha256", geometryHash)
                .put("stages", new JSONObject().put("queue", queueTiming.report()).put("encodeCall", encodeTiming.report())
                        .put("decode", decodeTiming.report()).put("verify", verifyTiming.report()).put("geometry", geometryTiming.report())
                        .put("writeMs", writeNanos / 1_000_000.0).put("tailWriteMs", tailWriteNanos / 1_000_000.0)
                        .put("finalizeMs", finalNanos / 1_000_000.0).put("outputHashMs", hashNanos / 1_000_000.0)
                        .put("tailPending", tailPending).put("tailWallMs", (System.nanoTime() - tailStarted) / 1_000_000.0))
                .put("decodedChanges", decodedChanges.get()).put("geometryBytes", bytes.length).put("refs", refs);
    }

    private static String fileHash(File file) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[8192];
        try (FileInputStream input = new FileInputStream(file)) { int read; while ((read = input.read(buffer)) != -1) hash.update(buffer, 0, read); }
        StringBuilder hex = new StringBuilder(); for (byte value : hash.digest()) hex.append(String.format("%02x", value & 255)); return hex.toString();
    }

    boolean released() { return workers.isTerminated() && ownedCount.get() == 0; }

    void discard() throws Exception {
        for (String name : new String[]{"pipeline.bin", "pipeline-geometry.json"}) {
            File file = new File(directory, name);
            if (file.exists() && !file.delete()) throw new IllegalStateException("Cannot discard failed sample output");
        }
    }

    @Override public void close() throws Exception {
        workers.shutdown();
        // Submitted encoders must finish recycling owned bitmaps; never discard queued work.
        if (!workers.awaitTermination(5, TimeUnit.SECONDS)) throw new IllegalStateException("Pipeline workers did not stop");
        if (!closed) output.close(); closed = true;
    }
}

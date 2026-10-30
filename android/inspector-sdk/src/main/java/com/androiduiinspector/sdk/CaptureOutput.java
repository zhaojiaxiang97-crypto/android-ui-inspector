package com.androiduiinspector.sdk;

import android.app.Application;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Debug;
import android.os.SystemClock;
import org.json.JSONObject;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.CRC32;
import static com.androiduiinspector.sdk.CaptureFrame.*;

/** Encodes detached capture results; never reads live Views or schedules UI work. */
final class CaptureOutput {
    private final String processInstance;

    CaptureOutput(String processInstance) { this.processInstance = processInstance; }

    static final int CAPTURE_OUTPUT_BUFFER_BYTES = 64 * 1024;

    static final class VisibleRecord {
        final String ref;
        final int x, y;
        final byte[] image;
        final int crc;
        final boolean webp;
        final String geometry;
        final int geometryBytes;
        VisibleRecord(String ref, int x, int y, byte[] image, int crc, boolean webp) {
            this(ref, x, y, image, crc, webp, null, 0);
        }
        VisibleRecord(String ref, int x, int y, byte[] image, int crc, boolean webp, String geometry, int geometryBytes) {
            this.ref = ref;
            this.x = x;
            this.y = y;
            this.image = image;
            this.crc = crc;
            this.webp = webp;
            this.geometry = geometry;
            this.geometryBytes = geometryBytes;
        }
    }

    static final class GeometryRecords {
        final StringBuilder json = new StringBuilder("[");
        int bytes;
        void add(VisibleRecord record) {
            if (record.geometry == null || bytes + record.geometryBytes > 3_900_000) return;
            if (json.length() > 1) json.append(',');
            json.append(record.geometry);
            bytes += record.geometryBytes;
        }
        String finish() { return json.toString() + "]"; }
    }

    static VisibleRecord encodeVisibleLayer(Bitmap bitmap, String ref, int x, int y, boolean webpLossless, AtomicLong encodeMs) {
        return encodeVisibleLayer(bitmap, ref, x, y, webpLossless, encodeMs, null);
    }

    static VisibleRecord encodeVisibleLayer(Bitmap bitmap, String ref, int x, int y, boolean webpLossless, AtomicLong encodeMs, CaptureTiming timing) {
        long imageStarted = SystemClock.uptimeMillis();
        long cpuStarted = timing == null ? 0 : Debug.threadCpuTimeNanos();
        try {
            ByteArrayOutputStream png = new ByteArrayOutputStream();
            Bitmap.CompressFormat format = webpLossless ? Bitmap.CompressFormat.WEBP_LOSSLESS : Bitmap.CompressFormat.PNG;
            if (!bitmap.compress(format, webpLossless ? 0 : 100, png) || png.size() > 10_000_000)
                throw new IllegalStateException("View image exceeds capture budget");
            byte[] image = png.toByteArray();
            int crc = 0;
            if (webpLossless) {
                CRC32 checksum = new CRC32();
                checksum.update(image);
                crc = (int) checksum.getValue();
            }
            return new VisibleRecord(ref, x, y, image, crc, webpLossless);
        } finally {
            if (timing != null) timing.addCpu(timing.encodeCpu, cpuStarted);
            encodeMs.addAndGet(SystemClock.uptimeMillis() - imageStarted);
            bitmap.recycle();
        }
    }

    static int writeVisibleRecord(DataOutputStream output, Future<VisibleRecord> future) throws Exception {
        return writeVisibleRecord(output, future, null);
    }

    static int writeVisibleRecord(DataOutputStream output, Future<VisibleRecord> future, GeometryRecords geometry) throws Exception {
        VisibleRecord record;
        try {
            record = future.get();
        } catch (ExecutionException wrapped) {
            Throwable cause = wrapped.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw wrapped;
        }
        output.writeByte(1);
        output.writeUTF(record.ref);
        output.writeByte(1);
        output.writeInt(record.x);
        output.writeInt(record.y);
        output.writeInt(record.image.length);
        output.write(record.image);
        if (record.webp) output.writeInt(record.crc);
        if (geometry != null) geometry.add(record);
        return 1;
    }

    void writeGeometryFile(Application app, String nonce, String rootRef, String records, Bundle answer) throws Exception {
        writeGeometryFile(app, nonce, rootRef, records, answer, null);
    }

    void writeGeometryFile(Application app, String nonce, String rootRef, String records, Bundle answer, CaptureTiming timing) throws Exception {
        if (nonce == null || !nonce.matches("[0-9a-f]{16}")) throw new IllegalStateException("Geometry requires nonce");
        JSONObject envelope = new JSONObject();
        envelope.put("version", 1).put("nonce", nonce).put("rootRef", rootRef)
                .put("processInstance", processInstance);
        String header = envelope.toString();
        // Records are serialized once off the UI thread, not again when writing the envelope.
        String document = header.substring(0, header.length() - 1) + ",\"records\":" + records + "}";
        long utf8Started = System.nanoTime(), utf8CpuStarted = timing == null ? 0 : Debug.threadCpuTimeNanos();
        byte[] bytes = document.getBytes(StandardCharsets.UTF_8);
        if (timing != null) {
            timing.addCpu(timing.geometryUtf8Cpu, utf8CpuStarted);
            timing.geometryUtf8.addAndGet(System.nanoTime() - utf8Started);
        }
        if (bytes.length > 4_000_000) throw new IllegalStateException("Geometry file exceeds budget");
        File file = new File(app.getNoBackupFilesDir(), "inspector-geometry-" + nonce + ".json");
        long diskStarted = System.nanoTime(), diskCpuStarted = timing == null ? 0 : Debug.threadCpuTimeNanos();
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); }
        finally {
            if (timing != null) {
                timing.addCpu(timing.geometryDiskCpu, diskCpuStarted);
                timing.geometryDisk.addAndGet(System.nanoTime() - diskStarted);
            }
        }
        StringBuilder hash = new StringBuilder(64);
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) hash.append(String.format("%02x", value & 0xff));
        answer.putLong("geometryBytes", bytes.length);
        answer.putString("geometrySha256", hash.toString());
    }

    static void registerPendingBitmap(HashSet<Bitmap> pending, Bitmap bitmap) {
        synchronized (pending) { pending.add(bitmap); }
    }

    static boolean claimPendingBitmap(HashSet<Bitmap> pending, Bitmap bitmap) {
        // Cancellation and encoder ownership transfer must be atomic. Never recycle
        // a bitmap already claimed by an active native compression call.
        synchronized (pending) { return pending.remove(bitmap); }
    }

    static void recyclePendingBitmaps(HashSet<Bitmap> pending) {
        synchronized (pending) {
            for (Bitmap bitmap : pending) if (!bitmap.isRecycled()) bitmap.recycle();
            pending.clear();
        }
    }

    static boolean isEmptyBitmap(Bitmap bitmap) {
        long pixels = (long) bitmap.getWidth() * bitmap.getHeight();
        if (pixels <= 0 || pixels > 4_000_000) throw new IllegalStateException("Bitmap alpha inspection exceeds pixel budget");
        Bitmap readable = bitmap;
        int[] row = new int[bitmap.getWidth()];
        try {
            if (bitmap.getConfig() == Bitmap.Config.HARDWARE) {
                readable = bitmap.copy(Bitmap.Config.ARGB_8888, false);
                if (readable == null) throw new IllegalStateException("Bitmap alpha inspection has no CPU copy");
            }
            for (int y = 0; y < bitmap.getHeight(); y++) {
                readable.getPixels(row, 0, row.length, 0, y, row.length, 1);
                for (int value : row) if ((value >>> 24) != 0) return false;
            }
        } catch (Throwable unsupported) {
            throw new IllegalStateException("Bitmap alpha inspection failed; empty state is unknown", unsupported);
        } finally {
            if (readable != null && readable != bitmap) readable.recycle();
        }
        return true;
    }

    static VisibleRecord encodeFrame(CapturedFrame frame, String ref, boolean webpLossless,
            AtomicLong encodeMs, CaptureTiming timing, AtomicLong geometryWriteNanos) throws Exception {
        VisibleRecord image = encodeVisibleLayer(frame.bitmap, ref, frame.x, frame.y, webpLossless, encodeMs, timing);
        if (frame.geometry == null && frame.immutableGeometry == null) return image;
        long recordStarted = System.nanoTime();
        long recordCpuStarted = Debug.threadCpuTimeNanos();
        try {
            long jsonStarted = System.nanoTime(), jsonCpuStarted = Debug.threadCpuTimeNanos();
            String record;
            try { record = frame.immutableGeometry == null ? frame.geometry.toString()
                    : frame.immutableGeometry.json(frame.started, frame.ended).toString(); }
            catch (Exception error) {
                if (frame.immutableGeometry != null && frame.immutableGeometry.isDiagnosticOnly()) return image;
                throw error;
            }
            timing.addCpu(timing.geometryJsonCpu, jsonCpuStarted);
            timing.geometryJson.addAndGet(System.nanoTime() - jsonStarted);
            long utf8Started = System.nanoTime(), utf8CpuStarted = Debug.threadCpuTimeNanos();
            int recordBytes = record.getBytes(StandardCharsets.UTF_8).length + 1;
            timing.addCpu(timing.geometryUtf8Cpu, utf8CpuStarted);
            timing.geometryUtf8.addAndGet(System.nanoTime() - utf8Started);
            return new VisibleRecord(image.ref, image.x, image.y, image.image, image.crc, image.webp,
                    record, recordBytes);
        } finally {
            timing.addCpu(timing.geometryWriteCpu, recordCpuStarted);
            geometryWriteNanos.addAndGet(System.nanoTime() - recordStarted);
        }
    }

    static String writePng(Application app, String fileName, Bitmap bitmap, int byteLimit) throws Exception {
        File file = new File(app.getNoBackupFilesDir(), fileName);
        File pending = new File(app.getNoBackupFilesDir(), fileName + ".tmp");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try {
            try (DigestOutputStream stream = new DigestOutputStream(new FileOutputStream(pending), digest)) {
                if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw new IllegalStateException("PNG encode failed");
            }
            if (pending.length() > byteLimit || !pending.renameTo(file)) throw new IllegalStateException("View image could not be published");
        } finally {
            pending.delete();
        }
        StringBuilder sha256 = new StringBuilder(64);
        for (byte value : digest.digest()) sha256.append(String.format("%02x", value & 0xff));
        return sha256.toString();
    }
}

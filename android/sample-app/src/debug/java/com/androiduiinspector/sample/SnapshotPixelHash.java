package com.androiduiinspector.sample;

import android.graphics.Bitmap;
import org.json.JSONObject;
import java.nio.ByteBuffer;
import java.nio.IntBuffer;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicLong;

/** The exact original big-endian ARGB byte stream, with optional bounded scratch arrays. */
final class SnapshotPixelHash {
    private final boolean chunked;
    private final AtomicLong calls = new AtomicLong(), maxScratch = new AtomicLong(), allocatedScratch = new AtomicLong(), nanos = new AtomicLong();

    SnapshotPixelHash(boolean chunked) { this.chunked = chunked; }

    byte[] digest(Bitmap bitmap) throws Exception {
        long started = System.nanoTime();
        int width = bitmap.getWidth(), height = bitmap.getHeight();
        if (width > 16384) throw new IllegalStateException("Hash width exceeds scratch budget");
        int rows = chunked ? Math.min(height, Math.max(1, 16384 / width)) : height;
        int[] pixels = new int[width * rows];
        ByteBuffer bytes = ByteBuffer.allocate(pixels.length * 4);
        IntBuffer integers = bytes.asIntBuffer();
        long scratch = (long) pixels.length * 8;
        calls.incrementAndGet(); allocatedScratch.addAndGet(scratch);
        maxScratch.accumulateAndGet(scratch, Math::max);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try {
            for (int y = 0; y < height; y += rows) {
                int countRows = Math.min(rows, height - y), count = width * countRows;
                bitmap.getPixels(pixels, 0, width, 0, y, width, countRows);
                integers.clear(); integers.put(pixels, 0, count);
                digest.update(bytes.array(), 0, count * 4);
            }
            return digest.digest();
        } finally { nanos.addAndGet(System.nanoTime() - started); }
    }

    JSONObject report() throws Exception {
        return new JSONObject().put("chunked", chunked).put("calls", calls.get()).put("maxScratchBytes", maxScratch.get())
                .put("allocatedScratchBytes", allocatedScratch.get()).put("hashMs", nanos.get() / 1_000_000.0);
    }

    static void selfTest() throws Exception {
        for (int[] size : new int[][]{{1, 1}, {137, 251}, {313, 123}}) {
            Bitmap bitmap = Bitmap.createBitmap(size[0], size[1], Bitmap.Config.ARGB_8888);
            try {
                int[] pixels = new int[size[0] * size[1]];
                for (int i = 0; i < pixels.length; i++) pixels[i] = i * 1103515245 + 12345;
                bitmap.setPixels(pixels, 0, size[0], 0, 0, size[0], size[1]);
                byte[] original = new SnapshotPixelHash(false).digest(bitmap);
                if (!Arrays.equals(original, new SnapshotPixelHash(true).digest(bitmap)))
                    throw new IllegalStateException("Chunked ARGB hash self-test differs");
                bitmap.setPixel(size[0] - 1, size[1] - 1, bitmap.getPixel(size[0] - 1, size[1] - 1) == -1 ? 0xff000000 : -1);
                if (Arrays.equals(original, new SnapshotPixelHash(true).digest(bitmap)))
                    throw new IllegalStateException("Chunked hash missed changed final pixel");
            } finally { bitmap.recycle(); }
        }
    }
}

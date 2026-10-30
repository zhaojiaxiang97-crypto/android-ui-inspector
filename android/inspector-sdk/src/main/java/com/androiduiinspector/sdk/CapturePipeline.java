package com.androiduiinspector.sdk;

import android.graphics.Bitmap;
import java.io.File;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import static com.androiduiinspector.sdk.CaptureOutput.*;

/** Two encoders, one ordered writer. Only detached bitmap/geometry work enters here. */
final class CapturePipeline implements AutoCloseable {
    static final int MAX_PIPELINE_DEPTH = 4;
    private final ExecutorService encoders;
    private final LayerFile output;
    private final GeometryRecords geometry;
    private final ArrayDeque<Future<VisibleRecord>> inFlight = new ArrayDeque<>();
    private final HashSet<Bitmap> pendingBitmaps = new HashSet<>();
    private boolean closed;
    private int count;

    CapturePipeline(File file, File pending, String nonce, GeometryRecords geometry) throws Exception {
        this(file, pending, nonce, geometry, Executors.newFixedThreadPool(2, runnable -> {
            Thread thread = new Thread(runnable, "inspector-encode");
            thread.setDaemon(true);
            return thread;
        }));
    }

    // Package-private executor seam for deterministic queue/ownership probes.
    CapturePipeline(File file, File pending, String nonce, GeometryRecords geometry, ExecutorService encoders) throws Exception {
        this.encoders = encoders;
        this.geometry = geometry;
        try { output = new LayerFile(file, pending, nonce); }
        catch (Throwable error) { encoders.shutdownNow(); throw error; }
    }

    /** Takes ownership even if backpressure or submission fails. The encoder recycles after claim. */
    void submit(Bitmap bitmap, Callable<VisibleRecord> encode) throws Exception {
        synchronized (pendingBitmaps) {
            if (closed) {
                bitmap.recycle();
                throw new IllegalStateException("Capture pipeline is closed");
            }
            pendingBitmaps.add(bitmap);
        }
        boolean handedOff = false;
        try {
            while (inFlight.size() >= MAX_PIPELINE_DEPTH) writeFirst();
            inFlight.addLast(encoders.submit(() -> {
                if (!claimPendingBitmap(pendingBitmaps, bitmap))
                    throw new IllegalStateException("Capture cancelled before encoding");
                return encode.call();
            }));
            handedOff = true;
        } finally {
            if (!handedOff && claimPendingBitmap(pendingBitmaps, bitmap)) bitmap.recycle();
        }
    }

    private void writeFirst() throws Exception {
        count += output.write(inFlight.removeFirst(), geometry);
    }

    void finish() throws Exception {
        while (!inFlight.isEmpty()) writeFirst();
        output.finish();
    }

    void publish(String failureMessage) { output.publish(failureMessage); }
    int count() { return count; }
    long bytes() { return output.bytes(); }
    String sha256() { return output.sha256(); }

    @Override public void close() {
        synchronized (pendingBitmaps) {
            if (closed) return;
            closed = true;
        }
        // Cancel queued futures too: shutdownNow alone leaves their get() unresolved.
        try {
            for (Runnable queued : encoders.shutdownNow()) if (queued instanceof Future<?>) ((Future<?>) queued).cancel(false);
        } finally {
            try { recyclePendingBitmaps(pendingBitmaps); }
            finally { output.close(); }
        }
    }
}

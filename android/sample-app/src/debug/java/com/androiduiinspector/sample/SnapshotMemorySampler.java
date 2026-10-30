package com.androiduiinspector.sample;

import android.os.Debug;
import org.json.JSONObject;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Process-wide sampled memory, not an exact instantaneous or bitmap-only peak. */
final class SnapshotMemorySampler implements AutoCloseable {
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private long generation, baselinePssKb, peakPssKb, peakNativeBytes, peakJavaBytes, samples;

    SnapshotMemorySampler() { worker.scheduleWithFixedDelay(this::sample, 250, 250, TimeUnit.MILLISECONDS); }

    void begin() {
        synchronized (this) { generation++; baselinePssKb = peakPssKb = peakNativeBytes = peakJavaBytes = samples = 0; }
        sample();
    }

    private void sample() {
        long capturedGeneration;
        synchronized (this) { capturedGeneration = generation; }
        long pss = Debug.getPss(), nativeBytes = Debug.getNativeHeapAllocatedSize();
        Runtime runtime = Runtime.getRuntime();
        long javaBytes = runtime.totalMemory() - runtime.freeMemory();
        synchronized (this) {
            if (generation != capturedGeneration) return;
            if (samples++ == 0) baselinePssKb = pss;
            peakPssKb = Math.max(peakPssKb, pss);
            peakNativeBytes = Math.max(peakNativeBytes, nativeBytes);
            peakJavaBytes = Math.max(peakJavaBytes, javaBytes);
        }
    }

    synchronized JSONObject report() throws Exception {
        return new JSONObject().put("intervalMs", 250).put("samples", samples).put("baselinePssKb", baselinePssKb)
                .put("peakPssKb", peakPssKb).put("peakNativeBytes", peakNativeBytes).put("peakJavaBytes", peakJavaBytes);
    }

    @Override public void close() throws Exception {
        worker.shutdown();
        if (!worker.awaitTermination(3, TimeUnit.SECONDS)) throw new IllegalStateException("Memory sampler did not stop");
    }
}

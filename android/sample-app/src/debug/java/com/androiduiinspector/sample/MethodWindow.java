package com.androiduiinspector.sample;

import android.os.Debug;
import android.os.Process;
import org.json.JSONObject;
import java.io.File;

/** A soft one-second sample window, checked between existing bounded UI tasks. */
final class MethodWindow implements AutoCloseable {
    private final File file;
    private boolean active;
    private long began, sampledNanos, startNanos, stopNanos;

    MethodWindow(File directory, int round) { file = new File(directory, "methods-" + round + ".trace"); }
    void start() {
        long started = System.nanoTime();
        Debug.startMethodTracingSampling(file.getAbsolutePath(), 8 * 1024 * 1024, 2000);
        startNanos = System.nanoTime() - started;
        began = System.nanoTime(); active = true;
    }
    void poll() { if (active && System.nanoTime() - began >= 1_000_000_000L) close(); }
    @Override public void close() {
        if (!active) return;
        active = false;
        sampledNanos = System.nanoTime() - began;
        long started = System.nanoTime();
        Debug.stopMethodTracing();
        stopNanos = System.nanoTime() - started;
    }
    JSONObject report() throws Exception {
        if (active || file.length() == 0 || file.length() > 9 * 1024 * 1024) throw new IllegalStateException("Invalid sample output");
        return new JSONObject().put("file", file.getName()).put("pid", Process.myPid()).put("windowNanos", sampledNanos)
                .put("startNanos", startNanos).put("stopNanos", stopNanos).put("bytes", file.length())
                .put("intervalUs", 2000).put("bufferBytes", 8 * 1024 * 1024).put("softBound", true);
    }
}

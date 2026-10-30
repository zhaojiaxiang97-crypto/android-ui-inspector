package com.androiduiinspector.sample;

import com.androiduiinspector.sdk.DebugCaptureProbe;

import android.graphics.Bitmap;
import android.os.Debug;
import android.os.SystemClock;
import android.view.View;
import android.widget.TextView;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.concurrent.atomic.AtomicLong;

/** Debug experiment only: same SDK frame/geometry, different draw for exactly 64 fixed targets. */
final class HardwarePipelineCapture {
    final ReusableHardwareCapture renderer = new ReusableHardwareCapture();
    private final HashMap<String, AtomicLong> counters = new HashMap<>();
    long closeNanos;

    HardwarePipelineCapture(DebugCaptureProbe.Timing timing) throws Exception {
        for (String key : new String[]{"context", "contextCpu", "draw", "drawCpu", "verify", "verifyCpu"}) {
            counters.put(key, timing.counter(key));
        }
    }

    DebugCaptureProbe.Frame capture(View view, View root, boolean qualified) throws Exception {
        if (!qualified || !SnapshotPhaseProbe.eligible(view) || view.getClass() != TextView.class || view.getWidth() != 42 || view.getHeight() != 42
                || !view.isAttachedToWindow() || view.getRootView() != root || !view.isShown())
            throw new IllegalStateException("Fixed hardware pipeline target changed");
        long phase = System.nanoTime(), cpu = Debug.threadCpuTimeNanos();
        int[] before = new int[2]; view.getLocationOnScreen(before);
        IdentityHashMap<View, String> ids = new IdentityHashMap<>(16);
        DebugCaptureProbe.Geometry geometry = DebugCaptureProbe.readGeometry(view, root, ids);
        record("context", phase, cpu);
        long started = SystemClock.uptimeMillis();
        phase = System.nanoTime(); cpu = Debug.threadCpuTimeNanos();
        Bitmap bitmap;
        try { bitmap = renderer.capture(view); }
        finally { record("draw", phase, cpu); } // Includes initialization and explicit CPU copy.
        boolean accepted = false;
        phase = System.nanoTime(); cpu = Debug.threadCpuTimeNanos();
        try {
            int[] after = new int[2]; view.getLocationOnScreen(after);
            if (!view.isAttachedToWindow() || view.getRootView() != root || !view.isShown()
                    || view.getWidth() != 42 || view.getHeight() != 42 || bitmap.getWidth() != 42 || bitmap.getHeight() != 42
                    || before[0] != after[0] || before[1] != after[1] || !geometry.matches(view, root, ids))
                throw new IllegalStateException("Hardware pipeline geometry changed");
            DebugCaptureProbe.Frame result = DebugCaptureProbe.frame(bitmap, before[0], before[1], geometry, started, SystemClock.uptimeMillis());
            accepted = true;
            return result;
        } finally { record("verify", phase, cpu); if (!accepted) bitmap.recycle(); }
    }

    private void record(String key, long wall, long cpu) {
        counters.get(key).addAndGet(System.nanoTime() - wall);
        counters.get(key + "Cpu").addAndGet(Math.max(0, Debug.threadCpuTimeNanos() - cpu));
    }

    void close() throws Exception {
        if (renderer.closed) return;
        long started = System.nanoTime();
        // Normal UI post queues cleanup behind any abandoned active capture; never close from the worker.
        UiTaskBatch.capture(1, offset -> { renderer.close(); return Boolean.TRUE; }, item -> {},
                new java.util.concurrent.atomic.AtomicBoolean());
        closeNanos += System.nanoTime() - started;
    }
}

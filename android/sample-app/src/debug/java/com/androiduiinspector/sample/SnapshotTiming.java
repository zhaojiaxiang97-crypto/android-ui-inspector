package com.androiduiinspector.sample;

import org.json.JSONObject;

/** Bounded sample-only timing: one maximum, no per-image event log. */
final class SnapshotTiming {
    private long total, maximum, tail;
    private int calls, width, height, layers;
    private String ref;

    synchronized void record(long start, long end, long tailStarted, String ref, int width, int height, int layers) {
        long elapsed = Math.max(0, end - start);
        total += elapsed; calls++;
        if (tailStarted > 0) tail += Math.max(0, end - Math.max(start, tailStarted));
        if (this.ref == null || elapsed > maximum) {
            maximum = elapsed; this.ref = ref;
            this.width = width; this.height = height; this.layers = layers;
        }
    }

    synchronized JSONObject report() throws Exception {
        return new JSONObject().put("calls", calls).put("totalMs", total / 1_000_000.0)
                .put("maxMs", maximum / 1_000_000.0).put("tailMs", tail / 1_000_000.0)
                .put("slowest", ref == null ? JSONObject.NULL : new JSONObject().put("ref", ref)
                        .put("width", width).put("height", height).put("layers", layers));
    }

    static void selfTest() throws Exception {
        SnapshotTiming timing = new SnapshotTiming();
        timing.record(10, 30, 20, "first", 2, 3, 1); // Crosses the tail boundary.
        timing.record(40, 50, 20, "second", 3, 4, 2);
        timing.record(10, 15, 20, "before", 1, 1, 1); // Already complete before the boundary.
        JSONObject result = timing.report();
        if (result.getInt("calls") != 3 || timing.total != 35 || timing.maximum != 20 || timing.tail != 20
                || !result.getJSONObject("slowest").getString("ref").equals("first"))
            throw new IllegalStateException("Timing boundary self-test failed");
        SnapshotTiming empty = new SnapshotTiming();
        if (!empty.report().isNull("slowest")) throw new IllegalStateException("Empty timing self-test failed");
    }
}

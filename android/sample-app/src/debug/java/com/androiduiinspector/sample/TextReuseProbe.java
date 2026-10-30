package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Bitmap;
import android.view.View;
import android.widget.FrameLayout;
import com.androiduiinspector.sdk.IsolatedCapture;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/** Fixed Debug comparison; reuse is never enabled in production by this experiment. */
final class TextReuseProbe {
    static void run(Activity activity, FrameLayout page, String token) {
        JSONObject report = new JSONObject(); JSONArray rows = new JSONArray();
        File directory = new File(activity.getFilesDir(), "isolation-probe");
        ReusableHardwareCapture renderer = new ReusableHardwareCapture();
        Bitmap[] own = new Bitmap[2], reused = new Bitmap[2];
        SnapshotPixelHash hash = new SnapshotPixelHash(true); byte[][] initial = new byte[2][];
        View[] targets = new View[2];
        boolean reuseFirst = activity.getIntent().getBooleanExtra("leafReuseFirst", false);
        try {
            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("No output directory");
            report.put("probeToken", token); report.put("cases", rows);
            report.put("captureOrder", reuseFirst ? "B-A-A-B-B-A" : "A-B-B-A-A-B");
            for (int index = 0; index < 2; index++) {
                final int i = index;
                UiTaskBatch.capture(1, offset -> {
                    if (!page.isHardwareAccelerated() || page.getChildCount() != 2)
                        throw new IllegalStateException("Hardware fixture changed");
                    View target = page.getChildAt(i); targets[i] = target;
                    JSONObject row = new JSONObject().put("case", i == 0 ? "normal-text" : "software-layer-text")
                            .put("width", target.getWidth()).put("height", target.getHeight()).put("layerType", target.getLayerType());
                    rows.put(row); JSONArray ownTimes = new JSONArray(), reuseTimes = new JSONArray();
                    row.put("ownNanos", ownTimes).put("reuseNanos", reuseTimes);
                    // Counterbalanced order: no warm-up or discarded first result. Includes readback.
                    for (int step = 0; step < 6; step++) {
                        boolean original = (step == 0 || step == 3 || step == 4) != reuseFirst;
                        long start = System.nanoTime();
                        Bitmap bitmap = original ? IsolatedCapture.own(target) : renderer.capture(target);
                        (original ? ownTimes : reuseTimes).put(System.nanoTime() - start);
                        try {
                            Bitmap[] kept = original ? own : reused;
                            if (kept[i] == null) { kept[i] = bitmap; bitmap = null; }
                            else if (mismatch(kept[i], bitmap) != 0) throw new IllegalStateException("Repeated text pixels changed");
                        } finally { if (bitmap != null) bitmap.recycle(); }
                    }
                    initial[i] = hash.digest(reused[i]);
                    row.put("reuseVsOwn", mismatch(reused[i], own[i]));
                    return Boolean.TRUE;
                }, item -> {}, new AtomicBoolean());
                save(directory, i + "-own", own[i]); save(directory, i + "-reuse", reused[i]);
            }
            // Keep both returned bitmaps across captures of a different View and renderer destruction.
            close(renderer);
            report.put("rendererClosed", renderer.closed && !renderer.active && renderer.acquiredImages == 0);
            report.put("creations", renderer.creations); report.put("captures", renderer.captures);
            for (int i = 0; i < 2; i++) if (!Arrays.equals(initial[i], hash.digest(reused[i])))
                throw new IllegalStateException("Returned bitmap aliases renderer storage");
            report.put("detachedPixelsVerified", true);
            if (rows.getJSONObject(0).getInt("reuseVsOwn") != 0 || rows.getJSONObject(1).getInt("reuseVsOwn") != 0)
                throw new IllegalStateException("Reuse text differs from production own");
            // Existing fault fixture runs after measurements; does not prewarm their renderer.
            report.put("safety", HardwareReuseSafety.verify(targets[0], page, hash, hash.digest(own[0])));
            report.put("completed", true);
        } catch (Throwable error) {
            try { report.put("completed", false); report.put("error", error.toString()); } catch (Exception ignored) {}
        } finally {
            try { close(renderer); report.put("rendererClosed", renderer.closed && !renderer.active && renderer.acquiredImages == 0); }
            catch (Exception error) { try { report.put("completed", false); report.put("cleanupError", error.toString()); } catch (Exception ignored) {} }
            for (Bitmap bitmap : own) if (bitmap != null) bitmap.recycle();
            for (Bitmap bitmap : reused) if (bitmap != null) bitmap.recycle();
        }
        try (FileOutputStream stream = new FileOutputStream(new File(directory, "text-reuse.json"))) {
            stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) { android.util.Log.e("TextReuseProbe", "Report failed", error); }
    }
    private static void close(ReusableHardwareCapture renderer) throws Exception {
        UiTaskBatch.capture(1, offset -> { renderer.close(); return Boolean.TRUE; }, item -> {}, new AtomicBoolean());
    }
    private static int mismatch(Bitmap a, Bitmap b) {
        if (a.getWidth() != b.getWidth() || a.getHeight() != b.getHeight()) throw new IllegalStateException("Size mismatch");
        int count = a.getWidth() * a.getHeight(); int[] left = new int[count], right = new int[count];
        a.getPixels(left, 0, a.getWidth(), 0, 0, a.getWidth(), a.getHeight());
        b.getPixels(right, 0, b.getWidth(), 0, 0, b.getWidth(), b.getHeight());
        int different = 0; for (int i = 0; i < count; i++) if (left[i] != right[i]) different++; return different;
    }
    private static void save(File directory, String name, Bitmap bitmap) throws Exception {
        try (FileOutputStream stream = new FileOutputStream(new File(directory, "text-reuse-" + name + ".png"))) {
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw new IllegalStateException("PNG encoding failed");
        }
    }
}

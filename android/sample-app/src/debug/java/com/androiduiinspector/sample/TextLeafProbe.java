package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.View;
import android.widget.FrameLayout;
import com.androiduiinspector.sdk.IsolatedCapture;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.lsposed.hiddenapibypass.HiddenApiBypass;

/** Debug-only, bounded own-leaf isolation/cost check; no provider or business requests. */
final class TextLeafProbe {
    static void run(Activity activity, FrameLayout page, String token) {
        JSONObject report = new JSONObject(); File directory = new File(activity.getFilesDir(), "isolation-probe");
        try {
            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Output unavailable");
            report.put("probeToken", token); report.put("hardwareAccelerated", page.isHardwareAccelerated());
            JSONArray rows = new JSONArray(); report.put("cases", rows);
            for (int index = 0; index < page.getChildCount(); index++) {
                View target = page.getChildAt(index);
                Bitmap baseline = null, directBaseline = null, reference = null;
                try {
                    JSONObject row = new JSONObject(); rows.put(row);
                    row.put("case", index == 0 ? "normal-text" : "software-layer-text");
                    row.put("width", target.getWidth()); row.put("height", target.getHeight());
                    row.put("hardwareAccelerated", target.isHardwareAccelerated()); row.put("layerType", target.getLayerType());
                    JSONArray ownTimes = new JSONArray(), directTimes = new JSONArray();
                    row.put("ownNanos", ownTimes); row.put("directNanos", directTimes);
                    for (int round = 0; round < 3; round++) {
                        // Alternate order. Retain first result as the cold sample, not a discarded warm-up.
                        for (int step = 0; step < 2; step++) {
                            boolean own = (round + step) % 2 == 0;
                            long start = System.nanoTime();
                            Bitmap bitmap = own ? IsolatedCapture.own(target) : direct(target);
                            (own ? ownTimes : directTimes).put(System.nanoTime() - start);
                            try {
                                if (own) {
                                    if (baseline == null) { baseline = bitmap; bitmap = null; }
                                    else requireEqual(baseline, bitmap, "Repeated own text changed");
                                } else {
                                    if (directBaseline == null) { directBaseline = bitmap; bitmap = null; }
                                    else requireEqual(directBaseline, bitmap, "Repeated software text changed");
                                }
                            } finally { if (bitmap != null) bitmap.recycle(); }
                        }
                    }
                    reference = matched(target);
                    row.put("ownVsMatched", mismatch(baseline, reference));
                    row.put("ownVsOldDirect", mismatch(baseline, directBaseline));
                    int[] pixels = pixels(baseline); int visible = 0, background = 0;
                    for (int pixel : pixels) if ((pixel >>> 24) != 0) {
                        visible++;
                        // Compare premultiplied channels. Very low-alpha glyph edges cannot
                        // preserve #222222 exactly after unpremultiplication of 8-bit storage.
                        int alpha = pixel >>> 24;
                        int expected = Math.round(34 * alpha / 255f);
                        if (Math.abs(Math.round((pixel >>> 16 & 255) * alpha / 255f) - expected) > 1
                                || Math.abs(Math.round((pixel >>> 8 & 255) * alpha / 255f) - expected) > 1
                                || Math.abs(Math.round((pixel & 255) * alpha / 255f) - expected) > 1) background++;
                    }
                    row.put("visiblePixels", visible); row.put("foreignColorPixels", background);
                    row.put("cornerAlpha", pixels[0] >>> 24);
                    save(directory, index + "-own", baseline); save(directory, index + "-matched", reference);
                    save(directory, index + "-direct", directBaseline);
                    if (visible == 0 || background != 0 || (pixels[0] >>> 24) != 0)
                        throw new IllegalStateException("Text missing or includes parent background");
                    requireEqual(baseline, reference, "Own differs from matched text snapshot");
                } finally {
                    for (Bitmap bitmap : new Bitmap[]{baseline, directBaseline, reference}) if (bitmap != null) bitmap.recycle();
                }
            }
            Bitmap parent = IsolatedCapture.own(page);
            try {
                for (int pixel : pixels(parent)) if (pixel != 0xffffffff) throw new IllegalStateException("Parent own contains child text");
                report.put("parentOwnIsolated", true);
            } finally { parent.recycle(); }
            report.put("completed", true);
        } catch (Throwable error) {
            try { report.put("completed", false); report.put("error", error.toString()); } catch (Exception ignored) {}
        }
        try (FileOutputStream stream = new FileOutputStream(new File(directory, "text-leaf.json"))) {
            stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) { android.util.Log.e("TextLeafProbe", "Report failed", error); }
    }
    private static Bitmap direct(View target) {
        Bitmap bitmap = Bitmap.createBitmap(target.getWidth(), target.getHeight(), Bitmap.Config.ARGB_8888);
        try { target.draw(new Canvas(bitmap)); return bitmap; }
        catch (Throwable error) { bitmap.recycle(); throw error; }
    }
    private static Bitmap matched(View target) throws Exception {
        Object provider = HiddenApiBypass.newInstance(Class.forName("android.view.ViewDebug$"
                + (target.isHardwareAccelerated() ? "HardwareCanvasProvider" : "SoftwareCanvasProvider")));
        Bitmap raw = (Bitmap) HiddenApiBypass.invoke(View.class, target, "createSnapshot", provider, true);
        if (raw == null) throw new IllegalStateException("No reference snapshot");
        try { Bitmap copy = raw.copy(Bitmap.Config.ARGB_8888, false);
            if (copy == null) throw new IllegalStateException("No reference pixels"); return copy;
        } finally { raw.recycle(); }
    }
    private static int[] pixels(Bitmap bitmap) {
        int[] pixels = new int[bitmap.getWidth() * bitmap.getHeight()];
        bitmap.getPixels(pixels, 0, bitmap.getWidth(), 0, 0, bitmap.getWidth(), bitmap.getHeight()); return pixels;
    }
    private static int mismatch(Bitmap a, Bitmap b) {
        if (a.getWidth() != b.getWidth() || a.getHeight() != b.getHeight()) throw new IllegalStateException("Size mismatch");
        int[] left = pixels(a), right = pixels(b); int count = 0;
        for (int i = 0; i < left.length; i++) if (left[i] != right[i]) count++; return count;
    }
    private static void requireEqual(Bitmap a, Bitmap b, String error) { if (mismatch(a, b) != 0) throw new IllegalStateException(error); }
    private static void save(File directory, String name, Bitmap bitmap) throws Exception {
        try (FileOutputStream stream = new FileOutputStream(new File(directory, "text-leaf-" + name + ".png"))) {
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw new IllegalStateException("PNG encode failed");
        }
    }
}

package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Bitmap;
import android.os.Build;
import android.view.View;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

/** Debug only: encode the same immutable CPU bitmap, never recapture between formats. */
final class SnapshotEncodingProbe {
    static void start(Activity activity, TextView text) {
        JSONObject report = new JSONObject();
        Bitmap snapshot = null;
        Bitmap cpu = null;
        Bitmap software = null;
        try {
            report.put("probeToken", activity.getIntent().getStringExtra("probeToken"));
            if (Build.VERSION.SDK_INT < 30) throw new IllegalStateException("WEBP_LOSSLESS needs API 30");
            text.setTextColor(0xff222222);
            text.setText("设置 Encoding 透明边缘");
            Method capture = Class.forName("com.androiduiinspector.sdk.IsolatedCapture").getDeclaredMethod("debugSnapshot", View.class);
            capture.setAccessible(true);
            snapshot = (Bitmap) capture.invoke(null, text);
            if (snapshot == null) throw new IllegalStateException("No snapshot");
            report.put("hardware", snapshot.getConfig() == Bitmap.Config.HARDWARE);
            cpu = snapshot.copy(Bitmap.Config.ARGB_8888, false);
            if (cpu == null) throw new IllegalStateException("No CPU copy");
            Method own = Class.forName("com.androiduiinspector.sdk.IsolatedCapture").getMethod("own", View.class);
            Bitmap mutableSoftware = (Bitmap) own.invoke(null, text);
            try { software = mutableSoftware.copy(Bitmap.Config.ARGB_8888, false); }
            finally { mutableSoftware.recycle(); }
            if (software == null) throw new IllegalStateException("No software copy");
            Bitmap owned = cpu; cpu = null;
            Bitmap ownedSoftware = software; software = null;
            new Thread(() -> run(activity, owned, ownedSoftware, report), "sample-encoding").start();
        } catch (Throwable error) {
            if (cpu != null) cpu.recycle();
            if (software != null) software.recycle();
            try { report.put("passed", false).put("error", error.toString()); writeReport(activity, report); }
            catch (Exception ignored) { }
        } finally { if (snapshot != null) snapshot.recycle(); }
    }

    private static void run(Activity activity, Bitmap text, Bitmap software, JSONObject report) {
        Bitmap palette = null;
        try {
            File dir = new File(activity.getFilesDir(), "snapshot-encoding");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("Cannot create output");
            palette = Bitmap.createBitmap(256, 8, Bitmap.Config.ARGB_8888);
            int[] colors = {0x222222, 0x123456, 0xabcdef, 0xff0000, 0x00ff00, 0x0000ff, 0xffffff, 0x000000};
            int[] pixels = new int[256 * colors.length];
            for (int y = 0; y < colors.length; y++) for (int a = 0; a < 256; a++) pixels[y * 256 + a] = (a << 24) | colors[y];
            palette.setPixels(pixels, 0, 256, 0, 0, 256, colors.length);
            JSONArray cases = new JSONArray();
            for (int round = 0; round < 3; round++) {
                cases.put(encode(dir, "text-" + round, text));
                cases.put(encode(dir, "software-" + round, software));
                cases.put(encode(dir, "palette-" + round, palette));
            }
            report.put("cases", cases).put("passed", true);
            report.put("alphaInspection", checkAlphaInspection());
        } catch (Throwable error) {
            try { report.put("passed", false).put("error", error.toString()); } catch (Exception ignored) { }
        } finally {
            text.recycle(); software.recycle(); if (palette != null) palette.recycle();
            try { writeReport(activity, report); } catch (Exception ignored) { }
        }
    }

    private static JSONObject checkAlphaInspection() throws Exception {
        Method inspect = Class.forName("com.androiduiinspector.sdk.CaptureOutput").getDeclaredMethod("isEmptyBitmap", Bitmap.class);
        inspect.setAccessible(true);
        Bitmap large = Bitmap.createBitmap(1080, 2400, Bitmap.Config.ARGB_8888);
        try {
            long started = android.os.SystemClock.uptimeMillis();
            boolean blank = (Boolean) inspect.invoke(null, large);
            long blankMs = android.os.SystemClock.uptimeMillis() - started;
            large.setPixel(1079, 2399, 0x01000000);
            boolean faintLastPixel = (Boolean) inspect.invoke(null, large);
            if (!blank || faintLastPixel) throw new IllegalStateException("Large alpha inspection mismatch");
            return new JSONObject().put("width", 1080).put("height", 2400).put("blank", blank)
                    .put("faintLastPixelEmpty", faintLastPixel).put("blankMs", blankMs);
        } finally { large.recycle(); }
    }

    private static JSONObject encode(File dir, String name, Bitmap bitmap) throws Exception {
        byte[] before = rgba(bitmap);
        try (FileOutputStream file = new FileOutputStream(new File(dir, name + ".rgba"))) { file.write(before); }
        for (Bitmap.CompressFormat format : new Bitmap.CompressFormat[]{Bitmap.CompressFormat.PNG, Bitmap.CompressFormat.WEBP_LOSSLESS}) {
            try (FileOutputStream file = new FileOutputStream(new File(dir, name + (format == Bitmap.CompressFormat.PNG ? ".png" : ".webp")))) {
                if (!bitmap.compress(format, format == Bitmap.CompressFormat.PNG ? 100 : 0, file)) throw new IllegalStateException("Encode failed");
            }
            if (!Arrays.equals(before, rgba(bitmap))) throw new IllegalStateException("Encoding changed bitmap");
        }
        StringBuilder sha = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(before)) sha.append(String.format("%02x", b & 255));
        return new JSONObject().put("name", name).put("width", bitmap.getWidth()).put("height", bitmap.getHeight())
                .put("sha256", sha.toString()).put("immutable", !bitmap.isMutable());
    }

    private static byte[] rgba(Bitmap bitmap) {
        int width = bitmap.getWidth(), height = bitmap.getHeight();
        if ((long) width * height > 1_000_000) throw new IllegalStateException("Pixel budget exceeded");
        int[] pixels = new int[width * height];
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
        byte[] bytes = new byte[pixels.length * 4];
        for (int i = 0; i < pixels.length; i++) {
            bytes[i * 4] = (byte) (pixels[i] >>> 16); bytes[i * 4 + 1] = (byte) (pixels[i] >>> 8);
            bytes[i * 4 + 2] = (byte) pixels[i]; bytes[i * 4 + 3] = (byte) (pixels[i] >>> 24);
        }
        return bytes;
    }

    private static void writeReport(Activity activity, JSONObject report) throws Exception {
        try (FileOutputStream file = new FileOutputStream(new File(activity.getFilesDir(), "snapshot-encoding.json"))) {
            file.write(report.toString().getBytes(StandardCharsets.UTF_8));
        }
    }
}

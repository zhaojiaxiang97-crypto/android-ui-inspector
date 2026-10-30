package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.view.View;
import com.androiduiinspector.sdk.IsolatedCapture;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/** Debug diagnostic. Software F16 is a separate control, not a hardware capture replacement. */
public final class AlphaPrecisionActivity extends Activity {
    private static final String[] NAMES = {"gray-origin", "gray-offset", "gray-shifted", "transparent", "white", "black", "constant-alpha", "opaque-gradient"};
    private final FrameLayout[] panels = new FrameLayout[NAMES.length];
    private boolean started;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout page = new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL);
        for (int i = 0; i < panels.length; i++) {
            FrameLayout panel = new FrameLayout(this); panels[i] = panel;
            if (i != 3) panel.setBackgroundColor(i == 4 ? 0xffffffff : i == 5 ? 0xff000000 : 0xffe7e7e7);
            View child = new View(this);
            if (i == 6) child.setBackgroundColor(0x801375a1);
            else child.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                    i == 7 ? new int[]{0xff1375a1, 0xfff2ac31} : new int[]{0x801375a1, 0x80f2ac31}));
            FrameLayout.LayoutParams box = new FrameLayout.LayoutParams(61, 39);
            box.leftMargin = i == 0 ? 0 : i == 2 ? 32 : 31;
            box.topMargin = i == 0 ? 0 : i == 2 ? 44 : 43;
            panel.addView(child, box); page.addView(panel, new LinearLayout.LayoutParams(240, 160));
        }
        setContentView(page);
    }

    @Override public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus && !started) { started = true; panels[0].post(this::run); }
    }

    private void run() {
        File output = new File(getFilesDir(), "isolation-probe");
        JSONObject report = new JSONObject();
        try {
            if (!output.exists() && !output.mkdirs()) throw new IllegalStateException("No output directory");
            report.put("probeToken", getIntent().getStringExtra("probeToken"));
            report.put("sdkInt", android.os.Build.VERSION.SDK_INT);
            report.put("precisionBackend", "software-Canvas-RGBA_F16");
            JSONArray rows = new JSONArray(); report.put("cases", rows);
            for (int i = 0; i < panels.length; i++) {
                FrameLayout panel = panels[i]; View child = panel.getChildAt(0);
                if (!panel.isHardwareAccelerated() || panel.getWidth() != 240 || panel.getHeight() != 160
                        || child.getWidth() != 61 || child.getHeight() != 39) throw new IllegalStateException("Fixture geometry/backend changed");
                Bitmap group = null, own = null, sdkLeaf = null, high = null, quantized = null, sdkComposition = null, highComposition = null, quantizedComposition = null, groupAgain = null;
                try {
                    group = IsolatedCapture.group(panel); own = IsolatedCapture.own(panel);
                    sdkLeaf = IsolatedCapture.own(child);
                    high = Bitmap.createBitmap(child.getWidth(), child.getHeight(), Bitmap.Config.RGBA_F16);
                    child.draw(new Canvas(high));
                    if (high.getConfig() != Bitmap.Config.RGBA_F16) throw new IllegalStateException("No actual F16 bitmap");
                    quantized = high.copy(Bitmap.Config.ARGB_8888, false);
                    if (quantized == null) throw new IllegalStateException("No quantized control");
                    sdkComposition = compose(own, sdkLeaf, child); highComposition = compose(own, high, child);
                    quantizedComposition = compose(own, quantized, child); groupAgain = IsolatedCapture.group(panel);
                    JSONObject row = new JSONObject(); row.put("case", NAMES[i]); row.put("x", child.getLeft()); row.put("y", child.getTop());
                    row.put("groupRepeat", difference(group, groupAgain));
                    row.put("sdkVsGroup", difference(sdkComposition, group)); row.put("f16VsGroup", difference(highComposition, group));
                    row.put("quantizedVsGroup", difference(quantizedComposition, group));
                    row.put("f16VsQuantized", difference(highComposition, quantizedComposition));
                    row.put("quantizedLeafVsSdkLeaf", difference(quantized, sdkLeaf));
                    row.put("f16RowBytes", high.getRowBytes()); row.put("f16Premultiplied", high.isPremultiplied());
                    row.put("f16ByteOrder", ByteOrder.nativeOrder().toString());
                    ByteBuffer bytes = ByteBuffer.allocate(high.getByteCount()); high.copyPixelsToBuffer(bytes);
                    try (FileOutputStream stream = new FileOutputStream(new File(output, "alpha-" + i + ".f16"))) { stream.write(bytes.array()); }
                    for (String name : new String[]{"group", "sdk", "f16", "quantized"}) {
                        Bitmap bitmap = name.equals("group") ? group : name.equals("sdk") ? sdkComposition : name.equals("f16") ? highComposition : quantizedComposition;
                        try (FileOutputStream stream = new FileOutputStream(new File(output, "alpha-" + i + "-" + name + ".png"))) {
                            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw new IllegalStateException("Encode failed");
                        }
                    }
                    rows.put(row);
                } finally {
                    for (Bitmap bitmap : new Bitmap[]{group, own, sdkLeaf, high, quantized, sdkComposition, highComposition, quantizedComposition, groupAgain})
                        if (bitmap != null) bitmap.recycle();
                }
            }
            report.put("completed", true);
        } catch (Throwable error) {
            try { report.put("completed", false); report.put("error", error.toString()); } catch (Exception ignored) {}
        }
        try (FileOutputStream stream = new FileOutputStream(new File(output, "alpha-precision.json"))) {
            stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) { android.util.Log.e("AlphaPrecision", "Report failed", error); }
    }

    private static Bitmap compose(Bitmap own, Bitmap child, View view) {
        Bitmap output = own.copy(Bitmap.Config.ARGB_8888, true);
        if (output == null) throw new IllegalStateException("No composition bitmap");
        new Canvas(output).drawBitmap(child, view.getLeft(), view.getTop(), null); return output;
    }

    private static JSONObject difference(Bitmap a, Bitmap b) throws Exception {
        if (a.getWidth() != b.getWidth() || a.getHeight() != b.getHeight()) throw new IllegalStateException("Size mismatch");
        int count = a.getWidth() * a.getHeight(), changed = 0, maximum = 0, alpha = 0;
        int[] left = new int[count], right = new int[count];
        a.getPixels(left, 0, a.getWidth(), 0, 0, a.getWidth(), a.getHeight()); b.getPixels(right, 0, b.getWidth(), 0, 0, b.getWidth(), b.getHeight());
        for (int i = 0; i < count; i++) {
            if (left[i] != right[i]) changed++;
            if ((left[i] >>> 24) != (right[i] >>> 24)) alpha++;
            for (int shift = 0; shift <= 24; shift += 8) maximum = Math.max(maximum, Math.abs((left[i] >>> shift & 255) - (right[i] >>> shift & 255)));
        }
        return new JSONObject().put("pixels", count).put("mismatchedPixels", changed).put("maxChannelDelta", maximum).put("alphaMismatches", alpha);
    }
}

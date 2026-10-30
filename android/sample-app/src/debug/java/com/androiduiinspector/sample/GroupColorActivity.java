package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Picture;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.View;
import android.view.SurfaceView;
import android.view.TextureView;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.androiduiinspector.sdk.IsolatedCapture;
import org.json.JSONArray;
import org.json.JSONObject;
import org.lsposed.hiddenapibypass.HiddenApiBypass;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;

/** Debug-only, fixed pixels: all captures run in one UI task without changing the View state. */
public class GroupColorActivity extends Activity {
    private FrameLayout[] panels;
    private FrameLayout textPanel;
    private boolean started;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        panels = new FrameLayout[getIntent().getBooleanExtra("extended", false) ? 8 : 4];
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(0xff222222);
        for (int i = 0; i < panels.length; i++) {
            FrameLayout panel = new FrameLayout(this);
            panels[i] = panel;
            if (i == 0 || i >= 4) panel.setBackgroundColor(0xffe7e7e7);
            else panel.setBackground(new GradientDrawable(i == 2
                    ? GradientDrawable.Orientation.LEFT_RIGHT : GradientDrawable.Orientation.TOP_BOTTOM,
                    i == 3 ? new int[]{0xff1375a1, 0xfff2ac31} : new int[]{0xfffafafa, 0xffe5e5e5}));
            // Opaque child control, separate from the parent background and with no rounding/transform.
            View child = new View(this);
            child.setBackgroundColor(0xff31a457);
            if (i == 4 || i == 5) child.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                    i == 4 ? new int[]{0xff1375a1, 0xfff2ac31} : new int[]{0x801375a1, 0x80f2ac31}));
            if (i >= 6) child.setAlpha(0.5f);
            FrameLayout.LayoutParams childBox = new FrameLayout.LayoutParams(61, 39);
            childBox.leftMargin = 31;
            childBox.topMargin = 43;
            panel.addView(child, childBox);
            if (i == 7) {
                View overlay = new View(this); overlay.setBackgroundColor(0xffde3145); overlay.setAlpha(0.5f);
                FrameLayout.LayoutParams overlayBox = new FrameLayout.LayoutParams(61, 39);
                overlayBox.leftMargin = 50; overlayBox.topMargin = 52;
                panel.addView(overlay, overlayBox);
            }
            page.addView(panel, new LinearLayout.LayoutParams(240, 160));
        }
        textPanel = new FrameLayout(this);
        TextView text = new TextView(this);
        text.setText("RED CHILD"); text.setTextColor(0xffff0000); text.setTextSize(20);
        text.setGravity(Gravity.CENTER);
        textPanel.addView(text, new FrameLayout.LayoutParams(240, 160));
        page.addView(textPanel, new LinearLayout.LayoutParams(240, 160));
        setContentView(page);
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused && !started) {
            started = true;
            panels[0].post(this::compare);
        }
    }

    private void compare() {
        JSONObject report = new JSONObject();
        File directory = new File(getFilesDir(), "isolation-probe");
        try {
            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Cannot create output");
            report.put("probeToken", getIntent().getStringExtra("probeToken"));
            report.put("sdkInt", android.os.Build.VERSION.SDK_INT);
            report.put("pid", android.os.Process.myPid());
            report.put("activityIdentity", Integer.toHexString(System.identityHashCode(this)));
            report.put("captureTask", "one-main-thread-task-fixed-views-not-simultaneous");
            report.put("timeBase", "elapsedRealtimeNanos");
            JSONArray cases = new JSONArray();
            for (int index = 0; index < panels.length; index++) {
                FrameLayout panel = panels[index];
                if (!panel.isAttachedToWindow() || panel.getWidth() != 240 || panel.getHeight() != 160)
                    throw new IllegalStateException("Attached fixture geometry required");
                Bitmap own = null, software = null, matched = null, composed = null, ownAgain = null, groupAgain = null, production = null;
                ArrayList<Bitmap> childImages = new ArrayList<>();
                Bitmap gpuComposition = null;
                JSONArray captures = new JSONArray();
                try {
                    long began = android.os.SystemClock.elapsedRealtimeNanos();
                    own = IsolatedCapture.own(panel);
                    captures.put(evidence(panel, own, began, ownBackend(panel), "group-color-" + index + "-parent.png"));
                    software = Bitmap.createBitmap(240, 160, Bitmap.Config.ARGB_8888);
                    panel.draw(new Canvas(software)); // Explicit old-backend control, not production group.
                    began = android.os.SystemClock.elapsedRealtimeNanos();
                    production = IsolatedCapture.group(panel);
                    captures.put(evidence(panel, production, began, snapshotBackend(panel), "group-color-" + index + "-production.png"));
                    began = android.os.SystemClock.elapsedRealtimeNanos();
                    Object provider = HiddenApiBypass.newInstance(Class.forName("android.view.ViewDebug$" +
                            (panel.isHardwareAccelerated() ? "HardwareCanvasProvider" : "SoftwareCanvasProvider")));
                    Bitmap raw = (Bitmap) HiddenApiBypass.invoke(View.class, panel, "createSnapshot", provider, false);
                    if (raw == null) throw new IllegalStateException("No matched group bitmap");
                    try { matched = raw.copy(Bitmap.Config.ARGB_8888, false); } finally { raw.recycle(); }
                    if (matched == null) throw new IllegalStateException("No matched readback");
                    captures.put(evidence(panel, matched, began, snapshotBackend(panel), "group-color-" + index + "-snapshot.png"));
                    composed = own.copy(Bitmap.Config.ARGB_8888, true);
                    Canvas composition = new Canvas(composed);
                    for (int childIndex = 0; childIndex < panel.getChildCount(); childIndex++) {
                        View childView = panel.getChildAt(childIndex);
                        began = android.os.SystemClock.elapsedRealtimeNanos();
                        Bitmap childImage = IsolatedCapture.own(childView);
                        captures.put(evidence(childView, childImage, began, ownBackend(childView),
                                "group-color-" + index + "-child-" + childIndex + ".png"));
                        childImages.add(childImage);
                        // View.draw's bitmap-layer alpha uses integer truncation, not rounding.
                        Paint opacity = new Paint(); opacity.setAlpha((int) (childView.getAlpha() * 255));
                        composition.drawBitmap(childImage, childView.getLeft(), childView.getTop(), opacity);
                    }
                    ownAgain = IsolatedCapture.own(panel);
                    groupAgain = IsolatedCapture.group(panel);
                    JSONObject row = new JSONObject();
                    row.put("case", new String[]{"solid", "gray-vertical", "gray-horizontal", "color-vertical",
                            "leaf-gradient", "leaf-intrinsic-alpha-gradient", "leaf-view-alpha", "overlapping-alpha"}[index]);
                    row.put("hardwareAccelerated", panel.isHardwareAccelerated());
                    row.put("captures", captures);
                    row.put("ownRepeat", difference(own, ownAgain));
                    row.put("productionGroupRepeat", difference(production, groupAgain));
                    row.put("composedVsSoftwareGroup", difference(composed, software));
                    row.put("composedVsMatchedSnapshotGroup", difference(composed, matched));
                    row.put("softwareVsMatchedSnapshotGroup", difference(software, matched));
                    row.put("productionVsMatchedSnapshotGroup", difference(production, matched));
                    row.put("composedVsProductionGroup", difference(composed, production));
                    if (index == 5 && panel.isHardwareAccelerated() && android.os.Build.VERSION.SDK_INT >= 28) {
                        Picture picture = new Picture();
                        Canvas recording = picture.beginRecording(240, 160);
                        recording.drawBitmap(own, 0, 0, null);
                        for (int childIndex = 0; childIndex < childImages.size(); childIndex++) {
                            View childView = panel.getChildAt(childIndex);
                            Paint opacity = new Paint(); opacity.setAlpha((int) (childView.getAlpha() * 255));
                            recording.drawBitmap(childImages.get(childIndex), childView.getLeft(), childView.getTop(), opacity);
                        }
                        picture.endRecording();
                        Bitmap rawComposition = Bitmap.createBitmap(picture, 240, 160, Bitmap.Config.HARDWARE);
                        try { gpuComposition = rawComposition.copy(Bitmap.Config.ARGB_8888, false); } finally { rawComposition.recycle(); }
                        if (gpuComposition == null) throw new IllegalStateException("No diagnostic GPU composition");
                        row.put("gpuBitmapCompositionVsProductionGroup", difference(gpuComposition, production));
                        row.put("cpuVsGpuBitmapComposition", difference(composed, gpuComposition));
                        row.put("leafCenterAlpha", childImages.get(0).getPixel(30, 19) >>> 24);
                        save(gpuComposition, new File(directory, "group-color-5-gpu-composed.png"));
                        save(childImages.get(0), new File(directory, "group-color-5-leaf.png"));
                    }
                    cases.put(row);
                    save(own, new File(directory, "group-color-" + index + "-parent.png"));
                    for (int childIndex = 0; childIndex < childImages.size(); childIndex++)
                        save(childImages.get(childIndex), new File(directory, "group-color-" + index + "-child-" + childIndex + ".png"));
                    save(composed, new File(directory, "group-color-" + index + "-composed.png"));
                    save(software, new File(directory, "group-color-" + index + "-software.png"));
                    save(matched, new File(directory, "group-color-" + index + "-snapshot.png"));
                    save(production, new File(directory, "group-color-" + index + "-production.png"));
                } finally {
                    for (Bitmap childImage : childImages) childImage.recycle();
                    if (gpuComposition != null) gpuComposition.recycle();
                    for (Bitmap bitmap : new Bitmap[]{own, software, matched, composed, ownAgain, groupAgain, production})
                        if (bitmap != null) bitmap.recycle();
                }
            }
            report.put("cases", cases);
            Bitmap parent = null, child = null, group = null;
            try {
                parent = IsolatedCapture.own(textPanel);
                child = IsolatedCapture.own(textPanel.getChildAt(0));
                group = IsolatedCapture.group(textPanel);
                boolean isolated = visiblePixels(parent) == 0 && visiblePixels(child) > 0
                        && visiblePixels(group) > 0 && (child.getPixel(0, 0) >>> 24) == 0
                        && (group.getPixel(0, 0) >>> 24) == 0;
                report.put("transparentTextIsolated", isolated);
                if (!isolated) throw new IllegalStateException("Text leaked into parent or acquired a background");
                save(parent, new File(directory, "group-text-parent.png"));
                save(child, new File(directory, "group-text-child.png"));
                save(group, new File(directory, "group-text-group.png"));
            } finally { for (Bitmap bitmap : new Bitmap[]{parent, child, group}) if (bitmap != null) bitmap.recycle(); }
            for (View special : new View[]{new SurfaceView(this), new TextureView(this)}) {
                FrameLayout holder = new FrameLayout(this);
                holder.addView(special); holder.layout(0, 0, 20, 20);
                expectGroupRejection(holder);
            }
            FrameLayout rounded = new FrameLayout(this);
            GradientDrawable background = new GradientDrawable(); background.setColor(0xff123456); background.setCornerRadius(6);
            rounded.setBackground(background); rounded.setClipToOutline(true); rounded.layout(0, 0, 20, 20);
            expectGroupRejection(rounded);
            report.put("specialAndOutlineRejected", true);
            report.put("completed", true); // Completion is not an assertion that the backends match.
        } catch (Throwable error) {
            try { report.put("completed", false); report.put("error", error.toString()); } catch (Exception ignored) {}
        }
        try (FileOutputStream stream = new FileOutputStream(new File(directory, "group-color.json"))) {
            stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) { android.util.Log.e("GroupColor", "Cannot save report", error); }
    }

    private static int visiblePixels(Bitmap bitmap) {
        int visible = 0;
        for (int y = 0; y < bitmap.getHeight(); y++) for (int x = 0; x < bitmap.getWidth(); x++)
            if ((bitmap.getPixel(x, y) >>> 24) != 0) visible++;
        return visible;
    }

    private static String snapshotBackend(View view) {
        return view.isHardwareAccelerated() ? "HardwareCanvasProvider/createSnapshot" : "SoftwareCanvasProvider/createSnapshot";
    }

    private static String ownBackend(View view) {
        return !view.isHardwareAccelerated() && !(view instanceof android.view.ViewGroup) && !view.getClipToOutline()
                ? "software-View.draw" : snapshotBackend(view);
    }

    private static JSONObject evidence(View view, Bitmap image, long began, String backend, String file) throws Exception {
        long ended = android.os.SystemClock.elapsedRealtimeNanos();
        JSONObject result = new JSONObject();
        result.put("file", file); result.put("backend", backend);
        result.put("beganNs", began); result.put("endedNs", ended);
        result.put("viewIdentity", Integer.toHexString(System.identityHashCode(view)));
        result.put("left", view.getLeft()); result.put("top", view.getTop());
        result.put("width", view.getWidth()); result.put("height", view.getHeight());
        result.put("viewAlpha", view.getAlpha()); result.put("attached", view.isAttachedToWindow());
        result.put("bitmapWidth", image.getWidth()); result.put("bitmapHeight", image.getHeight());
        result.put("bitmapConfig", String.valueOf(image.getConfig()));
        result.put("premultiplied", image.isPremultiplied()); result.put("hasAlpha", image.hasAlpha());
        result.put("density", image.getDensity());
        result.put("colorSpace", String.valueOf(image.getColorSpace()));
        return result;
    }

    private static void expectGroupRejection(View view) throws Exception {
        try {
            Bitmap image = IsolatedCapture.group(view); image.recycle();
        } catch (UnsupportedOperationException expected) { return; }
        throw new IllegalStateException("Unsupported group was admitted");
    }

    private static JSONObject difference(Bitmap a, Bitmap b) throws Exception {
        if (a.getWidth() != b.getWidth() || a.getHeight() != b.getHeight()) throw new IllegalStateException("Size differs");
        int count = a.getWidth() * a.getHeight();
        int[] left = new int[count], right = new int[count];
        a.getPixels(left, 0, a.getWidth(), 0, 0, a.getWidth(), a.getHeight());
        b.getPixels(right, 0, b.getWidth(), 0, 0, b.getWidth(), b.getHeight());
        int mismatches = 0, alpha = 0, maximum = 0;
        for (int i = 0; i < count; i++) {
            if (left[i] != right[i]) mismatches++;
            if ((left[i] >>> 24) != (right[i] >>> 24)) alpha++;
            for (int shift = 0; shift <= 24; shift += 8)
                maximum = Math.max(maximum, Math.abs((left[i] >>> shift & 255) - (right[i] >>> shift & 255)));
        }
        JSONObject result = new JSONObject();
        result.put("pixels", count); result.put("mismatchedPixels", mismatches);
        result.put("maxChannelDelta", maximum); result.put("alphaMismatches", alpha);
        return result;
    }

    private static void save(Bitmap bitmap, File file) throws Exception {
        try (FileOutputStream stream = new FileOutputStream(file)) {
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw new IllegalStateException("PNG encode failed");
        }
    }
}

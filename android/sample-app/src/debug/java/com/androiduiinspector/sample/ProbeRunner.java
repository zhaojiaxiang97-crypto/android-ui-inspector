package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Bitmap;
import android.view.SurfaceView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;
import com.androiduiinspector.sdk.IsolatedCapture;
import com.androiduiinspector.sdk.DebugNames;

import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

final class ProbeRunner {
    private ProbeRunner() {}

    static void label(View view, String name) { DebugNames.set(view, name); }

    static void run(Activity activity, FrameLayout parent, TextView text, View opaqueChild) {
        JSONObject report = new JSONObject();
        File output = new File(activity.getFilesDir(), "isolation-probe");
        try {
            if (!output.exists() && !output.mkdirs()) throw new IllegalStateException("Could not create probe directory");
            Bitmap group = IsolatedCapture.group(parent);
            Bitmap child = IsolatedCapture.own(text);
            int groupRed = redPixels(group);
            int groupGreen = greenPixels(group);
            int childRed = redPixels(child);
            int childCornerAlpha = android.graphics.Color.alpha(child.getPixel(0, 0));
            report.put("parentGroupRedPixels", groupRed);
            report.put("parentGroupGreenPixels", groupGreen);
            boolean opaqueChildClipped = parent.getClipChildren() && opaqueChild.getRight() > parent.getWidth()
                    && opaqueChild.getBottom() > parent.getHeight();
            report.put("opaqueChildClipped", opaqueChildClipped);
            report.put("childRedPixels", childRed);
            report.put("childCornerAlpha", childCornerAlpha);
            report.put("leafOwnPassed", childRed > 0 && childCornerAlpha == 0);
            try {
                IsolatedCapture.own(new SurfaceView(activity));
                report.put("surfaceOwnRejected", false);
            } catch (UnsupportedOperationException expected) {
                report.put("surfaceOwnRejected", true);
            }
            save(group, new File(output, "parent-group.png"));
            save(child, new File(output, "child-own.png"));
            try {
                Bitmap own = IsolatedCapture.own(parent);
                int ownRed = redPixels(own);
                int ownGreen = greenPixels(own);
                int decoration = own.getPixel(10, 10);
                report.put("parentOwnRedPixels", ownRed);
                report.put("parentOwnGreenPixels", ownGreen);
                report.put("parentOwnDecorationPassed", decoration == android.graphics.Color.YELLOW);
                report.put("parentOwnAvailable", true);
                report.put("isolationPassed", groupRed > 0 && childRed > 0 && childCornerAlpha == 0
                        && groupGreen > 0 && ownRed == 0 && ownGreen == 0
                        && decoration == android.graphics.Color.YELLOW && opaqueChildClipped);
                save(own, new File(output, "parent-own.png"));
            } catch (Throwable failure) {
                report.put("parentOwnAvailable", false);
                report.put("isolationPassed", false);
                Throwable cause = failure.getCause() != null ? failure.getCause() : failure;
                report.put("parentOwnError", cause.getClass().getName() + ": " + cause.getMessage());
            }
            report.put("parentWidth", parent.getWidth());
            report.put("parentHeight", parent.getHeight());
            report.put("sdkInt", android.os.Build.VERSION.SDK_INT);
            try (FileOutputStream stream = new FileOutputStream(new File(output, "result.json"))) {
                stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception failure) {
            android.util.Log.e("InspectorProbe", "Probe failed", failure);
            try {
                if (!output.exists()) output.mkdirs();
                report.put("isolationPassed", false);
                report.put("probeError", failure.getClass().getName() + ": " + failure.getMessage());
                try (FileOutputStream stream = new FileOutputStream(new File(output, "result.json"))) {
                    stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception ignored) {
                // This is a disposable test App; logcat still has the original failure.
            }
        }
    }

    static void runVisual(Activity activity, FrameLayout stage) {
        File output = new File(activity.getFilesDir(), "isolation-probe");
        try {
            if (!output.exists() && !output.mkdirs()) throw new IllegalStateException("Could not create probe directory");
            boolean groupRejected = false;
            try {
                IsolatedCapture.group(stage).recycle();
            } catch (UnsupportedOperationException expected) { groupRejected = true; }
            Bitmap own = IsolatedCapture.own(stage);
            Bitmap red = IsolatedCapture.own(stage.getChildAt(0));
            Bitmap green = IsolatedCapture.own(stage.getChildAt(1));
            int middle = stage.getWidth() / 2;
            JSONObject report = new JSONObject();
            report.put("roundedGroupRejected", groupRejected);
            report.put("stageOwnCorner", own.getPixel(0, 0));
            report.put("stageOwnCenter", own.getPixel(middle / 2, middle));
            report.put("redOwnCenter", red.getPixel(middle / 2, middle));
            report.put("greenOwnCenter", green.getPixel(middle / 2, middle));
            report.put("stageAlpha", stage.getAlpha());
            report.put("stageWidth", stage.getWidth());
            report.put("stageHeight", stage.getHeight());
            report.put("visualPassed", groupRejected && own.getPixel(0, 0) == 0
                    && own.getPixel(middle / 2, middle) == android.graphics.Color.BLUE
                    && red.getPixel(middle / 2, middle) == android.graphics.Color.RED
                    && green.getPixel(middle / 2, middle) == android.graphics.Color.GREEN);
            save(own, new File(output, "visual-own.png"));
            save(red, new File(output, "visual-red.png"));
            save(green, new File(output, "visual-green.png"));
            try (FileOutputStream stream = new FileOutputStream(new File(output, "visual-result.json"))) {
                stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable failure) {
            android.util.Log.e("InspectorProbe", "Visual probe failed", failure);
        }
    }

    private static int redPixels(Bitmap bitmap) {
        int count = 0;
        for (int y = 0; y < bitmap.getHeight(); y++) {
            for (int x = 0; x < bitmap.getWidth(); x++) {
                int pixel = bitmap.getPixel(x, y);
                if (android.graphics.Color.alpha(pixel) > 0 && android.graphics.Color.red(pixel) > 180
                        && android.graphics.Color.green(pixel) < 80 && android.graphics.Color.blue(pixel) < 80) count++;
            }
        }
        return count;
    }

    private static int greenPixels(Bitmap bitmap) {
        int count = 0;
        for (int y = 0; y < bitmap.getHeight(); y++) {
            for (int x = 0; x < bitmap.getWidth(); x++) {
                int pixel = bitmap.getPixel(x, y);
                if (android.graphics.Color.alpha(pixel) > 0 && android.graphics.Color.red(pixel) < 80
                        && android.graphics.Color.green(pixel) > 180 && android.graphics.Color.blue(pixel) < 100) count++;
            }
        }
        return count;
    }

    private static void save(Bitmap bitmap, File file) throws Exception {
        try (FileOutputStream stream = new FileOutputStream(file)) {
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw new IllegalStateException("PNG encode failed");
        } finally {
            bitmap.recycle();
        }
    }
}

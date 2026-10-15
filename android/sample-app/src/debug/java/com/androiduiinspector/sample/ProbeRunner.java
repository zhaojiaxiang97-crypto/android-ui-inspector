package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Matrix;
import android.view.SurfaceView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;
import com.androiduiinspector.sdk.IsolatedCapture;
import com.androiduiinspector.sdk.DebugNames;
import com.androiduiinspector.sdk.DebugMetadata;

import org.json.JSONObject;
import org.json.JSONArray;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

final class ProbeRunner {
    private ProbeRunner() {}

    /** Internal test instance, with the real Provider's lifecycle-backed capture owner. */
    static Object sdkCapture(Activity activity) throws ReflectiveOperationException {
        Class<?> owner = Class.forName("com.androiduiinspector.sdk.HierarchyProvider");
        Object provider = owner.getDeclaredConstructor().newInstance();
        owner.getMethod("onActivityResumed", Activity.class).invoke(provider, activity);
        java.lang.reflect.Field capture = owner.getDeclaredField("capture");
        capture.setAccessible(true);
        return capture.get(provider);
    }

    static void label(View view, String name) { DebugNames.set(view, name); }
    static void businessInfo(View view) {
        DebugMetadata.setGroup(view, "component", "组件信息",
                DebugMetadata.text("name", "组件名", "SampleCard"),
                DebugMetadata.text("owner", "归属", "Inspector 自有样例"));
        DebugMetadata.setGroup(view, "state", "页面状态",
                DebugMetadata.flag("loading", "加载中", false),
                DebugMetadata.number("retryCount", "重试次数", 0),
                DebugMetadata.text("error", "错误信息", ""));
    }
    static TextView recoveryText(Activity activity, FrameLayout parent, String mode) {
        if (mode.endsWith("alpha")) {
            View transparent = new View(activity);
            transparent.setAlpha(0f);
            transparent.setBackgroundColor(0xffff00ff);
            parent.addView(transparent, new FrameLayout.LayoutParams(12, 12));
        }
        return new BranchRecoveryText(activity, parent, mode);
    }
    static void runSnapshotPhases(Activity activity) { SnapshotPhaseProbe.start(activity); }
    static void runGeometrySerialization(Activity activity) { GeometrySerializationProbe.start(activity); }
    static void runCaptureFailure(Activity activity, FrameLayout parent, View target) { CaptureFailureProbe.start(activity, parent, target); }
    static void runMergedTreeFailure(Activity activity) { MergedTreeFailureProbe.start(activity); }
    static void runSnapshotEncoding(Activity activity, TextView target) { SnapshotEncodingProbe.start(activity, target); }

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

    static void runTransform(Activity activity, FrameLayout parent, View child) {
        File output = new File(activity.getFilesDir(), "isolation-probe");
        JSONObject report = new JSONObject();
        try {
            if (!output.exists() && !output.mkdirs()) throw new IllegalStateException("Could not create probe directory");
            Bitmap own = IsolatedCapture.own(parent); // Hardware snapshot, without children.
            Bitmap leaf = IsolatedCapture.own(child); // Software View.draw, without ancestor clipping.
            int background = own.getPixel(10, parent.getHeight() / 2);
            int outside = leaf.getPixel(child.getWidth() - 5, child.getHeight() - 5);
            Matrix parentMatrix = new Matrix();
            parent.transformMatrixToGlobal(parentMatrix);
            float[] backgroundPoint = { 10, parent.getHeight() / 2f };
            parentMatrix.mapPoints(backgroundPoint);
            Matrix childMatrix = new Matrix();
            child.transformMatrixToGlobal(childMatrix);
            float[] outsidePoint = { child.getWidth() - 5, child.getHeight() - 5 };
            childMatrix.mapPoints(outsidePoint);
            float[] insidePoint = { 10, 10 };
            childMatrix.mapPoints(insidePoint);
            report.put("hardwareAccelerated", parent.isHardwareAccelerated());
            report.put("probeToken", activity.getIntent().getStringExtra("probeToken"));
            report.put("parentOwnPixel", background);
            report.put("childOwnOutsidePixel", outside);
            report.put("parentAlpha", parent.getAlpha());
            report.put("childAlpha", child.getAlpha());
            report.put("parentScale", parent.getScaleX());
            report.put("parentClipChildren", parent.getClipChildren());
            report.put("mergedGeometryVerified", verifyMergedGeometry(child, parent));
            report.put("frameRefReuseVerified", true);
            report.put("backgroundX", backgroundPoint[0]);
            report.put("backgroundY", backgroundPoint[1]);
            report.put("outsideX", outsidePoint[0]);
            report.put("outsideY", outsidePoint[1]);
            report.put("insideX", insidePoint[0]);
            report.put("insideY", insidePoint[1]);
            report.put("passed", parent.isHardwareAccelerated() && parent.getClipChildren()
                    && background == android.graphics.Color.rgb(12, 52, 104)
                    && outside == android.graphics.Color.rgb(0, 220, 60)
                    && own.getWidth() == parent.getWidth() && own.getHeight() == parent.getHeight());
            save(own, new File(output, "transform-parent-own.png"));
            save(leaf, new File(output, "transform-child-own.png"));
        } catch (Throwable failure) {
            report = new JSONObject();
            try { report.put("passed", false).put("error", failure.toString()); } catch (Exception ignored) {}
        }
        try (FileOutputStream stream = new FileOutputStream(new File(output, "transform-result.json"))) {
            stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception failure) { android.util.Log.e("InspectorProbe", "Transform report failed", failure); }
    }

    /** Only the sample mutates controls; compare legacy and merged evidence in one UI task. */
    private static boolean verifyMergedGeometry(View target, FrameLayout parent) throws Exception {
        Class<?> sdk = Class.forName("com.androiduiinspector.sdk.CaptureFrame");
        java.lang.reflect.Method oldChain = sdk.getDeclaredMethod("captureParentContext", View.class, View.class);
        java.lang.reflect.Method oldClips = sdk.getDeclaredMethod("captureClipContext", View.class, View.class);
        java.lang.reflect.Method merged = sdk.getDeclaredMethod("captureParentContext", View.class, View.class, JSONArray.class, java.util.IdentityHashMap.class);
        java.lang.reflect.Method matches = sdk.getDeclaredMethod("matchesParentContext", View.class, View.class, JSONArray.class, JSONArray.class, java.util.IdentityHashMap.class);
        java.lang.reflect.Method identity = sdk.getDeclaredMethod("frameRef", View.class, java.util.IdentityHashMap.class);
        for (java.lang.reflect.Method method : new java.lang.reflect.Method[] { oldChain, oldClips, merged, matches, identity }) method.setAccessible(true);
        java.util.IdentityHashMap<View, String> identities = new java.util.IdentityHashMap<>();
        View root = target.getRootView();
        JSONArray clips = new JSONArray();
        JSONArray chain = (JSONArray) merged.invoke(null, target, root, clips, identities);
        if (!chain.toString().equals(oldChain.invoke(null, target, root).toString())
                || !clips.toString().equals(oldClips.invoke(null, target, root).toString())
                || !((Boolean) matches.invoke(null, target, root, chain, clips, identities))) throw new IllegalStateException("Merged geometry differs");
        Object reused = identity.invoke(null, target, identities);
        if (reused != identity.invoke(null, target, identities)) throw new IllegalStateException("Identity string not reused");
        for (int i = 0; i < 20; i++) identity.invoke(null, new View(target.getContext()), identities);
        if (identities.size() != 16) throw new IllegalStateException("Identity cache not bounded");
        JSONObject record = new JSONObject().put("chain", chain).put("clipContext", clips);
        if (!record.toString().equals(GeometrySerializationProbe.candidate(record))) throw new IllegalStateException("Live geometry serialization differs");
        float alpha = parent.getAlpha(), translation = parent.getTranslationX();
        android.graphics.Rect clip = parent.getClipBounds();
        int left = parent.getPaddingLeft(), top = parent.getPaddingTop(), right = parent.getPaddingRight(), bottom = parent.getPaddingBottom();
        try {
            parent.setAlpha(alpha * 0.5f);
            if ((Boolean) matches.invoke(null, target, root, chain, clips, identities)) throw new IllegalStateException("Alpha mutation accepted");
            parent.setAlpha(alpha);
            parent.setTranslationX(translation + 3);
            if ((Boolean) matches.invoke(null, target, root, chain, clips, identities)) throw new IllegalStateException("Translation mutation accepted");
            parent.setTranslationX(translation);
            parent.setPadding(left + 1, top, right, bottom);
            if ((Boolean) matches.invoke(null, target, root, chain, clips, identities)) throw new IllegalStateException("Padding mutation accepted");
            parent.setPadding(left, top, right, bottom);
            parent.setClipBounds(new android.graphics.Rect(1, 1, parent.getWidth() - 1, parent.getHeight() - 1));
            if ((Boolean) matches.invoke(null, target, root, chain, clips, identities)) throw new IllegalStateException("Clip mutation accepted");
        } finally {
            parent.setAlpha(alpha);
            parent.setTranslationX(translation);
            parent.setPadding(left, top, right, bottom);
            parent.setClipBounds(clip);
        }
        if (!((Boolean) matches.invoke(null, target, root, chain, clips, identities))) throw new IllegalStateException("Geometry not restored");
        android.view.ViewGroup owner = (android.view.ViewGroup) target.getParent();
        int index = owner.indexOfChild(target);
        android.view.ViewGroup.LayoutParams params = target.getLayoutParams();
        try {
            owner.removeView(target);
            if ((Boolean) matches.invoke(null, target, root, chain, clips, identities)) throw new IllegalStateException("Detached parent accepted");
        } finally { owner.addView(target, index, params); }
        return true;
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

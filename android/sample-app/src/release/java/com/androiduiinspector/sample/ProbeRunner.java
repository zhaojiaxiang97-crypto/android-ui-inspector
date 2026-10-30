package com.androiduiinspector.sample;

import android.app.Activity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

final class ProbeRunner {
    static TextView recoveryText(Activity activity, FrameLayout parent, String mode) { return new TextView(activity); }
    static void runSnapshotPhases(Activity activity) {}
    static void runGeometrySerialization(Activity activity) {}
    static void runCaptureFailure(Activity activity, FrameLayout parent, View target) {}
    static void runMergedTreeFailure(Activity activity) {}
    static void runSnapshotEncoding(Activity activity, TextView target) {}
    private ProbeRunner() {}

    static void label(View view, String name) {}
    static void businessInfo(View view) {}

    static void run(Activity activity, FrameLayout parent, TextView text, View opaqueChild) {
        // The release build has no SDK dependency or capture work.
    }

    static void runVisual(Activity activity, FrameLayout stage) {}
    static void runTransform(Activity activity, FrameLayout parent, View child) {}
}

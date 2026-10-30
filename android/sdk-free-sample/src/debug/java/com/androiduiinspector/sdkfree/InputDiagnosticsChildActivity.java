package com.androiduiinspector.sdkfree;

/** A real, separate back-stack entry; only the debug main page can open it. */
public final class InputDiagnosticsChildActivity extends InputDiagnosticsActivity {
    @Override protected boolean isChildPage() { return true; }
}

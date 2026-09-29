package com.androiduiinspector.sdk;

import android.view.View;

/** Optional Debug-only label for Views without a useful text or resource ID. */
public final class DebugNames {
    private DebugNames() {}

    public static void set(View view, String name) {
        if (view == null) throw new IllegalArgumentException("View is required");
        String value = name == null ? null : name.trim();
        if (value != null && value.length() > 128) throw new IllegalArgumentException("Debug name exceeds 128 characters");
        view.setTag(R.id.inspector_debug_name, value == null || value.isEmpty() ? null : value);
    }
}

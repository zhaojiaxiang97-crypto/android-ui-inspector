package com.androiduiinspector.sdk;

import android.view.View;
import android.os.SystemClock;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.ArrayDeque;
import java.util.HashMap;

/** Immutable geometry from this request's published tree, never an earlier capture. */
final class VisibleTreeGuard {
    static final class Changed extends IllegalStateException {
        final String target;
        final String geometry;
        Changed(String target, PublishedTreeDifference difference) {
            super("Published tree geometry changed: " + target); this.target = target; this.geometry = difference.wire;
        }
    }
    final String rootRef;
    private final HashMap<String, int[]> rows = new HashMap<>();
    private final long createdMs = SystemClock.uptimeMillis();
    VisibleTreeGuard(JSONObject tree) throws Exception {
        JSONObject root = tree.getJSONObject("root");
        rootRef = root.getString("ref");
        ArrayDeque<JSONObject> queue = new ArrayDeque<>(); queue.add(root);
        while (!queue.isEmpty()) {
            JSONObject node = queue.removeFirst();
            if (rows.size() >= 5000) throw new IllegalStateException("Guard tree exceeds node budget");
            String ref = node.getString("ref");
            if (rows.put(ref, new int[] {node.getInt("screenX"), node.getInt("screenY"),
                    node.getInt("width"), node.getInt("height")}) != null)
                throw new IllegalStateException("Guard tree identity collision");
            JSONArray children = node.getJSONArray("children");
            for (int i = 0; i < children.length(); i++) queue.add(children.getJSONObject(i));
        }
    }
    /** Called inside the same UI task as drawing, before any bitmap allocation. */
    void verify(View view, View root, String ref, String currentRoot, String phase) {
        int[] point = new int[2]; view.getLocationOnScreen(point);
        int[] expected = rows.get(ref);
        PublishedTreeDifference difference = PublishedTreeDifference.compare(expected,
                new int[] {point[0], point[1], view.getWidth(), view.getHeight()}, rootRef.equals(currentRoot),
                view.isAttachedToWindow(), view.getRootView() == root, view.isShown(), phase,
                SystemClock.uptimeMillis() - createdMs);
        if (difference != null) throw new Changed(ref, difference);
    }
    static Changed changed(Throwable error) {
        for (int i = 0; error != null && i < 8; i++, error = error.getCause())
            if (error instanceof Changed) return (Changed) error;
        return null;
    }
}

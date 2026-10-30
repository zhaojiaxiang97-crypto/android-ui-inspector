package com.androiduiinspector.sdk;

import android.graphics.Matrix;
import android.graphics.Rect;
import android.os.Build;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.IdentityHashMap;

/** Bounded immutable capture evidence. No live Views or shared mutable arrays leave the UI task. */
final class CaptureGeometrySnapshot {
    private final Row[] rows;
    private final String rootRef;
    private final boolean diagnosticOnly;
    private CaptureGeometrySnapshot(Row[] rows, String rootRef, boolean diagnosticOnly) {
        this.rows = rows; this.rootRef = rootRef; this.diagnosticOnly = diagnosticOnly;
    }

    static CaptureGeometrySnapshot read(View view, View root, IdentityHashMap<View, String> identities) {
        return read(view, root, identities, 9);
    }

    static CaptureGeometrySnapshot diagnostic(View view, View root) {
        return read(view, root, new IdentityHashMap<>(4), 2);
    }

    private static CaptureGeometrySnapshot read(View view, View root, IdentityHashMap<View, String> identities, int limit) {
        requireUi();
        ArrayList<Row> rows = new ArrayList<>(9);
        for (View current = view; current != null && rows.size() < limit;) {
            rows.add(new Row(current, identities, limit == 2));
            if (current == root) break;
            current = parent(current);
        }
        return new CaptureGeometrySnapshot(rows.toArray(new Row[0]), identity(root, identities), limit == 2);
    }

    boolean matches(View view, View root, IdentityHashMap<View, String> identities) {
        requireUi();
        View current = view;
        int[] point = new int[2];
        float[] matrix = new float[9];
        for (int i = 0; i < rows.length; i++) {
            if (current == null || !rows[i].matches(current, identities, point, matrix)) return false;
            if (current == root) return i == rows.length - 1;
            current = parent(current);
        }
        return current == null || rows.length == 9;
    }

    JSONObject json(long started, long ended) throws Exception {
        JSONArray chain = new JSONArray(), clips = new JSONArray();
        for (Row row : rows) {
            chain.put(new JSONArray().put(row.ref).put(row.parentRef)
                    .put(row.point[0]).put(row.point[1]).put(row.width).put(row.height)
                    .put(row.scrollX).put(row.scrollY).put((double) row.alpha).put(row.visibility)
                    .put(numbers(row.matrix)).put(row.clipChildren).put(row.clipToPadding).put(row.clipToOutline));
            clips.put(new JSONObject().put("ref", row.ref)
                    .put("clipBounds", row.clip == null ? JSONObject.NULL : integers(row.clip))
                    .put("padding", integers(row.padding)).put("localToScreen", numbers(row.screen)));
        }
        JSONObject value = new JSONObject().put("ref", rows[0].ref).put("rootRef", rootRef)
                .put("started", started).put("ended", ended)
                .put("rootReached", rows[rows.length - 1].ref.equals(rootRef))
                .put("chain", chain).put("clipContext", clips);
        // Match the legacy removal of a null matrix key, including API < 29.
        if (diagnosticOnly) {
            // Before-draw observations only, not clipping/placement proof. Omit screen matrices.
            value.put("diagnosticOnly", true).remove("clipContext");
        } else if (rows[0].screen != null) value.put("localToScreen", clips.getJSONObject(0).getJSONArray("localToScreen"))
                .put("bitmapSpace", "view-local");
        return value;
    }

    boolean isDiagnosticOnly() { return diagnosticOnly; }

    private static final class Row {
        final String ref, parentRef;
        final int[] point = new int[2], clip, padding;
        final float[] matrix = new float[9], screen;
        final int width, height, scrollX, scrollY, visibility;
        final float alpha;
        final boolean clipChildren, clipToPadding, clipToOutline;

        Row(View view, IdentityHashMap<View, String> identities, boolean diagnosticOnly) {
            ref = identity(view, identities);
            View parent = parent(view);
            parentRef = parent == null ? "" : identity(parent, identities);
            view.getLocationOnScreen(point);
            width = view.getWidth(); height = view.getHeight();
            scrollX = view.getScrollX(); scrollY = view.getScrollY();
            alpha = view.getAlpha(); visibility = view.getVisibility();
            view.getMatrix().getValues(matrix);
            ViewGroup group = view instanceof ViewGroup ? (ViewGroup) view : null;
            clipChildren = group != null && group.getClipChildren();
            clipToPadding = group != null && group.getClipToPadding();
            clipToOutline = view.getClipToOutline();
            Rect bounds = view.getClipBounds();
            clip = bounds == null ? null : new int[] { bounds.left, bounds.top, bounds.right, bounds.bottom };
            padding = new int[] { view.getPaddingLeft(), view.getPaddingTop(), view.getPaddingRight(), view.getPaddingBottom() };
            screen = diagnosticOnly ? null : screen(view);
        }

        boolean matches(View view, IdentityHashMap<View, String> identities, int[] point, float[] matrix) {
            View parent = parent(view);
            view.getLocationOnScreen(point);
            view.getMatrix().getValues(matrix);
            ViewGroup group = view instanceof ViewGroup ? (ViewGroup) view : null;
            if (!ref.equals(identity(view, identities)) || !parentRef.equals(parent == null ? "" : identity(parent, identities))
                    || this.point[0] != point[0] || this.point[1] != point[1]
                    || width != view.getWidth() || height != view.getHeight()
                    || scrollX != view.getScrollX() || scrollY != view.getScrollY()
                    || (double) alpha != (double) view.getAlpha() || visibility != view.getVisibility()
                    || clipChildren != (group != null && group.getClipChildren())
                    || clipToPadding != (group != null && group.getClipToPadding())
                    || clipToOutline != view.getClipToOutline() || !same(this.matrix, matrix)) return false;
            Rect bounds = view.getClipBounds();
            if ((bounds == null) != (clip == null)) return false;
            if (bounds != null && (clip[0] != bounds.left || clip[1] != bounds.top || clip[2] != bounds.right || clip[3] != bounds.bottom)) return false;
            return padding[0] == view.getPaddingLeft() && padding[1] == view.getPaddingTop()
                    && padding[2] == view.getPaddingRight() && padding[3] == view.getPaddingBottom()
                    && same(screen, screen(view));
        }
    }

    private static boolean same(float[] a, float[] b) {
        if (a == null || b == null) return a == b;
        if (a.length != b.length) return false;
        for (int i = 0; i < a.length; i++) if ((double) a[i] != (double) b[i]) return false;
        return true;
    }
    private static float[] screen(View view) {
        if (Build.VERSION.SDK_INT < 29) return null;
        Matrix matrix = new Matrix(); view.transformMatrixToGlobal(matrix);
        float[] values = new float[9]; matrix.getValues(values);
        for (float value : values) if (Float.isNaN(value) || Float.isInfinite(value)) return null;
        return values;
    }
    private static JSONArray numbers(float[] values) throws Exception {
        if (values == null) return null;
        JSONArray answer = new JSONArray();
        for (float value : values) answer.put((double) value);
        return answer;
    }
    private static JSONArray integers(int[] values) {
        JSONArray answer = new JSONArray(); for (int value : values) answer.put(value); return answer;
    }
    private static View parent(View view) { return view.getParent() instanceof View ? (View) view.getParent() : null; }
    private static String identity(View view, IdentityHashMap<View, String> identities) {
        String value = identities.get(view);
        if (value == null) {
            value = view.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(view));
            if (identities.size() < 16) identities.put(view, value);
        }
        return value;
    }
    private static void requireUi() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Geometry must be read on UI thread");
    }
}

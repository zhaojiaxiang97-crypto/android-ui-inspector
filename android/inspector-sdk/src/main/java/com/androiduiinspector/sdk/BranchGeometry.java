package com.androiduiinspector.sdk;

import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Bounded geometry-only copy. No retained Views, pixels, or full-tree property export. */
final class BranchGeometry {
    /** Match the SDK tree's effective visibility, including ancestor alpha. UI-thread only. */
    private static boolean visible(View view) {
        if (!view.isShown()) return false;
        // Path <=33 and branch <=64 imply at most 96 Views from this node to DecorView.
        float[] alphas = new float[96];
        int count = 0;
        View current = view;
        while (current != null) {
            if (count == alphas.length) throw new IllegalStateException("Branch visibility ancestor limit exceeded");
            float alpha = current.getAlpha();
            if (Float.isNaN(alpha) || Float.isInfinite(alpha)) throw new IllegalStateException("Branch visibility alpha is invalid");
            alphas[count++] = alpha;
            current = current.getParent() instanceof View ? (View) current.getParent() : null;
        }
        double effective = 1;
        for (int i = count - 1; i >= 0; i--) effective *= Math.max(0, Math.min(1, (double) alphas[i]));
        return effective > 0;
    }
    static String ref(View view) {
        return view.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(view));
    }
    static final class Row {
        final String ref, parent, childRefsHash;
        final int x, y, width, height, childCount;
        final boolean visible;
        final String[] children;
        Row(View view, boolean branch) {
            ref = ref(view);
            parent = view.getParent() instanceof View ? ref((View) view.getParent()) : "";
            int[] location = new int[2]; view.getLocationOnScreen(location);
            x = location[0]; y = location[1]; width = view.getWidth(); height = view.getHeight();
            visible = visible(view);
            childCount = view instanceof ViewGroup ? ((ViewGroup) view).getChildCount() : 0;
            if (childCount > 5000 || branch && childCount > 63) throw new IllegalStateException("Branch geometry node limit exceeded");
            children = new String[branch ? childCount : 0];
            StringBuilder identities = new StringBuilder();
            for (int i = 0; i < childCount; i++) {
                String child = ref(((ViewGroup) view).getChildAt(i));
                if (i > 0) identities.append(';');
                identities.append(child);
                if (branch) children[i] = child;
            }
            try {
                byte[] hash = MessageDigest.getInstance("SHA-256").digest(identities.toString().getBytes(StandardCharsets.UTF_8));
                StringBuilder hex = new StringBuilder(64);
                for (byte b : hash) { hex.append(Character.forDigit((b & 255) >>> 4, 16)); hex.append(Character.forDigit(b & 15, 16)); }
                childRefsHash = hex.toString();
            } catch (Exception error) { throw new IllegalStateException("Branch geometry identity digest unavailable", error); }
        }
        JSONObject json() throws Exception {
            return new JSONObject().put("ref", ref).put("parent", parent).put("x", x).put("y", y)
                .put("width", width).put("height", height).put("visible", visible)
                .put("childCount", childCount).put("children", new JSONArray(children)).put("childRefsHash", childRefsHash);
        }
    }
    static final class Snapshot {
        final ArrayList<Row> ancestors, nodes;
        final long started, ended;
        Snapshot(ArrayList<Row> ancestors, ArrayList<Row> nodes, long started, long ended) {
            this.ancestors = ancestors; this.nodes = nodes; this.started = started; this.ended = ended;
        }
        JSONObject json() throws Exception {
            JSONArray a = new JSONArray(), n = new JSONArray();
            for (Row row : ancestors) a.put(row.json());
            for (Row row : nodes) n.put(row.json());
            return new JSONObject().put("version", 1).put("started", started).put("ended", ended)
                .put("ancestors", a).put("nodes", n);
        }
    }
    static Snapshot read(View root, String[] path) {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Branch geometry requires UI thread");
        if (path.length < 2 || path.length > 33 || !ref(root).equals(path[0]) || !root.isAttachedToWindow())
            throw new IllegalStateException("Branch geometry root or path changed");
        long started = SystemClock.uptimeMillis();
        ArrayList<Row> ancestors = new ArrayList<>(), nodes = new ArrayList<>();
        View current = root;
        int examined = 0;
        HashSet<String> seen = new HashSet<>();
        for (int level = 1; level < path.length; level++) {
            if (SystemClock.uptimeMillis() - started > 250) throw new IllegalStateException("Branch geometry time budget exceeded");
            if (!seen.add(ref(current))) throw new IllegalStateException("Duplicate View identity");
            ancestors.add(new Row(current, false));
            if (!(current instanceof ViewGroup)) throw new IllegalStateException("Branch geometry parent changed");
            ViewGroup parent = (ViewGroup) current;
            int count = parent.getChildCount();
            examined += count;
            if (examined > 5000) throw new IllegalStateException("Branch geometry lookup limit exceeded");
            View found = null;
            for (int i = 0; i < count; i++) {
                View child = parent.getChildAt(i);
                if (path[level].equals(ref(child))) {
                    if (found != null) throw new IllegalStateException("Duplicate View identity");
                    found = child;
                }
            }
            if (found == null) throw new IllegalStateException("Branch geometry identity changed");
            current = found;
        }
        ArrayList<View> pending = new ArrayList<>(); pending.add(current);
        long pixels = 0;
        for (int i = 0; i < pending.size(); i++) {
            if (SystemClock.uptimeMillis() - started > 250) throw new IllegalStateException("Branch geometry time budget exceeded");
            View view = pending.get(i);
            if (!seen.add(ref(view)) || !view.isAttachedToWindow()) throw new IllegalStateException("Branch geometry identity changed");
            Row row = new Row(view, true); nodes.add(row);
            if (row.visible) pixels += (long) row.width * row.height;
            if (pixels > 4_000_000) throw new IllegalStateException("Branch geometry pixel limit exceeded");
            if (pending.size() + row.childCount > 64) throw new IllegalStateException("Branch geometry node limit exceeded");
            for (int child = 0; child < row.childCount; child++) pending.add(((ViewGroup) view).getChildAt(child));
        }
        if (!root.isAttachedToWindow() || !ref(root).equals(path[0]) || SystemClock.uptimeMillis() - started > 250)
            throw new IllegalStateException("Branch geometry window changed or budget exceeded");
        return new Snapshot(ancestors, nodes, started, SystemClock.uptimeMillis());
    }
}

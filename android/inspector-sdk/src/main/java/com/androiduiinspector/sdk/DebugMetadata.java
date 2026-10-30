package com.androiduiinspector.sdk;

import android.os.Looper;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.HashSet;

/** Explicit debug values captured with the View tree; no getters, reflection or callbacks. */
public final class DebugMetadata {
    private DebugMetadata() {}

    public static final int VERSION = 2;
    private static final int MAX_TREE_DEPTH = 8;
    private static final int MAX_TREE_NODES = 128;
    private static final int MAX_NODE_BYTES = 16 * 1024;
    private static final int MAX_CAPTURE_BYTES = 256 * 1024;

    public static final class Field {
        private final String key, label, type;
        private final Object value;
        private Field(String key, String label, String type, Object value) {
            this.key = key(key);
            this.label = label(label);
            this.type = type;
            this.value = value;
        }
    }

    public static Field text(String key, String label, String value) {
        string(value, 512, "Text");
        return new Field(key, label, "string", value);
    }

    public static Field number(String key, String label, double value) {
        if (Double.isNaN(value) || Double.isInfinite(value) || Math.abs(value) > 9007199254740991d)
            throw new IllegalArgumentException("Number must be finite and within the safe numeric range");
        return new Field(key, label, "number", value);
    }

    public static Field flag(String key, String label, boolean value) {
        return new Field(key, label, "boolean", value);
    }

    /** An explicit scalar plus optional children; child arrays are copied immediately. */
    public static final class TreeNode {
        private final String key, label, type;
        private final Object value;
        private final TreeNode[] children;
        private TreeNode(String key, String label, String type, Object value, TreeNode[] children) {
            this.key = key(key);
            this.label = label(label);
            this.type = type;
            this.value = value;
            this.children = copyChildren(children, false);
        }
    }

    public static Field nullValue(String key, String label) {
        return new Field(key, label, "null", JSONObject.NULL);
    }

    public static TreeNode treeText(String key, String label, String value, TreeNode... children) {
        string(value, 512, "Text");
        return new TreeNode(key, label, "string", value, children);
    }

    public static TreeNode treeNumber(String key, String label, double value, TreeNode... children) {
        number(key, label, value);
        return new TreeNode(key, label, "number", value, children);
    }

    public static TreeNode treeFlag(String key, String label, boolean value, TreeNode... children) {
        return new TreeNode(key, label, "boolean", value, children);
    }

    public static TreeNode treeNull(String key, String label, TreeNode... children) {
        return new TreeNode(key, label, "null", JSONObject.NULL, children);
    }

    /** Keys are unique among siblings; full key paths identify nested values. */
    public static Field tree(String key, String label, TreeNode... roots) {
        TreeNode[] copy = copyChildren(roots, true);
        validateTree(copy, 1, new int[] { 0 });
        return new Field(key, label, "tree", copy);
    }

    private static TreeNode[] copyChildren(TreeNode[] children, boolean requireValues) {
        if (children == null || children.length > MAX_TREE_NODES || requireValues && children.length == 0)
            throw new IllegalArgumentException("Tree values require at most 128 nodes and nonempty roots");
        TreeNode[] copy = children.clone();
        HashSet<String> keys = new HashSet<>();
        for (TreeNode child : copy) {
            if (child == null || !keys.add(child.key)) throw new IllegalArgumentException("Tree siblings must be nonnull with unique keys");
        }
        return copy;
    }

    private static void validateTree(TreeNode[] nodes, int depth, int[] count) {
        if (nodes.length > 0 && depth > MAX_TREE_DEPTH) throw new IllegalArgumentException("Tree exceeds its 8-level limit");
        for (TreeNode node : nodes) {
            if (++count[0] > MAX_TREE_NODES) throw new IllegalArgumentException("Tree exceeds its 128-node limit");
            validateTree(node.children, depth + 1, count);
        }
    }

    /** Replace one group atomically. Invoke again when the app's state changes. */
    public static void setGroup(View view, String groupKey, String groupLabel, Field... fields) {
        mainThread(view);
        String key = key(groupKey), label = label(groupLabel);
        if (fields == null || fields.length < 1 || fields.length > 16)
            throw new IllegalArgumentException("A group requires 1 to 16 fields");
        Field[] copy = fields.clone();
        HashSet<String> names = new HashSet<>();
        for (Field field : copy) {
            if (field == null || !names.add(field.key)) throw new IllegalArgumentException("Fields must be nonnull with unique keys");
        }
        LinkedHashMap<String, Group> groups = groups(view);
        groups.put(key, new Group(key, label, copy));
        if (groups.size() > 4) throw new IllegalArgumentException("A View supports at most 4 groups");
        store(view, groups);
    }

    public static void removeGroup(View view, String groupKey) {
        mainThread(view);
        LinkedHashMap<String, Group> groups = groups(view);
        groups.remove(key(groupKey));
        store(view, groups);
    }

    /** Clear before reusing a View for a different business item. */
    public static void clear(View view) {
        mainThread(view);
        view.setTag(R.id.inspector_debug_metadata, null);
    }

    private static void mainThread(View view) {
        if (view == null) throw new IllegalArgumentException("View is required");
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Register debug values on the main thread");
    }

    private static String key(String value) {
        if (value == null || !value.matches("[a-zA-Z][a-zA-Z0-9_.-]{0,63}")) throw new IllegalArgumentException("Invalid debug key");
        return value;
    }

    private static String label(String value) {
        if (value == null) throw new IllegalArgumentException("Label is required");
        String trimmed = value.trim();
        string(trimmed, 64, "Label");
        if (trimmed.isEmpty()) throw new IllegalArgumentException("Label is required");
        for (int i = 0; i < trimmed.length(); i++) {
            if (trimmed.charAt(i) < 32 || trimmed.charAt(i) == 127) throw new IllegalArgumentException("Label contains a control character");
        }
        return trimmed;
    }

    private static void string(String value, int limit, String name) {
        if (value == null || value.length() > limit) throw new IllegalArgumentException(name + " exceeds its character limit or is null");
        for (int i = 0; i < value.length(); i++) {
            char code = value.charAt(i);
            if (Character.isHighSurrogate(code)) {
                if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) throw new IllegalArgumentException("Unpaired Unicode surrogate");
            } else if (Character.isLowSurrogate(code)) throw new IllegalArgumentException("Unpaired Unicode surrogate");
        }
    }

    private static final class Group {
        final String key, label;
        final Field[] fields;
        Group(String key, String label, Field[] fields) { this.key = key; this.label = label; this.fields = fields; }
    }

    private static final class State {
        final LinkedHashMap<String, Group> groups;
        final String json;
        final int bytes, version;
        State(LinkedHashMap<String, Group> groups, String json, int bytes, int version) { this.groups = groups; this.json = json; this.bytes = bytes; this.version = version; }
    }

    private static LinkedHashMap<String, Group> groups(View view) {
        Object state = view.getTag(R.id.inspector_debug_metadata);
        return state instanceof State ? new LinkedHashMap<>(((State) state).groups) : new LinkedHashMap<>();
    }

    private static JSONObject envelope(int version, String status, JSONArray groups) throws JSONException {
        return new JSONObject().put("version", version).put("source", "debug-sdk-explicit").put("status", status).put("groups", groups);
    }

    private static JSONObject encodeNode(TreeNode node, int[] numberReserve) throws JSONException {
        JSONArray children = new JSONArray();
        for (TreeNode child : node.children) children.put(encodeNode(child, numberReserve));
        if (node.type.equals("number")) numberReserve[0] += 32;
        return new JSONObject().put("key", node.key).put("label", node.label).put("type", node.type)
            .put("value", node.value).put("children", children);
    }

    private static void store(View view, LinkedHashMap<String, Group> groups) {
        if (groups.isEmpty()) { view.setTag(R.id.inspector_debug_metadata, null); return; }
        try {
            JSONArray items = new JSONArray();
            int[] numberReserve = { 0 };
            int version = 1;
            for (Group group : groups.values()) {
                JSONArray fields = new JSONArray();
                for (Field field : group.fields) {
                    Object value = field.value;
                    if (field.type.equals("tree")) {
                        version = VERSION;
                        JSONArray roots = new JSONArray();
                        for (TreeNode node : (TreeNode[]) value) roots.put(encodeNode(node, numberReserve));
                        value = roots;
                    } else if (field.type.equals("null")) version = VERSION;
                    fields.put(new JSONObject().put("key", field.key).put("label", field.label).put("type", field.type).put("value", value));
                    // Reserve space for differences in Java/JS decimal serialization.
                    if (field.type.equals("number")) numberReserve[0] += 32;
                }
                items.put(new JSONObject().put("key", group.key).put("label", group.label).put("fields", fields));
            }
            String json = envelope(version, "captured", items).toString();
            int bytes = json.getBytes(StandardCharsets.UTF_8).length + numberReserve[0];
            if (bytes > MAX_NODE_BYTES) throw new IllegalArgumentException("Debug values exceed the 16 KiB View budget");
            view.setTag(R.id.inspector_debug_metadata, new State(groups, json, bytes, version));
        } catch (JSONException error) { throw new IllegalArgumentException("Could not encode debug values", error); }
    }

    static final class Budget { int bytes; }

    static JSONObject read(View view, Budget budget) throws JSONException {
        Object tag = view.getTag(R.id.inspector_debug_metadata);
        if (!(tag instanceof State)) return null;
        State state = (State) tag;
        if (budget.bytes + state.bytes > MAX_CAPTURE_BYTES) return envelope(state.version, "omitted-budget", new JSONArray());
        budget.bytes += state.bytes;
        return new JSONObject(state.json);
    }
}

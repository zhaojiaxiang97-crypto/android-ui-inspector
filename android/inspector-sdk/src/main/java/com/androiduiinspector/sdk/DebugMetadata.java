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
        final int bytes;
        State(LinkedHashMap<String, Group> groups, String json, int bytes) { this.groups = groups; this.json = json; this.bytes = bytes; }
    }

    private static LinkedHashMap<String, Group> groups(View view) {
        Object state = view.getTag(R.id.inspector_debug_metadata);
        return state instanceof State ? new LinkedHashMap<>(((State) state).groups) : new LinkedHashMap<>();
    }

    private static JSONObject envelope(String status, JSONArray groups) throws JSONException {
        return new JSONObject().put("version", 1).put("source", "debug-sdk-explicit").put("status", status).put("groups", groups);
    }

    private static void store(View view, LinkedHashMap<String, Group> groups) {
        if (groups.isEmpty()) { view.setTag(R.id.inspector_debug_metadata, null); return; }
        try {
            JSONArray items = new JSONArray();
            int numberReserve = 0;
            for (Group group : groups.values()) {
                JSONArray fields = new JSONArray();
                for (Field field : group.fields) {
                    fields.put(new JSONObject().put("key", field.key).put("label", field.label).put("type", field.type).put("value", field.value));
                    // Reserve space for differences in Java/JS decimal serialization.
                    if (field.type.equals("number")) numberReserve += 32;
                }
                items.put(new JSONObject().put("key", group.key).put("label", group.label).put("fields", fields));
            }
            String json = envelope("captured", items).toString();
            int bytes = json.getBytes(StandardCharsets.UTF_8).length + numberReserve;
            if (bytes > MAX_NODE_BYTES) throw new IllegalArgumentException("Debug values exceed the 16 KiB View budget");
            view.setTag(R.id.inspector_debug_metadata, new State(groups, json, bytes));
        } catch (JSONException error) { throw new IllegalArgumentException("Could not encode debug values", error); }
    }

    static final class Budget { int bytes; }

    static JSONObject read(View view, Budget budget) throws JSONException {
        Object tag = view.getTag(R.id.inspector_debug_metadata);
        if (!(tag instanceof State)) return null;
        State state = (State) tag;
        if (budget.bytes + state.bytes > MAX_CAPTURE_BYTES) return envelope("omitted-budget", new JSONArray());
        budget.bytes += state.bytes;
        return new JSONObject(state.json);
    }
}

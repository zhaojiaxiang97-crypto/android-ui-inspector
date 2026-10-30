package com.androiduiinspector.sample;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashMap;
import java.util.Iterator;

/** Sample-only, per-worker/per-pass scalar text cache. No Views, geometry or images. */
final class ScalarFormatCache {
    static final int MAX_ENTRIES = 1024, MAX_BYTES = 262144;
    private final boolean enabled;
    private final HashMap<Object, String> values = new HashMap<>();
    private int retainedBytes;
    private long hits, misses;
    ScalarFormatCache(boolean enabled) { this.enabled = enabled; }

    String write(JSONObject object) throws Exception {
        StringBuilder result = new StringBuilder(); append(result, object); return result.toString();
    }
    private String format(Object value) throws Exception {
        boolean cacheable = value instanceof String || value instanceof Double || value instanceof Float
                || value instanceof Long || value instanceof Integer || value instanceof Short || value instanceof Byte;
        if (enabled && cacheable) {
            String existing = values.get(value);
            if (existing != null) { hits++; return existing; }
        }
        misses++;
        String result = value instanceof Number ? JSONObject.numberToString((Number) value) : JSONObject.quote((String) value);
        // Include retained key text plus formatted UTF-16 storage; not an RSS measurement.
        long cost = 64L + 2L * result.length() + (value instanceof String ? 2L * ((String) value).length() : 0);
        if (enabled && cacheable && values.size() < MAX_ENTRIES && cost <= MAX_BYTES - retainedBytes) {
            values.put(value, result); retainedBytes += (int) cost;
        }
        return result;
    }
    private void append(StringBuilder out, Object value) throws Exception {
        if (value instanceof JSONObject) {
            out.append('{'); Iterator<String> keys = ((JSONObject) value).keys(); boolean first = true;
            while (keys.hasNext()) {
                String key = keys.next(); if (!first) out.append(','); first = false;
                out.append(format(key)).append(':'); append(out, ((JSONObject) value).get(key));
            }
            out.append('}');
        } else if (value instanceof JSONArray) {
            out.append('['); JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) { if (i > 0) out.append(','); append(out, array.opt(i)); }
            out.append(']');
        } else if (value == null || value == JSONObject.NULL) out.append("null");
        else if (value instanceof Boolean) out.append(value.toString());
        else if (value instanceof String || value instanceof Number) out.append(format(value));
        else throw new IllegalStateException("Unsupported JSON scalar");
    }
    JSONObject stats() throws Exception {
        return new JSONObject().put("entries", values.size()).put("retainedBytes", retainedBytes)
                .put("hits", hits).put("misses", misses);
    }
    static void selfTest() throws Exception {
        ScalarFormatCache cache = new ScalarFormatCache(true);
        JSONObject edge = new JSONObject().put("escaped/\"", "中文\n\t\"\\/😀\u2028")
                .put("null", JSONObject.NULL).put("negativeZero", -0d).put("fraction", 0.125)
                .put("max", Long.MAX_VALUE).put("min", Long.MIN_VALUE).put("bool", true)
                .put("array", new JSONArray().put(1).put(1.0).put(-0d).put(JSONObject.NULL)
                        .put((Object) Float.valueOf(-0f)).put((Object) null).put(1e20).put(1e-20).put(9223372036854775808d));
        if (!edge.toString().equals(cache.write(edge))) throw new IllegalStateException("Cached edge differs");
        java.util.Random random = new java.util.Random(20261006);
        for (int i = 0; i < 2048; i++) {
            double value = Double.longBitsToDouble(random.nextLong());
            if (!Double.isNaN(value) && !Double.isInfinite(value)) {
                JSONObject record = new JSONObject().put("double", value).put("long", random.nextLong());
                if (!record.toString().equals(cache.write(record))) throw new IllegalStateException("Cached number differs");
            }
        }
        String large = new String(new char[MAX_BYTES]).replace('\0', 'x');
        JSONObject oversized = new JSONObject().put("large", large);
        if (!oversized.toString().equals(cache.write(oversized))) throw new IllegalStateException("Oversized output differs");
        if (cache.values.size() > MAX_ENTRIES || cache.retainedBytes > MAX_BYTES) throw new IllegalStateException("Cache budget exceeded");
        if (new ScalarFormatCache(true).values.size() != 0) throw new IllegalStateException("Cache leaked between passes");
    }
}

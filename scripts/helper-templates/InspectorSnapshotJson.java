package com.artemis.helper;

import java.util.Iterator;
import org.json.JSONException;
import org.json.JSONObject;

/** Snapshot-only JSON encoding. Other values retain the platform JSON serializer. */
public final class InspectorSnapshotJson {
    private static final int MAX_BASE64_CHARS = 24 * 1024 * 1024;
    private static final String SCREENSHOT = "screenshot_base64";
    private static final String MEMBER = ",\"screenshot_base64\":\"";
    private static final byte[] BASE64_VALUES = createBase64Values();

    private InspectorSnapshotJson() {}

    public static String stringify(JSONObject original) {
        // A subclass may override toString(). Never replace that behavior.
        if (original.getClass() != JSONObject.class
                || !Boolean.TRUE.equals(original.opt("success"))
                || !Boolean.TRUE.equals(original.opt("has_screenshot"))
                || !"png".equals(original.opt("screenshot_format"))) return original.toString();
        Object value = original.opt(SCREENSHOT);
        if (!(value instanceof String) || !canonicalBase64((String) value)) return original.toString();

        String screenshot = (String) value;
        JSONObject envelope = new JSONObject();
        try {
            Iterator<String> keys = original.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!SCREENSHOT.equals(key)) envelope.put(key, original.get(key));
            }
        } catch (JSONException invalidValue) {
            // JSONObject.toString() also returns null on a JSON encoding failure.
            return null;
        }
        // Once serialization starts, do not retry an object whose values may have side effects.
        String encoded = envelope.toString();
        if (encoded == null) return null;
        StringBuilder output = new StringBuilder(assembledCapacity(encoded.length(), screenshot.length()));
        output.append(encoded, 0, encoded.length() - 1).append(MEMBER).append(screenshot).append("\"}");
        return output.toString();
    }

    private static int assembledCapacity(int envelopeLength, int screenshotLength) {
        long length = (long) envelopeLength - 1 + MEMBER.length() + screenshotLength + 2;
        if (length > Integer.MAX_VALUE) throw new OutOfMemoryError("Snapshot JSON length exceeds Java string capacity");
        return (int) length;
    }

    private static boolean canonicalBase64(String text) {
        int length = text.length();
        if (length == 0 || length > MAX_BASE64_CHARS || (length & 3) != 0) return false;
        int padding = text.charAt(length - 1) == '=' ? (text.charAt(length - 2) == '=' ? 2 : 1) : 0;
        int dataLength = length - padding;
        for (int i = 0; i < dataLength; i++) if (sextet(text.charAt(i)) < 0) return false;
        if (padding == 2 && (sextet(text.charAt(dataLength - 1)) & 15) != 0) return false;
        if (padding == 1 && (sextet(text.charAt(dataLength - 1)) & 3) != 0) return false;
        return true;
    }

    private static byte[] createBase64Values() {
        byte[] values = new byte[128];
        java.util.Arrays.fill(values, (byte) -1);
        String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (int i = 0; i < alphabet.length(); i++) values[alphabet.charAt(i)] = (byte) i;
        return values;
    }

    private static int sextet(char value) {
        return value < BASE64_VALUES.length ? BASE64_VALUES[value] : -1;
    }
}

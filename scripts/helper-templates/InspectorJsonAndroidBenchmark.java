package com.artemis.helper;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Debug;
import android.util.Base64;
import android.util.JsonReader;
import android.util.JsonToken;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Iterator;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Standalone Android app_process benchmark. Not a Helper service or HTTP endpoint. */
public final class InspectorJsonAndroidBenchmark {
    private static final int MAX_RESPONSE = 32 * 1024 * 1024;
    private static final String UNICODE = "中文 café / " + (char)34 + (char)92 + "\b\f\n\r\t <>& 😀 𝄞 " + (char)0x2028 + (char)0x2029;
    private static final class Fixture {
        JSONObject object, expected;
        byte[] png;
        String pngSha, pixelSha;
        int width, height;
    }
    private static String sha(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder out = new StringBuilder(64);
        for (byte b : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
    private static long heapUsed() { Runtime r = Runtime.getRuntime(); return r.totalMemory() - r.freeMemory(); }
    private static final class Memory extends Thread {
        volatile boolean active = true;
        long javaMax, nativeMax, samples;
        Memory() { setDaemon(true); }
        synchronized void sample() {
            javaMax = Math.max(javaMax, heapUsed());
            nativeMax = Math.max(nativeMax, Debug.getNativeHeapAllocatedSize()); samples++;
        }
        public void run() { while (active) { sample(); try { Thread.sleep(1); } catch (InterruptedException ignored) {} } }
        void finish() throws InterruptedException { active = false; interrupt(); join(); sample(); }
    }
    private static final class Encoding {
        byte[] bytes;
        JSONObject timing;
    }
    private static Encoding encode(JSONObject object, boolean candidate, boolean sampling) throws Exception {
        Memory memory = sampling ? new Memory() : null; long before = heapUsed();
        if (memory != null) { memory.sample(); memory.start(); }
        Encoding result = new Encoding(); double jsonMs, utf8Ms;
        try {
            long start = System.nanoTime();
            String json = candidate ? InspectorSnapshotJson.stringify(object) : object.toString();
            jsonMs = (System.nanoTime() - start) / 1e6;
            if (json == null) throw new AssertionError("serialization returned null");
            start = System.nanoTime(); result.bytes = json.getBytes(StandardCharsets.UTF_8);
            utf8Ms = (System.nanoTime() - start) / 1e6;
        } finally { if (memory != null) memory.finish(); }
        long after = heapUsed();
        if (result.bytes.length > MAX_RESPONSE) throw new AssertionError("synthetic response exceeds product bound");
        result.timing = new JSONObject().put("jsonMs", jsonMs).put("utf8Ms", utf8Ms)
            .put("byteLength", result.bytes.length).put("sha256", sha(result.bytes))
            .put("javaHeapBeforeBytes", before).put("javaHeapAfterBytes", after)
            .put("memorySamples", memory == null ? 0 : memory.samples);
        if (memory != null) result.timing.put("javaHeapObservedMaxBytes", memory.javaMax).put("nativeHeapObservedMaxBytes", memory.nativeMax);
        return result;
    }
    private static String pixels(Bitmap bitmap) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        int[] row = new int[bitmap.getWidth()]; byte[] bytes = new byte[row.length * 4];
        for (int y = 0; y < bitmap.getHeight(); y++) {
            bitmap.getPixels(row, 0, row.length, 0, y, row.length, 1);
            for (int x = 0; x < row.length; x++) for (int c = 0; c < 4; c++) bytes[x * 4 + c] = (byte)(row[x] >>> (24 - c * 8));
            digest.update(bytes);
        }
        StringBuilder out = new StringBuilder(64);
        for (byte b : digest.digest()) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
    private static String decodedPixels(byte[] png, int width, int height) throws Exception {
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inScaled = false; options.inPremultiplied = false;
        Bitmap bitmap = BitmapFactory.decodeByteArray(png, 0, png.length, options);
        if (bitmap == null) throw new AssertionError("PNG decode failed");
        try {
            if (bitmap.getWidth() != width || bitmap.getHeight() != height) throw new AssertionError("PNG dimensions changed");
            return pixels(bitmap);
        } finally { bitmap.recycle(); }
    }
    private static Fixture fixture(String name) throws Exception {
        Fixture f = new Fixture();
        if (name.equals("small")) { f.width = 512; f.height = 640; }
        else if (name.equals("medium")) { f.width = 832; f.height = 832; }
        else if (name.equals("large")) { f.width = 1024; f.height = 960; }
        else if (name.equals("near")) { f.width = 2000; f.height = 2000; }
        else throw new IllegalArgumentException("fixture must be small|medium|large|near");
        Bitmap bitmap = Bitmap.createBitmap(f.width, f.height, Bitmap.Config.ARGB_8888);
        int[] row = new int[f.width]; int random = 0x13579bdf;
        try {
            for (int y = 0; y < f.height; y++) {
                for (int x = 0; x < f.width; x++) { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; row[x] = 0xff000000 | (random & 0x00ffffff); }
                bitmap.setPixels(row, 0, row.length, 0, y, row.length, 1);
            }
            f.pixelSha = pixels(bitmap);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) throw new AssertionError("PNG encode failed");
            f.png = out.toByteArray();
        } finally { bitmap.recycle(); }
        if (f.png.length > 16 * 1024 * 1024) throw new AssertionError("PNG exceeds product bound");
        f.pngSha = sha(f.png);
        String screenshot = Base64.encodeToString(f.png, Base64.NO_WRAP);
        if (screenshot.length() > 24 * 1024 * 1024) throw new AssertionError("screenshot exceeds candidate bound");
        String node = "<node class=\"android.widget.TextView\" text=\"中文 &amp; café 😀\" content-desc=\"/quote&amp;\" visible-to-user=\"true\"/>";
        StringBuilder xml = new StringBuilder("<?xml version=\"1.0\"?><hierarchy rotation=\"0\">");
        for (int i = 0; i < (name.equals("small") ? 20 : 1024); i++) xml.append(node);
        if (name.equals("near")) {
            // Leave a 1MiB bound margin for JSON escaping and UTF-8 expansion. No pre-timed toString call.
            int padding = 31 * 1024 * 1024 - screenshot.length() - xml.length() - 128 * 1024;
            xml.append("<!--"); for (int i = 0; i < padding; i++) xml.append('x'); xml.append("-->");
        }
        xml.append("</hierarchy>");
        JSONObject window = new JSONObject().put("id", "7").put("type", "application").put("layer", 1)
            .put("active", true).put("focused", true).put("rootAvailable", true).put("packageName", "com.example.synthetic")
            .put("bounds", new JSONObject().put("x", 0).put("y", 0).put("width", f.width).put("height", f.height));
        JSONObject display = new JSONObject().put("width", f.width).put("height", f.height).put("rotation", 0);
        JSONObject timing = new JSONObject().put("startedAtMs", 1).put("hierarchyStartedAtMs", 2).put("hierarchyCompletedAtMs", 3)
            .put("screenshotStartedAtMs", 4).put("screenshotCompletedAtMs", 5).put("completedAtMs", 6);
        JSONObject evidence = new JSONObject().put("protocolVersion", 1).put("serviceInstanceId", "00000000-0000-4000-8000-000000000001")
            .put("captureId", "00000000-0000-4000-8000-000000000002").put("windowId", "7").put("packageName", "com.example.synthetic")
            .put("complete", true).put("lossless", true).put("visibility", "explicit-clipped").put("screenshotTiming", "after-hierarchy")
            .put("displayBefore", display).put("displayAfter", display).put("windowsBefore", new JSONArray().put(window))
            .put("windowsAfter", new JSONArray().put(window)).put("timing", timing);
        f.object = new JSONObject().put("success", true).put("xml", xml.toString()).put("width", f.width).put("height", f.height)
            .put("rotation", 0).put("screenshot_base64", screenshot).put("window_count", 1).put("node_count", name.equals("small") ? 20 : 1024)
            .put("truncated", false).put("has_screenshot", true).put("screenshot_format", "png").put("helperObservation", evidence)
            .put("syntheticTypes", new JSONArray().put(UNICODE).put(1).put(-2.5).put(true).put(false).put(JSONObject.NULL)
                .put(new JSONObject().put("escaped", UNICODE).put("empty", "")));
        f.expected = (JSONObject)copy(f.object);
        return f;
    }
    private static Object copy(Object value) throws Exception {
        if (value instanceof JSONObject) {
            JSONObject result = new JSONObject(), source = (JSONObject)value; Iterator<String> keys = source.keys();
            while (keys.hasNext()) { String key = keys.next(); result.put(key, copy(source.get(key))); } return result;
        }
        if (value instanceof JSONArray) {
            JSONArray result = new JSONArray(), source = (JSONArray)value;
            for (int i = 0; i < source.length(); i++) result.put(copy(source.get(i))); return result;
        }
        return value;
    }
    private static void equal(Object a, Object b) throws Exception {
        if (a == JSONObject.NULL || b == JSONObject.NULL) { if (a != b) throw new AssertionError("null changed"); return; }
        if (a instanceof JSONObject && b instanceof JSONObject) {
            JSONObject left = (JSONObject)a, right = (JSONObject)b;
            if (left.length() != right.length()) throw new AssertionError("object fields changed");
            Iterator<String> keys = left.keys();
            while (keys.hasNext()) { String key = keys.next(); if (!right.has(key)) throw new AssertionError("missing field"); equal(left.get(key), right.get(key)); }
        } else if (a instanceof JSONArray && b instanceof JSONArray) {
            JSONArray left = (JSONArray)a, right = (JSONArray)b;
            if (left.length() != right.length()) throw new AssertionError("array changed");
            for (int i = 0; i < left.length(); i++) equal(left.get(i), right.get(i));
        } else if (a instanceof Number && b instanceof Number) {
            if (Double.compare(((Number)a).doubleValue(), ((Number)b).doubleValue()) != 0) throw new AssertionError("number changed");
        } else if (a == null || b == null || a.getClass() != b.getClass() || !a.equals(b)) throw new AssertionError("value or JSON type changed");
    }
    private static void compareJson(JsonReader reader, Object expected, Fixture f, boolean root, boolean screenshot, boolean checkPixels) throws Exception {
        JsonToken token = reader.peek();
        if (expected == JSONObject.NULL) {
            if (token != JsonToken.NULL) throw new AssertionError("null token changed"); reader.nextNull();
        } else if (expected instanceof JSONObject) {
            if (token != JsonToken.BEGIN_OBJECT) throw new AssertionError("object token changed");
            JSONObject object = (JSONObject)expected; Set<String> remaining = new HashSet<>();
            Iterator<String> keys = object.keys(); while (keys.hasNext()) remaining.add(keys.next());
            reader.beginObject();
            while (reader.hasNext()) {
                String key = reader.nextName();
                if (!remaining.remove(key)) throw new AssertionError("duplicate or unknown object field");
                compareJson(reader, object.get(key), f, false, root && key.equals("screenshot_base64"), checkPixels);
            }
            reader.endObject(); if (!remaining.isEmpty()) throw new AssertionError("missing object field");
        } else if (expected instanceof JSONArray) {
            if (token != JsonToken.BEGIN_ARRAY) throw new AssertionError("array token changed");
            JSONArray array = (JSONArray)expected; reader.beginArray();
            for (int i = 0; i < array.length(); i++) {
                if (!reader.hasNext()) throw new AssertionError("short array");
                compareJson(reader, array.get(i), f, false, false, checkPixels);
            }
            if (reader.hasNext()) throw new AssertionError("long array"); reader.endArray();
        } else if (expected instanceof String) {
            if (token != JsonToken.STRING) throw new AssertionError("string token changed");
            String actual = reader.nextString();
            if (!expected.equals(actual)) throw new AssertionError("string value changed");
            if (screenshot && f != null) {
                byte[] decoded = Base64.decode(actual, Base64.DEFAULT);
                if (!Arrays.equals(decoded, f.png)) throw new AssertionError("PNG bytes changed");
                if (checkPixels && !decodedPixels(decoded, f.width, f.height).equals(f.pixelSha)) throw new AssertionError("decoded pixels changed");
            }
        } else if (expected instanceof Boolean) {
            if (token != JsonToken.BOOLEAN || !expected.equals(reader.nextBoolean())) throw new AssertionError("boolean token changed");
        } else if (expected instanceof Number) {
            if (token != JsonToken.NUMBER || new BigDecimal(expected.toString()).compareTo(new BigDecimal(reader.nextString())) != 0)
                throw new AssertionError("number token changed");
        } else throw new AssertionError("unsupported expected JSON type");
    }
    private static void validateJson(Object expected, byte[] bytes, Fixture f, boolean checkPixels) throws Exception {
        try (JsonReader reader = new JsonReader(new InputStreamReader(new ByteArrayInputStream(bytes),
            StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)))) {
            reader.setLenient(false);
            compareJson(reader, expected, f, true, false, checkPixels);
            if (reader.peek() != JsonToken.END_DOCUMENT) throw new AssertionError("trailing JSON content");
        }
    }
    private static void validateOne(Fixture f, Encoding encoding, boolean checkPixels) throws Exception {
        validateJson(f.expected, encoding.bytes, f, checkPixels);
    }
    private static void stage(String name, String phase, int index, String stage) {
        System.err.println("D3 " + name + " " + phase + " " + index + " " + stage);
    }
    private static void pair(Fixture f, String name, String phase, int index, boolean ab) throws Exception {
        Encoding a, b;
        boolean sampling = phase.equals("memory-probe");
        if (ab) {
            stage(name, phase, index, "baseline-encode"); a = encode(f.object, false, sampling);
            stage(name, phase, index, "candidate-encode"); b = encode(f.object, true, sampling);
        } else {
            stage(name, phase, index, "candidate-encode"); b = encode(f.object, true, sampling);
            stage(name, phase, index, "baseline-encode"); a = encode(f.object, false, sampling);
        }
        equal(f.expected, f.object);
        stage(name, phase, index, "baseline-validation"); validateOne(f, a, phase.equals("cold-first"));
        stage(name, phase, index, "candidate-validation"); validateOne(f, b, phase.equals("cold-first"));
        stage(name, phase, index, "validated");
        System.out.println(new JSONObject().put("event", "pair").put("fixture", name).put("phase", phase).put("index", index)
            .put("order", ab ? "AB" : "BA").put("baseline", a.timing).put("candidate", b.timing)
            .put("fieldsEqual", true).put("pngBytesEqual", true).put("decodedPixelsEqual", true).put("originalUnchanged", true)
            .put("bytesEqual", Arrays.equals(a.bytes, b.bytes)).toString());
    }
    private static void selfTest() throws Exception {
        int count = 0;
        for (JSONObject object : new JSONObject[] {
            new JSONObject().put("success", false).put("detail", UNICODE),
            new JSONObject().put("success", true).put("has_screenshot", false).put("screenshot_base64", "AA=="),
            new JSONObject().put("success", true).put("has_screenshot", true).put("screenshot_format", "jpeg").put("screenshot_base64", "AA=="),
            new JSONObject().put("success", true).put("has_screenshot", true).put("screenshot_format", "png").put("screenshot_base64", "bad_"),
            new JSONObject().put("success", true).put("has_screenshot", true).put("screenshot_format", "png").put("screenshot_base64", 7)
        }) {
            String expected = object.toString(), actual = InspectorSnapshotJson.stringify(object);
            if (!expected.equals(actual) || !expected.equals(object.toString())) throw new AssertionError("fallback changed original bytes/object"); count++;
        }
        JSONObject typed = new JSONObject().put("x", 1).put("unicode", UNICODE).put("array", new JSONArray().put(true).put(false).put(JSONObject.NULL).put(-2.5)
            .put(new JSONObject().put("empty", "")));
        validateJson(typed, typed.toString().getBytes(StandardCharsets.UTF_8), null, false);
        JSONObject one = new JSONObject().put("x", 1); int invalid = 0;
        for (String json : new String[] {"{\"x\":1,\"x\":1}", "{}", "{\"x\":\"1\"}", "{\"x\":true}", "{\"x\":null}",
            "{\"x\":1,\"extra\":false}", "{\"x\":1} true", "{\"x\":[1]}"}) {
            boolean rejected = false;
            try { validateJson(one, json.getBytes(StandardCharsets.UTF_8), null, false); }
            catch (Exception | AssertionError expected) { rejected = true; }
            if (!rejected) throw new AssertionError("streaming validator accepted changed JSON"); invalid++;
        }
        System.out.println(new JSONObject().put("event", "self-test").put("runtime", "Android").put("cases", count)
            .put("streamingChecks", invalid + 1).put("passed", true));
    }
    public static void main(String[] args) throws Exception {
        if (Build.VERSION.SDK_INT < 26) throw new IllegalStateException("real Android API26+ required; desktop JVM results are not valid");
        if (args.length == 1 && args[0].equals("self-test")) { selfTest(); return; }
        if (args.length != 4) throw new IllegalArgumentException("small|medium|large|near WARM_PAIRS(2..10) WARMUP_PAIRS(1..5) AB|BA");
        String name = args[0]; int repetitions = Integer.parseInt(args[1]), warmup = Integer.parseInt(args[2]);
        if (repetitions < 2 || repetitions > 10 || warmup < 1 || warmup > 5 || !(args[3].equals("AB") || args[3].equals("BA"))) throw new IllegalArgumentException("invalid bound/order");
        Fixture f = fixture(name); boolean ab = args[3].equals("AB");
        System.out.println(new JSONObject().put("event", "fixture").put("fixture", name).put("runtime", "Android")
            .put("sdkInt", Build.VERSION.SDK_INT).put("platformOrgJson", true).put("width", f.width).put("height", f.height)
            .put("pngBytes", f.png.length).put("pngSha256", f.pngSha).put("pixelSha256", f.pixelSha).put("warmPairs", repetitions)
            .put("warmupPairs", warmup).put("firstOrder", args[3]).put("memorySampleIntervalMs", 1)
            .put("memoryLimit", "1ms sampler only in separate memory-probe pair; observed allocation high-water, not exact/RSS peak; timing rounds unsampled")
            .put("coldLimit", "first fixture encode pair without warmup; fixture construction uses org.json and native PNG beforehand")
            .put("timingLimit", "only serialization and UTF8; not Helper request, screen capture, or task latency").toString());
        pair(f, name, "cold-first", 0, ab);
        for (int i = 0; i < warmup; i++) pair(f, name, "warmup", i, (i & 1) == 0 ? !ab : ab);
        for (int i = 0; i < repetitions; i++) pair(f, name, "warm", i, (i & 1) == 0 ? ab : !ab);
        pair(f, name, "memory-probe", 0, ab);
        System.out.println(new JSONObject().put("event", "complete").put("fixture", name).put("pairs", 2 + warmup + repetitions).put("passed", true));
    }
}

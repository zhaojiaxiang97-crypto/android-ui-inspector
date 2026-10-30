package com.androiduiinspector.sample;

import android.app.Activity;
import android.os.Debug;
import android.graphics.Bitmap;
import android.view.View;
import android.view.ViewGroup;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONStringer;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.lang.reflect.Method;
import java.lang.reflect.Field;
import org.lsposed.hiddenapibypass.HiddenApiBypass;

/** Sample-only experiment: immutable original or parsed records, no production serializer change. */
final class GeometrySerializationProbe {
    static void start(Activity activity) {
        if (activity.getIntent().getBooleanExtra("geometrySplitProbe", false)) {
            startSplit(activity);
            return;
        }
        if (activity.getIntent().getBooleanExtra("geometryPipelineProbe", false)) {
            GeometryPipelineProbe.start(activity);
            return;
        }
        String token = activity.getIntent().getStringExtra("probeToken");
        boolean candidateFirst = activity.getIntent().getBooleanExtra("geometryCandidateFirst", false);
        boolean originalObjects = activity.getIntent().getBooleanExtra("geometryOriginalObjects", false);
        // Traverse live Views only on the UI thread. Each subsequent capture uses the
        // SDK's normal bounded UI task and rejects changes before yielding evidence.
        ArrayList<View> views = new ArrayList<>();
        final View root = activity.getWindow().getDecorView();
        new Thread(() -> {
            JSONObject report = new JSONObject();
            try {
                report.put("probeToken", token);
                if (originalObjects) {
                    // Selection must run on UI, including private draw flags, just as the SDK.
                    java.util.concurrent.CountDownLatch selected = new java.util.concurrent.CountDownLatch(1);
                    java.util.concurrent.atomic.AtomicReference<Throwable> selectionError = new java.util.concurrent.atomic.AtomicReference<>();
                    activity.runOnUiThread(() -> {
                        try { collect(root, views); } catch (Throwable error) { selectionError.set(error); }
                        finally { selected.countDown(); }
                    });
                    if (!selected.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("Selection expired");
                    if (selectionError.get() != null) throw new IllegalStateException("Selection failed", selectionError.get());
                }
                JSONArray records;
                if (originalObjects) {
                    records = captureOriginal(activity, root, views);
                    report.put("selectedViews", views.size());
                    views.clear();
                } else {
                    records = readFixture(activity);
                }
                if (records.length() < 400 || records.length() > 1200) throw new IllegalStateException("Need supported large tree");
                // Escape/null/negative-zero/fractional/large-number checks are outside timed rounds.
                JSONObject edge = new JSONObject().put("escaped/\"", "中文\n\t\"\\/😀\u2028")
                        .put("null", JSONObject.NULL).put("negativeZero", -0d).put("fraction", 0.125)
                        .put("max", Long.MAX_VALUE).put("min", Long.MIN_VALUE).put("bool", true)
                        .put("array", new JSONArray().put(1).put(1.0).put(-0d).put(JSONObject.NULL)
                                .put((Object) Float.valueOf(-0f)).put((Object) null).put(1e20).put(1e-20).put(9223372036854775808d));
                if (!edge.toString().equals(candidate(edge))) throw new IllegalStateException("Edge serialization differs");
                java.util.Random random = new java.util.Random(20261004);
                for (int i = 0; i < 2048; i++) {
                    double value = Double.longBitsToDouble(random.nextLong());
                    if (Double.isNaN(value) || Double.isInfinite(value)) continue;
                    JSONObject numbers = new JSONObject().put("double", value).put("long", random.nextLong());
                    if (!numbers.toString().equals(candidate(numbers))) throw new IllegalStateException("Numeric serialization differs: " + i);
                }
                if (originalObjects) {
                    report.put("originalObjects", true).put("workers", 2).put("queueDepth", 4);
                    JSONArray parsed = new JSONArray(records.toString());
                    String[] expected = serialize(records, false);
                    verify(expected, serialize(parsed, false));
                    report.put("originalTypes", scalarTypes(records)).put("parsedTypes", scalarTypes(parsed));
                    JSONArray groups = new JSONArray();
                    try {
                        // Source order is reversed together with the candidate order on a rerun.
                        for (int group = 0; group < 2; group++) {
                            boolean parsedSource = (group == 1) != candidateFirst;
                            JSONArray source = parsedSource ? parsed : records;
                            groups.put(new JSONObject().put("parsed", parsedSource)
                                    .put("scalarProfile", profileScalars(source))
                                    .put("rounds", parallelRounds(source, expected, candidateFirst)));
                        }
                    } finally { views.clear(); }
                    long bytes = 0;
                    for (String value : expected) bytes += value.getBytes(StandardCharsets.UTF_8).length + 1;
                    report.put("passed", true).put("records", records.length()).put("recordBytes", bytes)
                            .put("edgeCasesPassed", true).put("groups", groups);
                } else {
                String[] expected = serialize(records, false);
                verify(expected, serialize(records, true)); // Warm both paths, not included in timings.
                JSONArray rounds = new JSONArray();
                for (boolean side : new boolean[] { false, true, true, false, false, true, true, false }) {
                    boolean optimized = side != candidateFirst;
                    long cpu = Debug.threadCpuTimeNanos(), wall = System.nanoTime();
                    String[] result = serialize(records, optimized);
                    long elapsed = System.nanoTime() - wall, endedCpu = Debug.threadCpuTimeNanos();
                    verify(expected, result); // Equality and UTF-8 counts are not serialization time.
                    JSONObject round = new JSONObject().put("candidate", optimized).put("wallNanos", elapsed);
                    if (cpu >= 0 && endedCpu >= cpu) round.put("cpuNanos", endedCpu - cpu);
                    rounds.put(round);
                }
                long bytes = 0;
                for (String value : expected) bytes += value.getBytes(StandardCharsets.UTF_8).length + 1;
                report.put("passed", true).put("records", records.length()).put("recordBytes", bytes)
                        .put("edgeCasesPassed", true).put("rounds", rounds);
                }
            } catch (Throwable error) {
                try { report.put("passed", false).put("error", error.toString()); } catch (Exception ignored) {}
            } finally { views.clear(); }
            try {
                File directory = new File(activity.getFilesDir(), "isolation-probe");
                if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Probe directory unavailable");
                try (FileOutputStream stream = new FileOutputStream(new File(directory, "geometry-serialization.json"))) {
                    stream.write(report.toString().getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception ignored) {}
        }, "geometry-serialization-probe").start();
    }

    private static JSONArray readFixture(Activity activity) throws Exception {
        File fixture = new File(activity.getNoBackupFilesDir(), "inspector-geometry-fixture.json");
        if (fixture.length() <= 0 || fixture.length() > 4_000_000) throw new IllegalStateException("Missing bounded fixture");
        ByteArrayOutputStream input = new ByteArrayOutputStream();
        try (FileInputStream stream = new FileInputStream(fixture)) {
            byte[] buffer = new byte[8192];
            int size;
            while ((size = stream.read(buffer)) != -1) {
                if (input.size() + size > 4_000_000) throw new IllegalStateException("Fixture grew");
                input.write(buffer, 0, size);
            }
        }
        return new JSONObject(new String(input.toByteArray(), StandardCharsets.UTF_8)).getJSONArray("records");
    }

    /** One bounded immutable capture, two original-only passes. Not a full pipeline benchmark. */
    private static void startSplit(Activity activity) {
        final View root = activity.getWindow().getDecorView();
        final String token = activity.getIntent().getStringExtra("probeToken");
        final boolean cacheExperiment = activity.getIntent().getBooleanExtra("geometryFormatCache", false);
        new Thread(() -> {
            JSONObject report = new JSONObject();
            ArrayList<View> views = new ArrayList<>();
            ExecutorService workers = Executors.newFixedThreadPool(2);
            try {
                report.put("probeToken", token).put("splitOnly", true).put("workers", 2).put("queueDepth", 4)
                        .put("capturedOnce", true).put("candidate", false);
                if (cacheExperiment) {
                    ScalarFormatCache.selfTest();
                    report.put("candidate", true).put("formatCache", true).put("cacheSelfTestPassed", true)
                            .put("maxEntriesPerWorker", ScalarFormatCache.MAX_ENTRIES).put("maxBytesPerWorker", ScalarFormatCache.MAX_BYTES);
                }
                java.util.concurrent.CountDownLatch ready = new java.util.concurrent.CountDownLatch(1);
                java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
                activity.runOnUiThread(() -> {
                    try { collect(root, views); } catch (Throwable error) { failure.set(error); }
                    finally { ready.countDown(); }
                });
                if (!ready.await(3, TimeUnit.SECONDS) || failure.get() != null) throw new IllegalStateException("Selection failed", failure.get());
                Class<?> provider = Class.forName("com.androiduiinspector.sdk.CaptureFrame");
                Class<?> timingClass = Class.forName("com.androiduiinspector.sdk.CaptureFrame$CaptureTiming");
                java.lang.reflect.Constructor<?> constructor = timingClass.getDeclaredConstructor(); constructor.setAccessible(true);
                Object timing = constructor.newInstance();
                Method capture = provider.getDeclaredMethod("captureFrame", View.class, View.class, boolean.class, timingClass, boolean.class);
                capture.setAccessible(true);
                ArrayList<Object[]> evidence = new ArrayList<>();
                long captureStarted = System.nanoTime(), deadline = android.os.SystemClock.uptimeMillis() + 30_000;
                for (View view : views) {
                    if (android.os.SystemClock.uptimeMillis() > deadline || activity.isDestroyed()) throw new IllegalStateException("Split capture expired");
                    Object frame = capture.invoke(null, view, root, true, timing, true);
                    if (frame == null) continue;
                    Field bitmapField = frame.getClass().getDeclaredField("bitmap"); bitmapField.setAccessible(true);
                    Bitmap bitmap = (Bitmap) bitmapField.get(frame);
                    try {
                        Field geometry = frame.getClass().getDeclaredField("immutableGeometry"); geometry.setAccessible(true);
                        Field started = frame.getClass().getDeclaredField("started"), ended = frame.getClass().getDeclaredField("ended");
                        started.setAccessible(true); ended.setAccessible(true);
                        Object immutable = geometry.get(frame);
                        if (immutable != null) evidence.add(new Object[] { immutable, started.getLong(frame), ended.getLong(frame) });
                    } finally { bitmap.recycle(); }
                }
                views.clear();
                report.put("captureNanos", System.nanoTime() - captureStarted).put("records", evidence.size());
                if (evidence.size() < 400 || evidence.size() > 1200) throw new IllegalStateException("Incomplete immutable large tree");
                Method json = evidence.get(0)[0].getClass().getDeclaredMethod("json", long.class, long.class); json.setAccessible(true);
                ArrayList<String> reference = new ArrayList<>();
                JSONArray rounds = new JSONArray(), scalars = new JSONArray();
                String[] modes = cacheExperiment ? new String[] { "platform", "uncached", "cached", "cached", "uncached", "platform" }
                        : new String[] { "platform", "platform" };
                for (int round = 0; round < modes.length; round++) {
                    final String mode = modes[round];
                    java.util.concurrent.ConcurrentHashMap<Thread, ScalarFormatCache> caches = new java.util.concurrent.ConcurrentHashMap<>();
                    long started = System.nanoTime(), buildNanos = 0, stringifyNanos = 0, buildCpu = 0, stringifyCpu = 0, bytes = 0;
                    boolean cpuAvailable = true;
                    ArrayDeque<Future<Object[]>> pending = new ArrayDeque<>();
                    ArrayList<Object[]> results = new ArrayList<>();
                    for (Object[] input : evidence) {
                        if (pending.size() >= 4) results.add(pending.removeFirst().get(10, TimeUnit.SECONDS));
                        pending.addLast(workers.submit(() -> {
                            long cpu = Debug.threadCpuTimeNanos(), begin = System.nanoTime();
                            JSONObject value = (JSONObject) json.invoke(input[0], input[1], input[2]);
                            long built = System.nanoTime(), builtCpu = Debug.threadCpuTimeNanos();
                            String text = "platform".equals(mode) ? value.toString()
                                    : caches.computeIfAbsent(Thread.currentThread(), key -> new ScalarFormatCache("cached".equals(mode))).write(value);
                            long finished = System.nanoTime(), endCpu = Debug.threadCpuTimeNanos();
                            if (text == null) throw new IllegalStateException("Null JSON output");
                            return new Object[] { value, text, built - begin, finished - built,
                                cpu < 0 || builtCpu < cpu ? -1L : builtCpu - cpu,
                                builtCpu < 0 || endCpu < builtCpu ? -1L : endCpu - builtCpu };
                        }));
                    }
                    while (!pending.isEmpty()) results.add(pending.removeFirst().get(10, TimeUnit.SECONDS));
                    long elapsed = System.nanoTime() - started;
                    JSONArray objects = new JSONArray();
                    // Hashing, equality, UTF-8 counts and scalar microbenchmarks are outside the pass timer.
                    java.security.MessageDigest hash = java.security.MessageDigest.getInstance("SHA-256");
                    for (int i = 0; i < results.size(); i++) {
                        Object[] result = results.get(i); String text = (String) result[1];
                        if (round == 0) reference.add(text);
                        else if (!reference.get(i).equals(text)) throw new IllegalStateException("Immutable output differs: " + i);
                        byte[] encoded = text.getBytes(StandardCharsets.UTF_8); bytes += encoded.length + 1;
                        hash.update(encoded); hash.update((byte) '\n'); objects.put(result[0]);
                        buildNanos += (Long) result[2]; stringifyNanos += (Long) result[3];
                        if ((Long) result[4] < 0 || (Long) result[5] < 0) cpuAvailable = false;
                        else { buildCpu += (Long) result[4]; stringifyCpu += (Long) result[5]; }
                    }
                    StringBuilder digest = new StringBuilder(); for (byte b : hash.digest()) digest.append(String.format("%02x", b & 255));
                    JSONObject pass = new JSONObject().put("round", round).put("wallNanos", elapsed)
                            .put("buildNanos", buildNanos).put("stringifyNanos", stringifyNanos)
                            .put("recordBytes", bytes).put("sha256", digest.toString());
                    if (cpuAvailable) pass.put("buildCpuNanos", buildCpu).put("stringifyCpuNanos", stringifyCpu);
                    if (cacheExperiment) {
                        JSONArray budgets = new JSONArray();
                        for (ScalarFormatCache cache : caches.values()) budgets.put(cache.stats());
                        pass.put("mode", mode).put("cacheWorkers", budgets);
                    }
                    caches.clear(); // No formatted values cross pass/request boundaries.
                    rounds.put(pass); report.put("rounds", rounds);
                    if (!cacheExperiment) { scalars.put(profileScalars(objects)); report.put("scalarProfiles", scalars); }
                }
                report.put("passed", true).put("byteEqualityPassed", true);
            } catch (Throwable error) {
                try { report.put("passed", false).put("error", error.toString()); } catch (Exception ignored) {}
            } finally {
                views.clear(); workers.shutdownNow();
                try { if (!workers.awaitTermination(5, TimeUnit.SECONDS)) report.put("passed", false).put("error", "Workers did not stop"); }
                catch (Exception error) { try { report.put("passed", false).put("error", error.toString()); } catch (Exception ignored) {} }
            }
            try {
                File directory = new File(activity.getFilesDir(), "isolation-probe");
                if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Probe directory unavailable");
                try (FileOutputStream stream = new FileOutputStream(new File(directory, "geometry-serialization.json"))) {
                    stream.write(report.toString().getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception ignored) {}
        }, "geometry-split-probe").start();
    }

    static void collect(View root, ArrayList<View> views) throws Exception {
        Field flags = null;
        for (Field field : HiddenApiBypass.getInstanceFields(View.class)) if ("mPrivateFlags".equals(field.getName())) flags = field;
        if (flags == null) throw new IllegalStateException("Draw flags unavailable");
        flags.setAccessible(true);
        ArrayDeque<View> queue = new ArrayDeque<>();
        queue.add(root);
        int visited = 0;
        while (!queue.isEmpty()) {
            if (++visited > 1200) throw new IllegalStateException("Too many sample Views");
            View view = queue.removeFirst();
            if (view.getVisibility() != View.VISIBLE || view.getAlpha() <= 0) continue;
            if (view.getWidth() > 0 && view.getHeight() > 0 && (long) view.getWidth() * view.getHeight() <= 4_000_000
                    && (flags.getInt(view) & 0x80) == 0) views.add(view);
            if (view instanceof ViewGroup) {
                ViewGroup group = (ViewGroup) view;
                for (int i = 0; i < group.getChildCount(); i++) queue.addLast(group.getChildAt(i));
            }
        }
    }

    private static JSONArray captureOriginal(Activity activity, View root, ArrayList<View> views) throws Exception {
        Class<?> provider = Class.forName("com.androiduiinspector.sdk.CaptureFrame");
        Class<?> timingClass = Class.forName("com.androiduiinspector.sdk.CaptureFrame$CaptureTiming");
        java.lang.reflect.Constructor<?> constructor = timingClass.getDeclaredConstructor();
        constructor.setAccessible(true);
        Object timing = constructor.newInstance();
        Method capture = provider.getDeclaredMethod("captureFrame", View.class, View.class, boolean.class, timingClass);
        capture.setAccessible(true);
        JSONArray records = new JSONArray();
        long deadline = android.os.SystemClock.uptimeMillis() + 60_000;
        for (View view : views) {
            if (android.os.SystemClock.uptimeMillis() > deadline || activity.isDestroyed()) throw new IllegalStateException("Original capture expired");
            Object frame = capture.invoke(null, view, root, true, timing);
            if (frame == null) continue;
            Field bitmapField = frame.getClass().getDeclaredField("bitmap");
            bitmapField.setAccessible(true);
            Bitmap bitmap = (Bitmap) bitmapField.get(frame);
            try {
                Field geometryField = frame.getClass().getDeclaredField("geometry");
                geometryField.setAccessible(true);
                JSONObject geometry = (JSONObject) geometryField.get(frame);
                if (geometry != null) records.put(geometry); // No stringify/parse or cross-task cache.
            } finally { bitmap.recycle(); }
        }
        return records;
    }

    private static JSONObject scalarTypes(Object value) throws Exception {
        JSONObject counts = new JSONObject();
        countTypes(value, counts);
        return counts;
    }

    private static void countTypes(Object value, JSONObject counts) throws Exception {
        if (value instanceof JSONObject) {
            Iterator<String> keys = ((JSONObject) value).keys();
            while (keys.hasNext()) countTypes(((JSONObject) value).get(keys.next()), counts);
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) countTypes(array.opt(i), counts);
        } else {
            String name = value == null ? "null" : value == JSONObject.NULL ? "JSONNull" : value.getClass().getSimpleName();
            counts.put(name, counts.optInt(name) + 1);
        }
    }

    private static JSONObject profileScalars(JSONArray records) throws Exception {
        ArrayList<Number> numbers = new ArrayList<>();
        ArrayList<String> strings = new ArrayList<>();
        collectScalars(records, numbers, strings);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<JSONObject> numeric = workers.submit(() -> scalarTime(numbers, true));
            Future<JSONObject> textual = workers.submit(() -> scalarTime(strings, false));
            return new JSONObject().put("numbers", numeric.get(10, TimeUnit.SECONDS))
                    .put("strings", textual.get(10, TimeUnit.SECONDS));
        } finally {
            workers.shutdownNow();
            if (!workers.awaitTermination(5, TimeUnit.SECONDS)) throw new IllegalStateException("Scalar workers did not stop");
        }
    }

    private static void collectScalars(Object value, ArrayList<Number> numbers, ArrayList<String> strings) throws Exception {
        if (value instanceof JSONObject) {
            Iterator<String> keys = ((JSONObject) value).keys();
            while (keys.hasNext()) {
                String key = keys.next();
                strings.add(key);
                collectScalars(((JSONObject) value).get(key), numbers, strings);
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) collectScalars(array.opt(i), numbers, strings);
        } else if (value instanceof Number) numbers.add((Number) value);
        else if (value instanceof String) strings.add((String) value);
    }

    private static JSONObject scalarTime(java.util.List<?> values, boolean numbers) throws Exception {
        long cpu = Debug.threadCpuTimeNanos(), started = System.nanoTime(), characters = 0;
        for (Object value : values) characters += (numbers ? JSONObject.numberToString((Number) value) : JSONObject.quote((String) value)).length();
        long elapsed = System.nanoTime() - started, endedCpu = Debug.threadCpuTimeNanos();
        JSONObject answer = new JSONObject().put("count", values.size()).put("characters", characters).put("wallNanos", elapsed);
        if (cpu >= 0 && endedCpu >= cpu) answer.put("cpuNanos", endedCpu - cpu);
        return answer;
    }

    private static JSONArray parallelRounds(JSONArray records, String[] expected, boolean candidateFirst) throws Exception {
        ExecutorService workers = Executors.newFixedThreadPool(2);
        JSONArray rounds = new JSONArray();
        try {
            // Warm both paths through the same workers; verification is outside timed tasks.
            parallelSerialize(workers, records, expected, false);
            parallelSerialize(workers, records, expected, true);
            for (boolean side : new boolean[] { false, true, true, false, false, true, true, false }) {
                boolean optimized = side != candidateFirst;
                rounds.put(parallelSerialize(workers, records, expected, optimized));
            }
            return rounds;
        } finally {
            workers.shutdownNow();
            if (!workers.awaitTermination(5, TimeUnit.SECONDS)) throw new IllegalStateException("Serialization workers did not stop");
        }
    }

    private static JSONObject parallelSerialize(ExecutorService workers, JSONArray records, String[] expected, boolean optimized) throws Exception {
        ArrayDeque<Future<Object[]>> pending = new ArrayDeque<>();
        ArrayList<Object[]> results = new ArrayList<>();
        long allocatedBefore = runtimeStat("art.gc.bytes-allocated"), gcBefore = runtimeStat("art.gc.gc-count");
        long started = System.nanoTime(), cpu = 0;
        boolean cpuAvailable = true;
        for (int i = 0; i < records.length(); i++) {
            if (pending.size() >= 4) results.add(pending.removeFirst().get(10, TimeUnit.SECONDS));
            final JSONObject record = records.getJSONObject(i);
            pending.addLast(workers.submit(() -> {
                long cpuStarted = Debug.threadCpuTimeNanos();
                String value = optimized ? candidate(record) : record.toString();
                long ended = Debug.threadCpuTimeNanos();
                return new Object[] { value, cpuStarted < 0 || ended < cpuStarted ? -1L : ended - cpuStarted };
            }));
        }
        while (!pending.isEmpty()) results.add(pending.removeFirst().get(10, TimeUnit.SECONDS));
        long elapsed = System.nanoTime() - started;
        long allocatedAfter = runtimeStat("art.gc.bytes-allocated"), gcAfter = runtimeStat("art.gc.gc-count");
        for (int i = 0; i < results.size(); i++) {
            if (!expected[i].equals(results.get(i)[0])) throw new IllegalStateException("Parallel record differs: " + i);
            long taskCpu = (Long) results.get(i)[1];
            if (taskCpu < 0) cpuAvailable = false;
            else cpu += taskCpu;
        }
        JSONObject answer = new JSONObject().put("candidate", optimized).put("wallNanos", elapsed);
        if (allocatedBefore >= 0 && allocatedAfter >= allocatedBefore) answer.put("processAllocatedBytesDelta", allocatedAfter - allocatedBefore);
        if (gcBefore >= 0 && gcAfter >= gcBefore) answer.put("processGcCountDelta", gcAfter - gcBefore);
        if (cpuAvailable) answer.put("cpuNanos", cpu); // Sum of worker CPU, not elapsed time.
        return answer;
    }

    private static long runtimeStat(String name) {
        if (android.os.Build.VERSION.SDK_INT < 23) return -1;
        try {
            String value = Debug.getRuntimeStat(name);
            return value == null ? -1 : Math.max(-1, Long.parseLong(value));
        } catch (RuntimeException unavailable) { return -1; }
    }

    private static String[] serialize(JSONArray records, boolean optimized) throws Exception {
        String[] result = new String[records.length()];
        for (int i = 0; i < result.length; i++) {
            JSONObject record = records.getJSONObject(i);
            result[i] = optimized ? candidate(record) : record.toString();
        }
        return result;
    }

    private static void verify(String[] expected, String[] result) {
        for (int i = 0; i < expected.length; i++) {
            if (expected[i] == null || !expected[i].equals(result[i])) throw new IllegalStateException("Record differs: " + i);
        }
    }

    static String candidate(JSONObject value) throws Exception {
        JSONStringer writer = new JSONStringer();
        append(writer, value);
        return writer.toString();
    }

    // Experiment only. Preserve platform escaping and numeric output, including
    // Double negative zero; do not infer live-pipeline gains from parsed fixtures.
    private static void append(JSONStringer writer, Object value) throws Exception {
        if (value instanceof JSONObject) {
            writer.object();
            Iterator<String> keys = ((JSONObject) value).keys();
            while (keys.hasNext()) {
                String key = keys.next();
                writer.key(key);
                append(writer, ((JSONObject) value).get(key));
            }
            writer.endObject();
        } else if (value instanceof JSONArray) {
            writer.array();
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) append(writer, array.opt(i));
            writer.endArray();
        } else if (value instanceof Number) {
            Number number = (Number) value;
            double decimal = number.doubleValue();
            long integral = number.longValue();
            boolean negativeZero = value instanceof Double && Double.doubleToRawLongBits(decimal) == Long.MIN_VALUE;
            if (!negativeZero && decimal == (double) integral) writer.value(integral);
            else writer.value(value);
        } else {
            writer.value(value);
        }
    }
}

package com.androiduiinspector.sample;

import android.graphics.Bitmap;
import android.os.Debug;
import android.os.Process;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;
import org.lsposed.hiddenapibypass.HiddenApiBypass;
import java.io.File;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/** Sample-only matched ordinal range. No method tracing, frequency writes or extra workers. */
final class MatchedStageProbe {
    static final int FIRST = 32, END = 96;
    private final Map<String, AtomicLong> counters = new HashMap<>();
    private final Map<String, AtomicLong> sdk = new HashMap<>();
    private final ConcurrentHashMap<Integer, JSONObject> threads = new ConcurrentHashMap<>();
    private final JSONArray proxyRows = new JSONArray();
    private final AtomicLong encodeWall = new AtomicLong(), encodeCpu = new AtomicLong(), jsonWall = new AtomicLong(), jsonCpu = new AtomicLong();
    private final AtomicLong observer = new AtomicLong();
    private final AtomicLong uiCalls = new AtomicLong(), encodeCalls = new AtomicLong(), jsonCalls = new AtomicLong();
    private JSONArray threadReport;
    private final long ageMs = android.os.SystemClock.uptimeMillis() - Process.getStartUptimeMillis();

    MatchedStageProbe(Object timing) throws Exception {
        for (String key : new String[]{"context", "contextCpu", "draw", "drawCpu", "verify", "verifyCpu", "snapshotPrepare", "snapshotInvoke"}) {
            java.lang.reflect.Field field = timing.getClass().getDeclaredField(key); field.setAccessible(true);
            counters.put(key, (AtomicLong) field.get(timing)); sdk.put(key, new AtomicLong());
        }
        threads.put(Process.myPid(), observe(Process.myPid(), "main"));
    }
    boolean selected(int index) { return index >= FIRST && index < END; }
    long[] beforeUi() {
        long began = System.nanoTime();
        long[] values = counters.values().stream().mapToLong(AtomicLong::get).toArray();
        observer.addAndGet(System.nanoTime() - began); return values;
    }
    void afterUi(long[] before) {
        long began = System.nanoTime(); int index = 0;
        for (String key : counters.keySet()) sdk.get(key).addAndGet(counters.get(key).get() - before[index++]);
        uiCalls.incrementAndGet();
        observer.addAndGet(System.nanoTime() - began);
    }
    void workerStarted() {
        int tid = Process.myTid();
        threads.put(tid, observe(tid, "encoder"));
    }
    void encoded(long wall, long cpu) { encodeWall.addAndGet(System.nanoTime() - wall); encodeCpu.addAndGet(Debug.threadCpuTimeNanos() - cpu); encodeCalls.incrementAndGet(); }
    void json(long wall, long cpu) { jsonWall.addAndGet(System.nanoTime() - wall); jsonCpu.addAndGet(Debug.threadCpuTimeNanos() - cpu); jsonCalls.incrementAndGet(); }
    void finishThreads() throws Exception {
        if (threads.size() != 3) throw new IllegalStateException("Missing actual pipeline threads");
        threadReport = new JSONArray();
        for (Map.Entry<Integer, JSONObject> row : threads.entrySet()) threadReport.put(new JSONObject()
                .put("before", row.getValue()).put("after", observe(row.getKey(), row.getValue().getString("role"))));
    }
    private JSONObject observe(int tid, String role) {
        long began = System.nanoTime(); JSONObject result = new JSONObject();
        try {
            result.put("tid", tid).put("role", role).put("priority", Process.getThreadPriority(tid));
            read(result, "stat", "/proc/self/task/" + tid + "/stat");
            read(result, "schedstat", "/proc/self/task/" + tid + "/schedstat");
        } catch (Exception unavailable) { try { result.put("unavailable", true); } catch (Exception ignored) {} }
        long cost = System.nanoTime() - began; observer.addAndGet(cost);
        try { result.put("observerNanos", cost); } catch (Exception ignored) {}
        return result;
    }
    private void read(JSONObject result, String key, String path) throws Exception {
        try {
            String text = new String(Files.readAllBytes(new File(path).toPath()), StandardCharsets.UTF_8).trim();
            if (text.length() > 4096) throw new IllegalStateException("Oversize thread observation");
            result.put(key, text);
        } catch (Exception unavailable) { result.put(key + "Unavailable", true); }
    }

    /** Extra diagnostic render: same provider/dimensions/skipChildren, explicit copy is NOT the SDK compression path. */
    Bitmap proxyCapture(View view, int ordinal) throws Exception {
        if (!view.isHardwareAccelerated() || !view.isShown()) throw new IllegalStateException("Hardware target changed");
        Class<?> type = Class.forName("android.view.ViewDebug$HardwareCanvasProvider");
        Class<?> canvasType = Class.forName("android.view.ViewDebug$CanvasProvider");
        Method get = HiddenApiBypass.getDeclaredMethod(type, "getCanvas", View.class, int.class, int.class);
        Method create = HiddenApiBypass.getDeclaredMethod(type, "createBitmap");
        get.setAccessible(true); create.setAccessible(true);
        Object provider = HiddenApiBypass.newInstance(type);
        long[] phase = new long[6]; // getCanvas wall/cpu, command record wall/cpu, bitmap generation wall/cpu
        long[] recording = new long[2];
        Object proxy = Proxy.newProxyInstance(canvasType.getClassLoader(), new Class<?>[]{canvasType}, (object, method, args) -> {
            long wall = System.nanoTime(), cpu = Debug.threadCpuTimeNanos();
            if (method.getName().equals("getCanvas")) {
                Object canvas = get.invoke(provider, args);
                phase[0] += System.nanoTime() - wall; phase[1] += Debug.threadCpuTimeNanos() - cpu;
                recording[0] = System.nanoTime(); recording[1] = Debug.threadCpuTimeNanos(); return canvas;
            }
            if (method.getName().equals("createBitmap")) {
                if (recording[0] == 0) throw new IllegalStateException("Missing canvas");
                phase[2] += wall - recording[0]; phase[3] += cpu - recording[1];
                try { return create.invoke(provider); }
                finally { phase[4] += System.nanoTime() - wall; phase[5] += Debug.threadCpuTimeNanos() - cpu; }
            }
            throw new UnsupportedOperationException(method.getName());
        });
        int width = view.getWidth(), height = view.getHeight();
        if ((long) width * height <= 0 || (long) width * height > 4_000_000)
            throw new IllegalStateException("Diagnostic bitmap exceeds SDK size budget");
        Bitmap hardware = (Bitmap) HiddenApiBypass.invoke(View.class, view, "createSnapshot", proxy, true);
        if (hardware == null) throw new IllegalStateException("Missing diagnostic bitmap");
        Bitmap readable = null;
        try {
            if (hardware.getConfig() != Bitmap.Config.HARDWARE) throw new IllegalStateException("Non-hardware target");
            long wall = System.nanoTime(), cpu = Debug.threadCpuTimeNanos();
            readable = hardware.copy(Bitmap.Config.ARGB_8888, false);
            long copyWall = System.nanoTime() - wall, copyCpu = Debug.threadCpuTimeNanos() - cpu;
            if (readable == null || readable.getWidth() != width || readable.getHeight() != height)
                throw new IllegalStateException("Diagnostic dimensions changed");
            proxyRows.put(new JSONObject().put("ordinal", ordinal).put("ref", SnapshotPipeline.ref(view)).put("width", width).put("height", height)
                    .put("canvasWallNanos", phase[0]).put("canvasCpuNanos", phase[1]).put("recordWallNanos", phase[2]).put("recordCpuNanos", phase[3])
                    .put("bitmapWallNanos", phase[4]).put("bitmapCpuNanos", phase[5]).put("copyWallNanos", copyWall).put("copyCpuNanos", copyCpu));
            Bitmap answer = readable; readable = null; return answer;
        } finally { hardware.recycle(); if (readable != null) readable.recycle(); }
    }
    JSONObject report() throws Exception {
        if (proxyRows.length() != END - FIRST || threadReport == null) throw new IllegalStateException("Incomplete matched stages");
        JSONObject primary = new JSONObject();
        for (Map.Entry<String, AtomicLong> row : sdk.entrySet()) primary.put(row.getKey() + "Nanos", row.getValue().get());
        primary.put("encodeWallNanos", encodeWall.get()).put("encodeCpuNanos", encodeCpu.get()).put("jsonWallNanos", jsonWall.get()).put("jsonCpuNanos", jsonCpu.get());
        primary.put("uiCalls", uiCalls.get()).put("encodeCalls", encodeCalls.get()).put("jsonCalls", jsonCalls.get());
        return new JSONObject().put("first", FIRST).put("end", END).put("processAgeMs", ageMs).put("primary", primary)
                .put("threads", threadReport).put("observerNanos", observer.get()).put("proxyRows", proxyRows)
                .put("proxyPixelsVerified", true).put("proxyIsAdditionalWork", true).put("explicitCopyIsNotSdkReadback", true);
    }
}

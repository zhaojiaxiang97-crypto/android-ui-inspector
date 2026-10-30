package com.androiduiinspector.sample;

import android.os.Debug;
import android.os.Process;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.nio.file.Files;
import java.security.MessageDigest;

/** Fixed, serial no-View work. Diagnostic only; never changes scheduling or CPU settings. */
final class FixedCpuProbe {
    private final byte[] input = new byte[1024 * 1024];
    private String reference;
    private Integer javaReference;
    private final boolean managed;

    FixedCpuProbe() { this(false); }

    FixedCpuProbe(boolean managed) {
        this.managed = managed;
        for (int i = 0; i < input.length; i++) input[i] = (byte) (i * 31 + 7);
    }

    JSONObject measure() throws Exception {
        JSONObject before = observe();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long age = SystemClock.uptimeMillis() - Process.getStartUptimeMillis();
        long wall = System.nanoTime(), cpu = Debug.threadCpuTimeNanos();
        for (int i = 0; i < 64; i++) digest.update(input);
        byte[] result = digest.digest();
        long cpuNanos = Debug.threadCpuTimeNanos() - cpu;
        long wallNanos = System.nanoTime() - wall;
        StringBuilder hash = new StringBuilder();
        for (byte b : result) hash.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        if (reference != null && !reference.equals(hash.toString())) throw new IllegalStateException("CPU checksum changed");
        reference = hash.toString();
        JSONObject answer = new JSONObject().put("bytes", 64 * input.length).put("sha256", reference)
                .put("processAgeMs", age).put("wallNanos", wallNanos).put("cpuNanos", cpuNanos)
                .put("before", before).put("after", observe());
        if (managed) answer.put("managed", measureJava());
        return answer;
    }

    private JSONObject measureJava() throws Exception {
        long age = SystemClock.uptimeMillis() - Process.getStartUptimeMillis();
        long wall = System.nanoTime(), cpu = Debug.threadCpuTimeNanos();
        int value = 0x12345678;
        for (int index = 0; index < 4_000_000; index++) value = (value ^ (value >>> 13)) * 0x5bd1e995;
        long loopCpu = Debug.threadCpuTimeNanos() - cpu, loopWall = System.nanoTime() - wall;
        int checksum = 0;
        wall = System.nanoTime(); cpu = Debug.threadCpuTimeNanos();
        for (int index = 0; index < 4096; index++) {
            String json = new JSONObject().put("i", index).put("label", "node-" + index).put("visible", true).toString();
            for (int at = 0; at < json.length(); at++) checksum = checksum * 31 + json.charAt(at);
        }
        long jsonCpu = Debug.threadCpuTimeNanos() - cpu, jsonWall = System.nanoTime() - wall;
        if (javaReference != null && javaReference != checksum) throw new IllegalStateException("Java checksum changed");
        javaReference = checksum;
        return new JSONObject().put("processAgeMs", age).put("iterations", 4_000_000).put("loopChecksum", value)
                .put("loopWallNanos", loopWall).put("loopCpuNanos", loopCpu).put("jsonRecords", 4096)
                .put("jsonChecksum", checksum).put("jsonWallNanos", jsonWall).put("jsonCpuNanos", jsonCpu);
    }

    private JSONObject observe() throws Exception {
        long began = System.nanoTime();
        JSONObject result = new JSONObject().put("tid", Process.myTid())
                .put("priority", Process.getThreadPriority(Process.myTid()));
        read(result, "schedstat", new File("/proc/self/task/" + Process.myTid() + "/schedstat"));
        JSONArray policies = new JSONArray();
        File[] files = new File("/sys/devices/system/cpu/cpufreq").listFiles();
        if (files == null) result.put("frequencyUnavailable", true);
        else for (File file : files) if (file.getName().matches("policy[0-9]+")) {
            JSONObject policy = new JSONObject().put("policy", file.getName());
            read(policy, "currentKHz", new File(file, "scaling_cur_freq"));
            policies.put(policy);
        }
        return result.put("frequencies", policies).put("observerNanos", System.nanoTime() - began);
    }

    private void read(JSONObject result, String key, File file) throws Exception {
        try {
            String value = new String(Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8).trim();
            if (value.length() > 256) throw new IllegalStateException("Oversize diagnostic field");
            result.put(key, value);
        } catch (Exception unavailable) { result.put(key + "Unavailable", true); }
    }
}

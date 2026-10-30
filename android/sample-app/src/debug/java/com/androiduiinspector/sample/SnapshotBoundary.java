package com.androiduiinspector.sample;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Debug;
import android.os.PowerManager;
import android.os.Process;
import android.os.SystemClock;
import org.json.JSONObject;

/** Debug-only boundary observations, no polling thread, GC request or thermal changes. */
final class SnapshotBoundary {
    static JSONObject read(Context context) throws Exception {
        long began = System.nanoTime();
        Runtime runtime = Runtime.getRuntime();
        JSONObject result = new JSONObject().put("pid", Process.myPid())
                .put("processStartUptimeMs", Process.getStartUptimeMillis())
                .put("processCpuMs", Process.getElapsedCpuTime())
                .put("uptimeMs", SystemClock.uptimeMillis())
                .put("javaUsedBytes", runtime.totalMemory() - runtime.freeMemory())
                .put("nativeAllocatedBytes", Debug.getNativeHeapAllocatedSize());
        JSONObject gc = new JSONObject();
        for (String key : new String[] { "art.gc.gc-count", "art.gc.gc-time", "art.gc.blocking-gc-count",
                "art.gc.blocking-gc-time", "art.gc.bytes-allocated", "art.gc.bytes-freed" }) {
            String value = Debug.getRuntimeStat(key);
            if (value != null && value.matches("[0-9]+")) gc.put(key, Long.parseLong(value));
        }
        result.put("runtimeStats", gc); // Missing counters are unavailable, not zero.
        try {
            PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (android.os.Build.VERSION.SDK_INT >= 29 && power != null)
                result.put("thermalStatus", power.getCurrentThermalStatus());
        } catch (RuntimeException unavailable) { result.put("thermalUnavailable", true); }
        try {
            Intent battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery != null && battery.hasExtra(BatteryManager.EXTRA_TEMPERATURE))
                result.put("batteryCelsius", battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0);
        } catch (RuntimeException unavailable) { result.put("batteryUnavailable", true); }
        return result.put("observerNanos", System.nanoTime() - began);
    }
}

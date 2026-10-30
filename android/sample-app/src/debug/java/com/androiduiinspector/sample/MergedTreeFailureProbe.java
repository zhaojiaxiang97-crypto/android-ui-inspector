package com.androiduiinspector.sample;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** One bounded merged-tree queue failure, followed by recovery in the same process. */
final class MergedTreeFailureProbe {
    static void start(Activity activity) {
        new Thread(() -> {
            JSONObject report = new JSONObject();
            CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
            try {
                Class<?> type = Class.forName("com.androiduiinspector.sdk.HierarchyCapture");
                Object provider = ProbeRunner.sdkCapture(activity);
                Method capture = type.getDeclaredMethod("captureVisible", android.app.Application.class, String.class, Bundle.class);
                capture.setAccessible(true);
                Handler ui = new Handler(Looper.getMainLooper());
                ui.post(() -> {
                    entered.countDown();
                    try { release.await(4500, TimeUnit.MILLISECONDS); }
                    catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                });
                if (!entered.await(2, TimeUnit.SECONDS)) throw new IllegalStateException("Blocker did not start");
                String nonce = "abcdef0123456789";
                Bundle options = new Bundle(); options.putBoolean("withTree", true);
                long started = SystemClock.elapsedRealtime();
                Bundle failed;
                try { failed = (Bundle) capture.invoke(provider, activity.getApplication(), nonce, options); }
                finally { release.countDown(); }
                long elapsed = SystemClock.elapsedRealtime() - started;
                if (!"ui-timeout".equals(failed.getString("treeFailure")) || !nonce.equals(failed.getString("nonce"))
                        || failed.containsKey("result") || failed.containsKey("count") || elapsed > 4200)
                    throw new IllegalStateException("Unexpected merged failure: " + failed);
                report.put("failure", json(failed)).put("failureMs", elapsed).put("pid", Process.myPid());
                CountDownLatch drained = new CountDownLatch(1); ui.post(drained::countDown);
                if (!drained.await(2, TimeUnit.SECONDS)) throw new IllegalStateException("Late task did not drain");
                Bundle recovered = (Bundle) capture.invoke(provider, activity.getApplication(), "0123456789abcdef", options);
                if (!"ok".equals(recovered.getString("tree")) || !"ok".equals(recovered.getString("result"))
                        || recovered.getInt("count") <= 0
                        || !failed.getString("processInstance").equals(recovered.getString("processInstance")))
                    throw new IllegalStateException("Recovery failed: " + recovered);
                report.put("recovery", json(recovered)).put("passed", true);
            } catch (Throwable error) {
                try { report.put("passed", false).put("error", error.toString()); } catch (Exception ignored) { }
            } finally { release.countDown(); }
            try (FileOutputStream stream = new FileOutputStream(new File(activity.getFilesDir(), "merged-tree-failure-probe.json"))) {
                stream.write(report.toString().getBytes(StandardCharsets.UTF_8));
            } catch (Exception error) { android.util.Log.e("InspectorProbe", "Merged tree report", error); }
        }, "merged-tree-failure-probe").start();
    }

    private static JSONObject json(Bundle bundle) throws Exception {
        JSONObject result = new JSONObject();
        for (String key : bundle.keySet()) result.put(key, bundle.get(key));
        return result;
    }
}

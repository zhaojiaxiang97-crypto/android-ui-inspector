package com.androiduiinspector.sample;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import org.json.JSONObject;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Sample-only, single-use UI hold. Never part of the SDK or Release APK. */
public final class QueueHoldProvider extends ContentProvider {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile Hold current;
    private static final class Hold {
        final String request;
        final long posted = SystemClock.elapsedRealtime();
        final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        volatile long enteredMs = -1, endedMs = -1;
        Hold(String request) { this.request = request; }
    }

    @Override public boolean onCreate() { return true; }

    @Override public Bundle call(String method, String arg, Bundle extras) {
        Bundle answer = new Bundle();
        if (Binder.getCallingUid() != 2000
                || (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0
                || !"com.androiduiinspector.sample".equals(getContext().getPackageName())
                || extras == null || extras.getInt("pid", -1) != Process.myPid()
                || arg == null || !arg.matches("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")) {
            answer.putString("error", "Unauthorized sample hold"); return answer;
        }
        if (!("arm".equals(method) || "read".equals(method) || "release".equals(method))) {
            answer.putString("error", "Unsupported sample hold method"); return answer;
        }
        Hold hold = current;
        if ("arm".equals(method)) {
            synchronized (this) {
                if (current != null) { answer.putString("error", "Sample hold already attempted"); return answer; }
                hold = new Hold(arg); current = hold;
            }
            final Hold selected = hold;
            Runnable block = () -> {
                try {
                    if (selected.release.getCount() == 0) return; // Abandoned queued callback.
                    selected.enteredMs = SystemClock.elapsedRealtime(); selected.entered.countDown();
                    // Fixed, below the ordinary five-second input ANR window. No indefinite wait.
                    selected.release.await(1800, TimeUnit.MILLISECONDS);
                } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                finally { selected.endedMs = SystemClock.elapsedRealtime(); }
            };
            try {
                if (!ui.post(block) || !selected.entered.await(500, TimeUnit.MILLISECONDS))
                    throw new IllegalStateException("Sample hold did not enter");
            } catch (Exception error) {
                selected.release.countDown(); ui.removeCallbacks(block);
                if (error instanceof InterruptedException) Thread.currentThread().interrupt();
                answer.putString("error", error.toString()); return answer;
            }
        } else {
            if (hold == null || !hold.request.equals(arg)) {
                answer.putString("error", "Sample hold identity changed"); return answer;
            }
            if ("release".equals(method)) hold.release.countDown();
        }
        try {
            long entered = hold.enteredMs, ended = hold.endedMs;
            JSONObject state = new JSONObject().put("requestId", hold.request).put("pid", Process.myPid())
                    .put("postedMs", hold.posted).put("enteredMs", entered).put("endedMs", ended)
                    .put("observedMs", SystemClock.elapsedRealtime()).put("limitMs", 1800);
            answer.putString("result", "ok"); answer.putString("state", state.toString());
        } catch (Exception error) { answer.putString("error", error.toString()); }
        return answer;
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) { throw new UnsupportedOperationException(); }
    @Override public String getType(Uri uri) { throw new UnsupportedOperationException(); }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
}

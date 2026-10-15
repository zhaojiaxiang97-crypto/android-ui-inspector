package com.androiduiinspector.sdk;

import android.app.Activity;
import android.app.Application;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import org.json.JSONObject;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Debug-only, DUMP-protected shell request to export a live View tree without opening a port. */
public final class HierarchyProvider extends ContentProvider implements Application.ActivityLifecycleCallbacks {
    // Scoped to the synchronous socket dispatch thread, never the UI thread or another request.
    private final ThreadLocal<OutputStream> treeReadyOutput = new ThreadLocal<>();

    private final ThreadLocal<TreeQueueDiagnostics.Task> treeQueueTask = new ThreadLocal<>();

    private final TreeQueueDiagnostics treeQueueDiagnostics = new TreeQueueDiagnostics(
            SystemClock::elapsedRealtime, message -> Log.d("InspectorTreeQueue", message));

    private static final String FILE_NAME = "inspector-hierarchy.json";

    private final String processInstance = UUID.randomUUID().toString();

    private volatile WeakReference<Activity> resumed = new WeakReference<>(null);

    private volatile HierarchySession session;

    private final HierarchyCapture capture = new HierarchyCapture(
            processInstance, () -> resumed.get(), treeQueueTask, this::notifyTreeReady);

    // Only the debug-source-set facade calls this; no production public probe API.
    HierarchyCapture captureForProbe() { return capture; }

    @Override public boolean onCreate() {
        Application app = (Application) getContext().getApplicationContext();
        if ((app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) app.registerActivityLifecycleCallbacks(this);
        return true;
    }

    private static boolean isDataMethod(String method) {
        return "capture".equals(method) || "capture-own".equals(method) || "capture-own-batch".equals(method)
                || "capture-group".equals(method) || "capture-visible".equals(method) || "capture-refs".equals(method)
                || "capture-style".equals(method) || "read-branch-geometry".equals(method) || "wake-ui".equals(method);
    }

    private static boolean isDiagnosticMethod(String method) {
        return "read-diagnostic-identity".equals(method)
                || "read-sdk-build".equals(method) || "read-tree-task".equals(method);
    }

    // Scalar snapshots only: neither transport enters the capture monitor or the UI queue.
    private Bundle readDiagnostic(String method, String arg, Bundle extras, int uid) {
        if ("read-diagnostic-identity".equals(method)) {
            Application app = (Application) getContext().getApplicationContext();
            Bundle answer = new Bundle();
            // A fresh host challenge bootstraps identity without a tree or a UI task.
            // Existing instance-bound queries remain separate and keep their guards.
            if (uid != 2000
                    || (app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0
                    || arg == null || !arg.matches("[a-f0-9]{64}")
                    || extras == null || !String.valueOf(Process.myPid()).equals(extras.getString("pid"))) {
                answer.putString("error", "Unauthorized diagnostic identity query"); return answer;
            }
            answer.putString("result", "ok");
            answer.putString("protocol", "sdk-diagnostic-identity-v1");
            answer.putString("nonce", arg);
            answer.putString("sourceSha256", BuildConfig.SDK_SOURCE_SHA256);
            answer.putString("processInstance", processInstance);
            answer.putInt("pid", Process.myPid());
            return answer;
        }
        if ("read-sdk-build".equals(method)) {
            Application app = (Application) getContext().getApplicationContext();
            Bundle answer = new Bundle();
            if (uid != 2000
                    || (app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0
                    || extras == null || !processInstance.equals(extras.getString("processInstance"))) {
                answer.putString("error", "Unauthorized SDK identity query"); return answer;
            }
            answer.putString("result", "ok");
            answer.putString("protocol", "sdk-source-v1");
            answer.putString("sourceSha256", BuildConfig.SDK_SOURCE_SHA256);
            answer.putString("processInstance", processInstance);
            answer.putInt("pid", Process.myPid());
            return answer;
        }
        if ("read-tree-task".equals(method)) {
            Application app = (Application) getContext().getApplicationContext();
            Bundle answer = new Bundle();
            if (uid != 2000
                    || (app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0
                    || extras == null || !processInstance.equals(extras.getString("processInstance"))) {
                answer.putString("error", "Unauthorized tree diagnostic query"); return answer;
            }
            TreeQueueDiagnostics.Snapshot state = treeQueueDiagnostics.read(arg, processInstance);
            if (state == null) { answer.putString("error", "Tree diagnostic unavailable"); return answer; }
            answer.putString("result", "ok");
            answer.putString("diagnostic", state.event("state"));
            return answer;
        }
        Bundle answer = new Bundle(); answer.putString("error", "Unknown diagnostic method"); return answer;
    }

    @Override public Bundle call(String method, String arg, Bundle extras) {
        // Out-of-band scalar query: capture holds the provider monitor while awaiting UI.
        // Authorization must therefore happen here, before entering that monitor.
        if (isDiagnosticMethod(method)) return readDiagnostic(method, arg, extras, Binder.getCallingUid());
        // Opt-in scalar diagnostics only; keep all authorization and dispatch on the same monitor.
        boolean timed = "open-session".equals(method) && extras != null && extras.getBoolean("sessionTiming", false);
        long entered = timed ? SystemClock.elapsedRealtimeNanos() : 0;
        synchronized (this) {
            long acquired = timed ? SystemClock.elapsedRealtimeNanos() : 0;
            Bundle answer = new Bundle();
            Application app = (Application) getContext().getApplicationContext();
            if (!(isDataMethod(method) || "open-session".equals(method) || "close-session".equals(method)) || Binder.getCallingUid() != 2000 // Android shell UID
                    || (app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
                answer.putString("error", "Unauthorized or unsupported request");
                return answer;
            }
            long dispatchStarted = timed ? SystemClock.elapsedRealtimeNanos() : 0;
            answer = dispatch(method, arg, extras);
            if (timed) {
                long finished = SystemClock.elapsedRealtimeNanos();
                answer.putInt("sessionTimingVersion", 1);
                answer.putLong("sessionLockWaitNs", acquired - entered);
                answer.putLong("sessionDispatchNs", finished - dispatchStarted);
                answer.putLong("sessionCallNs", finished - entered);
            }
            return answer;
        }
    }

    /** Runs one provider request on the same monitor as binder calls, for both transports. */
    private synchronized Bundle dispatch(String method, String arg, Bundle extras) {
        boolean enabled = extras != null && extras.getBoolean("treeQueueDiagnostics", false);
        TreeQueueDiagnostics.Task task = null;
        if (enabled) {
            boolean classic = "capture".equals(method);
            boolean merged = "capture-visible".equals(method) && extras.getBoolean("withTree", false);
            if (!(classic || merged) || !processInstance.equals(extras.getString("processInstance"))) {
                Bundle answer = new Bundle(); answer.putString("error", "Invalid tree diagnostic identity"); return answer;
            }
            try { task = treeQueueDiagnostics.begin(arg, classic ? "classic" : "merged", Process.myPid(), processInstance); }
            catch (RuntimeException error) {
                Bundle answer = new Bundle(); answer.putString("error", error.getMessage()); return answer;
            }
            treeQueueTask.set(task);
        }
        try { return dispatchWork(method, arg, extras); }
        finally { if (task != null) { task.settle(); treeQueueTask.remove(); } }
    }

    private Bundle dispatchWork(String method, String arg, Bundle extras) {
        Bundle answer = new Bundle();
        Application app = (Application) getContext().getApplicationContext();
        if (Build.VERSION.SDK_INT < 26 && !"capture".equals(method) && !"capture-style".equals(method)
                && !"open-session".equals(method) && !"close-session".equals(method)) {
            answer.putString("error", "Own View capture requires Android 8 or later");
            return answer;
        }
        if ("open-session".equals(method)) {
            if (extras == null || !extras.getBoolean("sessionTiming", false)) return openSession(app);
            long started = SystemClock.elapsedRealtimeNanos();
            Bundle opened = openSession(app);
            opened.putLong("sessionOpenNs", SystemClock.elapsedRealtimeNanos() - started);
            return opened;
        }
        if ("close-session".equals(method)) return closeSession();
        if ("wake-ui".equals(method)) {
            // Never wait for this runnable: the debugger may already be stopped
            // at MessageQueue.next. No live View reads, drawing or layout changes.
            if (arg == null || !arg.matches("[0-9a-f]{16}") || extras == null
                    || !processInstance.equals(extras.getString("processInstance"))) {
                answer.putString("error", "Invalid wake identity");
                return answer;
            }
            if (!new Handler(Looper.getMainLooper()).post(() -> {})) {
                answer.putString("error", "Main queue unavailable");
                return answer;
            }
            answer.putString("result", "ok");
            answer.putString("nonce", arg);
            answer.putString("processInstance", processInstance);
            answer.putInt("pid", Process.myPid());
            return answer;
        }
        if ("capture-own".equals(method)) return capture.captureOwn(app, arg);
        if ("capture-own-batch".equals(method)) return capture.captureOwnBatch(app, arg);
        if ("capture-group".equals(method)) return capture.captureView(app, arg, "inspector-group-image.png", 20_000_000, 4_000_000, true);
        if ("capture-visible".equals(method)) return capture.captureVisible(app, arg, extras);
        if ("capture-refs".equals(method)) return capture.captureRefs(app, arg, extras);
        if ("capture-style".equals(method)) return capture.captureStyle(arg);
        if ("read-branch-geometry".equals(method)) return capture.readBranchGeometry(app, arg, extras);
        String treeRequest = arg != null && arg.matches("[0-9a-fA-F-]{36}") ? arg : "legacy";
        android.util.Log.d("InspectorTree", "request=" + treeRequest + " pid=" + Process.myPid()
                + " started=" + SystemClock.elapsedRealtime());
        try {
            capture.writeTreeFile(app, FILE_NAME);
            answer.putString("result", "ok");
        } catch (Exception error) {
            answer.putString("error", error.getMessage());
        } finally {
            android.util.Log.d("InspectorTree", "request=" + treeRequest + " settled=" + SystemClock.elapsedRealtime());
        }
        return answer;
    }

    /** Experimental: opens a debug-only local session so the desktop can reach the same handlers without a `content` CLI process per request. */
    private Bundle openSession(Application app) {
        Bundle answer = new Bundle();
        try {
            HierarchySession current = session;
            if (current == null) {
                current = new HierarchySession(app, this);
                session = current;
            }
            current.touch();
            answer.putString("result", "ok");
            answer.putString("socket", app.getPackageName() + HierarchySession.SUFFIX);
        } catch (Exception error) {
            answer.putString("error", String.valueOf(error));
        }
        return answer;
    }

    private Bundle closeSession() {
        HierarchySession current = session;
        session = null;
        if (current != null) current.close();
        Bundle answer = new Bundle();
        answer.putString("result", "ok");
        return answer;
    }

    /** Only the authenticated session transport calls this; diagnostics stay outside the capture monitor. */
    Bundle dispatchSession(String method, String arg, Bundle extras, int uid, OutputStream output) {
        Bundle answer;
        if (isDiagnosticMethod(method)) {
            answer = readDiagnostic(method, arg, extras, uid);
        } else if (isDataMethod(method)) {
            if ("capture-visible".equals(method) && extras.getBoolean("withTree", false)
                    && extras.getBoolean("treeReadyEvents", false)) treeReadyOutput.set(output);
            try { answer = dispatch(method, arg, extras); }
            finally { treeReadyOutput.remove(); }
        } else {
            answer = new Bundle();
            answer.putString("error", "Unknown session method");
        }
        return answer;
    }

    private void notifyTreeReady(String nonce) {
        OutputStream output = treeReadyOutput.get();
        if (output == null) return; // content CLI and old clients keep the existing final reply.
        try {
            JSONObject event = new JSONObject().put("event", "tree-ready").put("nonce", nonce)
                    .put("processInstance", processInstance).put("pid", Process.myPid());
            output.write(("Event: " + event + "\n").getBytes(StandardCharsets.UTF_8));
            output.flush();
        } catch (Exception error) {
            // Optional progress cannot turn an already published tree into a failed capture.
            Log.w("InspectorSession", "tree notification unavailable: " + error);
        }
    }

    @Override public void onActivityResumed(Activity activity) { resumed = new WeakReference<>(activity); }

    @Override public void onActivityPaused(Activity activity) {
        if (resumed.get() == activity) resumed = new WeakReference<>(null);
    }

    @Override public void onActivityDestroyed(Activity activity) { onActivityPaused(activity); }

    @Override public void onActivityCreated(Activity activity, Bundle state) {}

    @Override public void onActivityStarted(Activity activity) {}

    @Override public void onActivityStopped(Activity activity) {}

    @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) {}

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) { return null; }

    @Override public String getType(Uri uri) { return null; }

    @Override public Uri insert(Uri uri, ContentValues values) { return null; }

    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }

    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
}

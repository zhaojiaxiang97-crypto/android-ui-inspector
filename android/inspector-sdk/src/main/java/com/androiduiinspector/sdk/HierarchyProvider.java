package com.androiduiinspector.sdk;

import android.app.Activity;
import android.app.Application;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Debug-only, DUMP-protected shell request to export a live View tree without opening a port. */
public final class HierarchyProvider extends ContentProvider implements Application.ActivityLifecycleCallbacks {
    private static final int MAX_NODES = 5000;
    private static final int MAX_DEPTH = 150;
    private static final String FILE_NAME = "inspector-hierarchy.json";
    private final String processInstance = UUID.randomUUID().toString();
    private volatile WeakReference<Activity> resumed = new WeakReference<>(null);

    @Override public boolean onCreate() {
        Application app = (Application) getContext().getApplicationContext();
        if ((app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) app.registerActivityLifecycleCallbacks(this);
        return true;
    }

    @Override public synchronized Bundle call(String method, String arg, Bundle extras) {
        Bundle answer = new Bundle();
        Application app = (Application) getContext().getApplicationContext();
        if (!("capture".equals(method) || "capture-own".equals(method)) || Binder.getCallingUid() != 2000 // Android shell UID
                || (app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            answer.putString("error", "Unauthorized or unsupported request");
            return answer;
        }
        if ("capture-own".equals(method)) return captureOwn(app, arg);
        AtomicReference<String> data = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Activity activity = resumed.get();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                if (!root.isAttachedToWindow()) throw new IllegalStateException("Window is detached");
                data.set(captureTree(app, root).toString());
            } catch (Throwable error) {
                failure.set(error);
            } finally {
                ready.countDown();
            }
        });
        try {
            if (!ready.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("View tree timed out");
            if (failure.get() != null) throw new IllegalStateException(failure.get().toString());
            byte[] bytes = data.get().getBytes(StandardCharsets.UTF_8);
            if (bytes.length > 4_000_000) throw new IllegalStateException("View tree exceeds 4 MB");
            File file = new File(app.getNoBackupFilesDir(), FILE_NAME);
            File pending = new File(app.getNoBackupFilesDir(), FILE_NAME + ".tmp");
            try (FileOutputStream stream = new FileOutputStream(pending)) {
                stream.write(bytes);
            }
            if (!pending.renameTo(file)) throw new IllegalStateException("Could not publish View tree");
            answer.putString("result", "ok");
        } catch (Exception error) {
            answer.putString("error", error.getMessage());
        }
        return answer;
    }

    private Bundle captureOwn(Application app, String wanted) {
        Bundle answer = new Bundle();
        if (wanted == null || wanted.length() > 256 || !wanted.matches("[\\w.$]+@[0-9a-f]{1,8}")) {
            answer.putString("error", "Invalid View identity");
            return answer;
        }
        CompletableFuture<Bitmap> image = new CompletableFuture<>();
        boolean posted = new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Activity activity = resumed.get();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                if (!root.isAttachedToWindow()) throw new IllegalStateException("Window is detached");
                View target = findUnique(root, wanted);
                if (target == null || !target.isShown()) throw new IllegalStateException("View is missing or not shown");
                image.complete(IsolatedCapture.own(target));
            } catch (Throwable error) {
                image.completeExceptionally(error);
            }
        });
        if (!posted) {
            answer.putString("error", "UI thread is unavailable");
            return answer;
        }
        Bitmap bitmap = null;
        try {
            try {
                bitmap = image.get(3, TimeUnit.SECONDS);
            } catch (java.util.concurrent.TimeoutException error) {
                image.thenAccept(Bitmap::recycle);
                throw new IllegalStateException("View image timed out", error);
            }
            File file = new File(app.getNoBackupFilesDir(), "inspector-own-image.png");
            File pending = new File(app.getNoBackupFilesDir(), "inspector-own-image.png.tmp");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try {
                try (DigestOutputStream stream = new DigestOutputStream(new FileOutputStream(pending), digest)) {
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw new IllegalStateException("PNG encode failed");
                }
                if (pending.length() > 20_000_000 || !pending.renameTo(file)) throw new IllegalStateException("View image could not be published");
            } finally {
                pending.delete();
            }
            answer.putString("result", "ok");
            answer.putString("ref", wanted);
            answer.putString("processInstance", processInstance);
            StringBuilder sha256 = new StringBuilder(64);
            for (byte value : digest.digest()) sha256.append(String.format("%02x", value & 0xff));
            answer.putString("sha256", sha256.toString());
            answer.putInt("width", bitmap.getWidth());
            answer.putInt("height", bitmap.getHeight());
        } catch (Exception error) {
            Throwable cause = error.getCause() != null ? error.getCause() : error;
            answer.putString("error", cause.toString());
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
        return answer;
    }

    private static View findUnique(View root, String wanted) {
        ArrayDeque<View> queue = new ArrayDeque<>();
        queue.add(root);
        View found = null;
        int count = 0;
        while (!queue.isEmpty()) {
            if (++count > MAX_NODES) throw new IllegalStateException("View tree exceeds node budget");
            View view = queue.removeFirst();
            if (wanted.equals(ref(view))) {
                if (found != null) throw new IllegalStateException("View identity collision");
                found = view;
            }
            if (view instanceof ViewGroup) {
                ViewGroup group = (ViewGroup) view;
                for (int i = 0; i < group.getChildCount(); i++) queue.addLast(group.getChildAt(i));
            }
        }
        return found;
    }

    private JSONObject captureTree(Application app, View root) throws JSONException {
        JSONObject report = new JSONObject();
        report.put("version", 1);
        report.put("packageName", app.getPackageName());
        report.put("pid", Process.myPid());
        report.put("processInstance", processInstance);
        report.put("capturedAtMillis", System.currentTimeMillis());
        JSONObject first = node(root);
        report.put("root", first);
        ArrayDeque<Frame> queue = new ArrayDeque<>();
        queue.add(new Frame(root, first, 0));
        HashSet<String> refs = new HashSet<>();
        JSONObject classHierarchy = new JSONObject();
        int count = 0;
        long started = SystemClock.uptimeMillis();
        while (!queue.isEmpty()) {
            Frame frame = queue.removeFirst();
            // ponytail: synchronous main-thread probe; split into frame-sized batches if large apps exceed this cap.
            if (++count > MAX_NODES) throw new IllegalStateException("View tree exceeds node budget");
            if (frame.depth > MAX_DEPTH) throw new IllegalStateException("View tree exceeds depth budget");
            if (SystemClock.uptimeMillis() - started > 1000) throw new IllegalStateException("View tree exceeds 1000 ms time budget");
            String ref = ref(frame.view);
            if (!refs.add(ref)) throw new IllegalStateException("View identity collision");
            Class<?> viewClass = frame.view.getClass();
            if (!classHierarchy.has(viewClass.getName())) {
                JSONArray ancestors = new JSONArray();
                for (Class<?> type = viewClass; type != null && View.class.isAssignableFrom(type); type = type.getSuperclass())
                    ancestors.put(type.getName());
                classHierarchy.put(viewClass.getName(), ancestors);
            }
            JSONArray children = new JSONArray();
            frame.json.put("children", children);
            if (!(frame.view instanceof ViewGroup)) continue;
            ViewGroup group = (ViewGroup) frame.view;
            for (int i = 0; i < group.getChildCount(); i++) {
                View child = group.getChildAt(i);
                JSONObject item = node(child);
                children.put(item);
                queue.addLast(new Frame(child, item, frame.depth + 1));
            }
        }
        report.put("nodeCount", count);
        report.put("classHierarchy", classHierarchy);
        return report;
    }

    private static JSONObject node(View view) throws JSONException {
        JSONObject item = new JSONObject();
        item.put("ref", ref(view));
        item.put("className", view.getClass().getName());
        item.put("width", view.getWidth());
        item.put("height", view.getHeight());
        int[] location = new int[2];
        view.getLocationOnScreen(location);
        item.put("screenX", location[0]);
        item.put("screenY", location[1]);
        item.put("visible", view.getVisibility() == View.VISIBLE);
        item.put("clickable", view.isClickable());
        item.put("longClickable", view.isLongClickable());
        item.put("contextClickable", view.isContextClickable());
        item.put("hasOnClickListeners", view.hasOnClickListeners());
        item.put("enabled", view.isEnabled());
        item.put("focusable", view.isFocusable());
        item.put("focused", view.isFocused());
        item.put("selected", view.isSelected());
        item.put("pressed", view.isPressed());
        item.put("activated", view.isActivated());
        item.put("scrollable", view.isScrollContainer());
        item.put("alpha", view.getAlpha());
        item.put("elevation", view.getElevation());
        item.put("paddingLeft", view.getPaddingLeft());
        item.put("paddingTop", view.getPaddingTop());
        item.put("paddingRight", view.getPaddingRight());
        item.put("paddingBottom", view.getPaddingBottom());
        Object debugName = view.getTag(R.id.inspector_debug_name);
        if (debugName instanceof String) item.put("debugName", debugName);
        ViewGroup.LayoutParams params = view.getLayoutParams();
        if (params != null) {
            item.put("layoutParamsClass", params.getClass().getName());
            item.put("layoutWidth", params.width);
            item.put("layoutHeight", params.height);
            if (params instanceof FrameLayout.LayoutParams) item.put("layoutGravity", ((FrameLayout.LayoutParams) params).gravity);
            if (params instanceof LinearLayout.LayoutParams) {
                LinearLayout.LayoutParams linear = (LinearLayout.LayoutParams) params;
                item.put("layoutGravity", linear.gravity);
                item.put("layoutWeight", linear.weight);
            }
            if (params instanceof ViewGroup.MarginLayoutParams) {
                ViewGroup.MarginLayoutParams margins = (ViewGroup.MarginLayoutParams) params;
                item.put("marginLeft", margins.leftMargin);
                item.put("marginTop", margins.topMargin);
                item.put("marginRight", margins.rightMargin);
                item.put("marginBottom", margins.bottomMargin);
            }
        }
        if (view.getId() != View.NO_ID) {
            try { item.put("resourceId", view.getResources().getResourceName(view.getId())); }
            catch (android.content.res.Resources.NotFoundException ignored) { item.put("resourceId", Integer.toHexString(view.getId())); }
        }
        CharSequence desc = view.getContentDescription();
        if (desc != null) item.put("contentDesc", bounded(desc));
        if (view instanceof TextView) item.put("text", bounded(((TextView) view).getText()));
        return item;
    }

    private static String bounded(CharSequence value) {
        String text = value.toString();
        return text.length() <= 512 ? text : text.substring(0, 512);
    }

    private static String ref(View view) {
        return view.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(view));
    }

    private static final class Frame {
        final View view;
        final JSONObject json;
        final int depth;
        Frame(View view, JSONObject json, int depth) { this.view = view; this.json = json; this.depth = depth; }
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

package com.androiduiinspector.sdk;

import android.app.Activity;
import android.app.Application;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Outline;
import android.graphics.Rect;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.SurfaceView;
import android.view.TextureView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.FileOutputStream;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HashMap;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.lsposed.hiddenapibypass.HiddenApiBypass;

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
        if (!("capture".equals(method) || "capture-own".equals(method) || "capture-own-batch".equals(method) || "capture-group".equals(method) || "capture-visible".equals(method) || "capture-style".equals(method)) || Binder.getCallingUid() != 2000 // Android shell UID
                || (app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            answer.putString("error", "Unauthorized or unsupported request");
            return answer;
        }
        if (Build.VERSION.SDK_INT < 26 && !"capture".equals(method) && !"capture-style".equals(method)) {
            answer.putString("error", "Own View capture requires Android 8 or later");
            return answer;
        }
        if ("capture-own".equals(method)) return captureOwn(app, arg);
        if ("capture-own-batch".equals(method)) return captureOwnBatch(app, arg);
        if ("capture-group".equals(method)) return captureView(app, arg, "inspector-group-image.png", 20_000_000, 4_000_000, true);
        if ("capture-visible".equals(method)) return captureVisible(app, arg);
        if ("capture-style".equals(method)) return captureStyle(arg);
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
        return captureView(app, wanted, "inspector-own-image.png", 20_000_000, 4_000_000, false);
    }

    private Bundle captureStyle(String wanted) {
        Bundle answer = new Bundle();
        if (wanted == null || wanted.length() > 256 || !wanted.matches("[\\w.$]+@[0-9a-f]{1,8}")) {
            answer.putString("error", "Invalid View identity");
            return answer;
        }
        AtomicReference<Bundle> data = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        if (!new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Activity activity = resumed.get();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                if (!root.isAttachedToWindow()) throw new IllegalStateException("Window is detached");
                View target = findUnique(root, wanted);
                if (target == null) throw new IllegalStateException("View is missing");
                Bundle style = new Bundle();
                style.putString("result", "ok");
                style.putString("processInstance", processInstance);
                style.putString("rootRef", ref(root));
                style.putString("ref", wanted);
                int[] position = new int[2];
                target.getLocationOnScreen(position);
                style.putInt("x", position[0]);
                style.putInt("y", position[1]);
                style.putInt("width", target.getWidth());
                style.putInt("height", target.getHeight());
                Drawable background = target.getBackground();
                if (background != null) {
                    style.putString("backgroundType", background.getClass().getName());
                    Integer color = null;
                    if (background instanceof ColorDrawable) color = ((ColorDrawable) background).getColor();
                    else if (Build.VERSION.SDK_INT >= 24 && background instanceof GradientDrawable
                            && ((GradientDrawable) background).getColor() != null) {
                        android.content.res.ColorStateList colors = ((GradientDrawable) background).getColor();
                        color = colors.getColorForState(target.getDrawableState(), colors.getDefaultColor());
                    }
                    if (color != null) style.putString("backgroundColor", String.format(java.util.Locale.ROOT, "#%08X", color));
                }
                if (target instanceof TextView) {
                    TextView text = (TextView) target;
                    style.putString("textColor", String.format(java.util.Locale.ROOT, "#%08X", text.getCurrentTextColor()));
                    style.putFloat("textSizePx", text.getTextSize());
                }
                style.putLong("capturedAtMillis", System.currentTimeMillis());
                data.set(style);
            } catch (Throwable error) {
                failure.set(error);
            } finally {
                ready.countDown();
            }
        })) {
            answer.putString("error", "UI thread is unavailable");
            return answer;
        }
        try {
            if (!ready.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("View style timed out");
            if (failure.get() != null) throw new IllegalStateException(failure.get().toString());
            return data.get();
        } catch (Exception error) {
            answer.putString("error", error.getMessage());
            return answer;
        }
    }

    private static final class VisibleLayer {
        final View view;
        final String ref;
        final int x, y;
        VisibleLayer(View view, int x, int y) {
            this.view = view;
            this.ref = ref(view);
            this.x = x;
            this.y = y;
        }
    }

    private static boolean customDispatchDraw(Class<?> type) {
        for (Class<?> current = type; current != View.class && current != ViewGroup.class; current = current.getSuperclass()) {
            try { current.getDeclaredMethod("dispatchDraw", Canvas.class); return true; }
            catch (NoSuchMethodException ignored) { }
            catch (RuntimeException unknown) { return true; }
        }
        return false;
    }

    private Bundle captureVisible(Application app, String nonce) {
        Bundle answer = new Bundle();
        if (nonce != null && !nonce.matches("[0-9a-f]{16}")) {
            answer.putString("error", "Invalid capture nonce");
            return answer;
        }
        File file = new File(app.getNoBackupFilesDir(), "inspector-visible-layers.bin");
        File pending = new File(app.getNoBackupFilesDir(), "inspector-visible-layers.bin.tmp");
        file.delete();
        pending.delete();
        AtomicReference<ArrayList<VisibleLayer>> selected = new AtomicReference<>();
        AtomicReference<String> pureRefs = new AtomicReference<>("-");
        AtomicReference<View> selectedRoot = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Activity activity = resumed.get();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                if (!root.isAttachedToWindow()) throw new IllegalStateException("Window is detached");
                Field flags = null, overlay = null;
                for (Field field : HiddenApiBypass.getInstanceFields(View.class)) {
                    if ("mPrivateFlags".equals(field.getName())) flags = field;
                    if ("mOverlay".equals(field.getName())) overlay = field;
                }
                if (flags == null) throw new IllegalStateException("View draw flags unavailable");
                flags.setAccessible(true);
                try { if (overlay != null) overlay.setAccessible(true); }
                catch (RuntimeException unavailable) { overlay = null; }
                ArrayList<VisibleLayer> result = new ArrayList<>();
                StringBuilder pure = new StringBuilder();
                HashMap<Class<?>, Boolean> customDraw = new HashMap<>();
                ArrayDeque<View> queue = new ArrayDeque<>();
                queue.add(root);
                int visited = 0;
                while (!queue.isEmpty()) {
                    if (++visited > MAX_NODES) throw new IllegalStateException("View tree exceeds node budget");
                    View view = queue.removeFirst();
                    if (view.getVisibility() != View.VISIBLE || view.getAlpha() <= 0) continue;
                    int[] position = new int[2];
                    view.getLocationOnScreen(position);
                    int width = view.getWidth(), height = view.getHeight();
                    if (width > 0 && height > 0) {
                        if ((flags.getInt(view) & 0x80) == 0) {
                            if ((long) width * height <= 4_000_000) result.add(new VisibleLayer(view, position[0], position[1]));
                        } else if (overlay != null && !(view instanceof SurfaceView) && !(view instanceof TextureView)
                                && !customDraw.computeIfAbsent(view.getClass(), HierarchyProvider::customDispatchDraw)) {
                            try {
                                if (overlay.get(view) == null) {
                                    String identity = ref(view);
                                    // ponytail: bounded hint list; omitted refs use the existing JDWP fallback.
                                    if (identity.length() <= 256 && pure.length() + identity.length() + 1 <= 16_000) {
                                        if (pure.length() > 0) pure.append(';');
                                        pure.append(identity);
                                    }
                                }
                            } catch (IllegalAccessException ignored) { }
                        }
                    }
                    if (view instanceof ViewGroup) {
                        ViewGroup group = (ViewGroup) view;
                        for (int i = 0; i < group.getChildCount(); i++) queue.addLast(group.getChildAt(i));
                    }
                }
                selectedRoot.set(root);
                selected.set(result);
                pureRefs.set(pure.length() == 0 ? "-" : pure.toString());
            } catch (Throwable error) {
                failure.set(error);
            } finally {
                ready.countDown();
            }
        });
        long started = SystemClock.uptimeMillis();
        try {
            if (!ready.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("View selection timed out");
            if (failure.get() != null) throw new IllegalStateException(failure.get().toString());
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            int count = 0, empty = 0;
            StringBuilder specialRefs = new StringBuilder();
            long renderMs = 0, encodeMs = 0;
            try (DataOutputStream output = new DataOutputStream(new DigestOutputStream(new FileOutputStream(pending), digest))) {
                output.writeLong(nonce == null ? 0 : Long.parseUnsignedLong(nonce, 16)); // Request identity in the DDMS header.
                Class<?> debug = Class.forName("android.view.ViewDebug");
                for (VisibleLayer layer : selected.get()) {
                    if (SystemClock.uptimeMillis() - started > 60_000) throw new IllegalStateException("Visible capture time budget exceeded");
                    char special = layer.view instanceof SurfaceView ? 'S' : layer.view instanceof TextureView ? 'T' : '-';
                    if (special != '-') {
                        if (specialRefs.length() > 6000) throw new IllegalStateException("Too many special Views");
                        if (specialRefs.length() > 0) specialRefs.append(';');
                        specialRefs.append(special).append(':').append(layer.ref);
                    }
                    long imageStarted = SystemClock.uptimeMillis();
                    Bitmap bitmap = (Bitmap) HiddenApiBypass.invoke(debug, null, "performViewCapture", layer.view, true);
                    renderMs += SystemClock.uptimeMillis() - imageStarted;
                    if (bitmap == null) {
                        empty++; continue;
                    }
                    try {
                        ByteArrayOutputStream png = new ByteArrayOutputStream();
                        imageStarted = SystemClock.uptimeMillis();
                        if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, png) || png.size() > 10_000_000)
                            throw new IllegalStateException("View PNG exceeds capture budget");
                        encodeMs += SystemClock.uptimeMillis() - imageStarted;
                        output.writeByte(1);
                        output.writeUTF(layer.ref);
                        output.writeByte(1);
                        output.writeInt(layer.x);
                        output.writeInt(layer.y);
                        output.writeInt(png.size());
                        png.writeTo(output);
                        count++;
                    } finally {
                        bitmap.recycle();
                    }
                }
                output.writeByte(2);
            }
            if (selectedRoot.get() != resumed.get().getWindow().getDecorView() || !selectedRoot.get().isAttachedToWindow()
                    || pending.length() > 64_000_000 || !pending.renameTo(file)) throw new IllegalStateException("Activity changed during visible capture");
            answer.putString("result", "ok");
            if (nonce != null) answer.putString("nonce", nonce);
            answer.putString("processInstance", processInstance);
            answer.putString("rootRef", ref(selectedRoot.get()));
            answer.putInt("count", count);
            answer.putInt("selected", selected.get().size());
            answer.putInt("empty", empty);
            answer.putString("specialRefs", specialRefs.length() == 0 ? "-" : specialRefs.toString());
            answer.putString("pureRefs", pureRefs.get());
            answer.putLong("renderMs", renderMs);
            answer.putLong("encodeMs", encodeMs);
            answer.putLong("durationMs", SystemClock.uptimeMillis() - started);
            answer.putLong("bytes", file.length());
            StringBuilder sha256 = new StringBuilder(64);
            for (byte value : digest.digest()) sha256.append(String.format("%02x", value & 0xff));
            answer.putString("sha256", sha256.toString());
        } catch (Throwable error) {
            file.delete();
            answer.putString("error", error.toString());
        } finally {
            pending.delete();
        }
        return answer;
    }

    private Bundle captureOwn(Application app, String wanted, String fileName, int byteLimit, int pixelLimit) {
        return captureView(app, wanted, fileName, byteLimit, pixelLimit, false);
    }

    private Bundle captureView(Application app, String wanted, String fileName, int byteLimit, int pixelLimit, boolean group) {
        Bundle answer = new Bundle();
        if (wanted == null || wanted.length() > 256 || !wanted.matches("[\\w.$]+@[0-9a-f]{1,8}")) {
            answer.putString("error", "Invalid View identity");
            return answer;
        }
        CompletableFuture<Bitmap> image = new CompletableFuture<>();
        AtomicReference<String> rootRef = new AtomicReference<>();
        boolean posted = new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Activity activity = resumed.get();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                if (!root.isAttachedToWindow()) throw new IllegalStateException("Window is detached");
                rootRef.set(ref(root));
                View target = findUnique(root, wanted);
                if (target == null || !target.isShown()) throw new IllegalStateException("View is missing or not shown");
                if ((long) target.getWidth() * target.getHeight() > pixelLimit) throw new IllegalStateException("View exceeds capture pixel budget");
                image.complete(group ? IsolatedCapture.group(target) : IsolatedCapture.own(target));
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
            File file = new File(app.getNoBackupFilesDir(), fileName);
            File pending = new File(app.getNoBackupFilesDir(), fileName + ".tmp");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try {
                try (DigestOutputStream stream = new DigestOutputStream(new FileOutputStream(pending), digest)) {
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw new IllegalStateException("PNG encode failed");
                }
                if (pending.length() > byteLimit || !pending.renameTo(file)) throw new IllegalStateException("View image could not be published");
            } finally {
                pending.delete();
            }
            answer.putString("result", "ok");
            answer.putString("ref", wanted);
            answer.putString("processInstance", processInstance);
            answer.putString("rootRef", rootRef.get());
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

    private Bundle captureOwnBatch(Application app, String arg) {
        // ponytail: cap each batch at 2 million pixels; revisit only after real-page memory checks.
        Bundle answer = new Bundle();
        if (arg == null || arg.length() > 2600) {
            answer.putString("error", "Invalid batch request");
            return answer;
        }
        String[] refs = arg.split(",", -1);
        HashSet<String> unique = new HashSet<>();
        if (refs.length < 1 || refs.length > 10) {
            answer.putString("error", "Batch supports 1–10 Views");
            return answer;
        }
        for (String ref : refs) {
            if (ref.length() > 256 || !ref.matches("[\\w.$]+@[0-9a-f]{1,8}") || !unique.add(ref)) {
                answer.putString("error", "Invalid or duplicate View identity");
                return answer;
            }
        }
        File directory = app.getNoBackupFilesDir();
        File manifest = new File(directory, "inspector-own-batch.json");
        File pending = new File(directory, "inspector-own-batch.json.tmp");
        boolean complete = false;
        try {
            manifest.delete();
            JSONArray images = new JSONArray();
            long started = SystemClock.uptimeMillis();
            int pixels = 0;
            String rootRef = null;
            for (int index = 0; index < refs.length; index++) {
                if (SystemClock.uptimeMillis() - started > 5000) throw new IllegalStateException("Batch time budget exceeded");
                String name = "inspector-own-batch-" + index + ".png";
                Bundle one = captureOwn(app, refs[index], name, 1_000_000, Math.min(1_000_000, 2_000_000 - pixels));
                if (!"ok".equals(one.getString("result"))) throw new IllegalStateException(one.getString("error", "View capture failed"));
                if (rootRef != null && !rootRef.equals(one.getString("rootRef"))) throw new IllegalStateException("Activity root changed during batch");
                rootRef = one.getString("rootRef");
                pixels += one.getInt("width") * one.getInt("height");
                if (SystemClock.uptimeMillis() - started > 5000) throw new IllegalStateException("Batch time budget exceeded");
                JSONObject item = new JSONObject();
                item.put("ref", refs[index]);
                item.put("file", name);
                item.put("sha256", one.getString("sha256"));
                item.put("width", one.getInt("width"));
                item.put("height", one.getInt("height"));
                images.put(item);
            }
            JSONObject report = new JSONObject();
            report.put("version", 1);
            report.put("processInstance", processInstance);
            report.put("rootRef", rootRef);
            report.put("capturedAtMillis", System.currentTimeMillis());
            report.put("images", images);
            byte[] bytes = report.toString().getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream stream = new FileOutputStream(pending)) {
                stream.write(bytes);
            }
            if (!pending.renameTo(manifest)) throw new IllegalStateException("Batch manifest could not be published");
            answer.putInt("count", refs.length);
            answer.putString("processInstance", processInstance);
            answer.putString("rootRef", rootRef);
            StringBuilder sha256 = new StringBuilder(64);
            for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) sha256.append(String.format("%02x", value & 0xff));
            answer.putString("sha256", sha256.toString());
            answer.putString("result", "ok");
            complete = true;
        } catch (Exception error) {
            answer.putString("error", error.getMessage());
        } finally {
            pending.delete();
            if (!complete) manifest.delete();
            for (int index = complete ? refs.length : 0; index < 10; index++) new File(directory, "inspector-own-batch-" + index + ".png").delete();
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
        report.put("visibleStreamVersion", 1);
        report.put("styleVersion", 1);
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
        if (Build.VERSION.SDK_INT >= 23) item.put("contextClickable", view.isContextClickable());
        item.put("hasOnClickListeners", view.hasOnClickListeners());
        item.put("enabled", view.isEnabled());
        item.put("focusable", view.isFocusable());
        item.put("focused", view.isFocused());
        item.put("selected", view.isSelected());
        item.put("pressed", view.isPressed());
        item.put("activated", view.isActivated());
        item.put("scrollable", view.isScrollContainer());
        item.put("alpha", view.getAlpha());
        if (view.getClipToOutline()) {
            item.put("clipToOutline", true);
            Outline outline = new Outline();
            try {
                if (view.getOutlineProvider() != null) view.getOutlineProvider().getOutline(view, outline);
            } catch (RuntimeException ignored) {
                // The tree remains available; the desktop must not synthesize an unknown outline.
            }
            Rect rect = new Rect();
            if (outline.canClip() && outline.getRect(rect)) {
                item.put("outlineLeft", rect.left);
                item.put("outlineTop", rect.top);
                item.put("outlineRight", rect.right);
                item.put("outlineBottom", rect.bottom);
                item.put("outlineRadius", outline.getRadius());
            }
        }
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

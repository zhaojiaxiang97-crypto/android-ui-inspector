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
import android.net.Credentials;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.SurfaceView;
import android.view.TextureView;
import android.view.PixelCopy;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.RelativeLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Iterator;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.CRC32;
import org.lsposed.hiddenapibypass.HiddenApiBypass;

/** Debug-only, DUMP-protected shell request to export a live View tree without opening a port. */
public final class HierarchyProvider extends ContentProvider implements Application.ActivityLifecycleCallbacks {
    private static final int MAX_NODES = 5000;
    private static final int MAX_DEPTH = 150;
    private static final String FILE_NAME = "inspector-hierarchy.json";
    private static final int[] RELATIVE_RULES = {
            RelativeLayout.LEFT_OF, RelativeLayout.RIGHT_OF, RelativeLayout.ABOVE, RelativeLayout.BELOW,
            RelativeLayout.ALIGN_BASELINE, RelativeLayout.ALIGN_LEFT, RelativeLayout.ALIGN_TOP,
            RelativeLayout.ALIGN_RIGHT, RelativeLayout.ALIGN_BOTTOM, RelativeLayout.ALIGN_PARENT_LEFT,
            RelativeLayout.ALIGN_PARENT_TOP, RelativeLayout.ALIGN_PARENT_RIGHT, RelativeLayout.ALIGN_PARENT_BOTTOM,
            RelativeLayout.CENTER_IN_PARENT, RelativeLayout.CENTER_HORIZONTAL, RelativeLayout.CENTER_VERTICAL,
            RelativeLayout.START_OF, RelativeLayout.END_OF, RelativeLayout.ALIGN_START, RelativeLayout.ALIGN_END,
            RelativeLayout.ALIGN_PARENT_START, RelativeLayout.ALIGN_PARENT_END
    };
    private static final String[] RELATIVE_RULE_NAMES = {
            "leftOf", "rightOf", "above", "below", "alignBaseline", "alignLeft", "alignTop",
            "alignRight", "alignBottom", "alignParentLeft", "alignParentTop", "alignParentRight",
            "alignParentBottom", "centerInParent", "centerHorizontal", "centerVertical", "startOf",
            "endOf", "alignStart", "alignEnd", "alignParentStart", "alignParentEnd"
    };
    private static final String[] CONSTRAINT_ANCHORS = {
            "leftToLeft", "leftToRight", "rightToLeft", "rightToRight", "startToStart", "startToEnd",
            "endToStart", "endToEnd", "topToTop", "topToBottom", "bottomToTop", "bottomToBottom",
            "baselineToBaseline", "baselineToTop", "baselineToBottom", "circleConstraint"
    };
    private static final HashMap<Class<?>, HashMap<String, Field>> CONSTRAINT_FIELDS = new HashMap<>();
    private final String processInstance = UUID.randomUUID().toString();
    private volatile WeakReference<Activity> resumed = new WeakReference<>(null);
    private static final String SESSION_SUFFIX = ".inspector.session";
    private volatile Session session;

    @Override public boolean onCreate() {
        Application app = (Application) getContext().getApplicationContext();
        if ((app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) app.registerActivityLifecycleCallbacks(this);
        return true;
    }

    private static boolean isDataMethod(String method) {
        return "capture".equals(method) || "capture-own".equals(method) || "capture-own-batch".equals(method)
                || "capture-group".equals(method) || "capture-visible".equals(method) || "capture-refs".equals(method)
                || "capture-style".equals(method);
    }

    @Override public synchronized Bundle call(String method, String arg, Bundle extras) {
        Bundle answer = new Bundle();
        Application app = (Application) getContext().getApplicationContext();
        if (!(isDataMethod(method) || "open-session".equals(method) || "close-session".equals(method)) || Binder.getCallingUid() != 2000 // Android shell UID
                || (app.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            answer.putString("error", "Unauthorized or unsupported request");
            return answer;
        }
        return dispatch(method, arg, extras);
    }

    /** Runs one provider request on the same monitor as binder calls, for both transports. */
    private synchronized Bundle dispatch(String method, String arg, Bundle extras) {
        Bundle answer = new Bundle();
        Application app = (Application) getContext().getApplicationContext();
        if (Build.VERSION.SDK_INT < 26 && !"capture".equals(method) && !"capture-style".equals(method)
                && !"open-session".equals(method) && !"close-session".equals(method)) {
            answer.putString("error", "Own View capture requires Android 8 or later");
            return answer;
        }
        if ("open-session".equals(method)) return openSession(app);
        if ("close-session".equals(method)) return closeSession();
        if ("capture-own".equals(method)) return captureOwn(app, arg);
        if ("capture-own-batch".equals(method)) return captureOwnBatch(app, arg);
        if ("capture-group".equals(method)) return captureView(app, arg, "inspector-group-image.png", 20_000_000, 4_000_000, true);
        if ("capture-visible".equals(method)) return captureVisible(app, arg, extras);
        if ("capture-refs".equals(method)) return captureRefs(app, arg, extras);
        if ("capture-style".equals(method)) return captureStyle(arg);
        try {
            writeTreeFile(app, FILE_NAME);
            answer.putString("result", "ok");
        } catch (Exception error) {
            answer.putString("error", error.getMessage());
        }
        return answer;
    }

    /** Experimental: opens a debug-only local session so the desktop can reach the same handlers without a `content` CLI process per request. */
    private Bundle openSession(Application app) {
        Bundle answer = new Bundle();
        try {
            Session current = session;
            if (current == null) {
                current = new Session(app, this);
                session = current;
            }
            current.touch();
            answer.putString("result", "ok");
            answer.putString("socket", app.getPackageName() + SESSION_SUFFIX);
        } catch (Exception error) {
            answer.putString("error", String.valueOf(error));
        }
        return answer;
    }

    private Bundle closeSession() {
        Session current = session;
        session = null;
        if (current != null) current.close();
        Bundle answer = new Bundle();
        answer.putString("result", "ok");
        return answer;
    }

    /**
     * Experimental session channel: a local abstract socket serving the same handlers (line-delimited
     * JSON request, "Result: Bundle[...]" reply). Debug-only, shell/root peer UID required.
     */
    private static final class Session {
        private final HierarchyProvider provider;
        private final LocalServerSocket server;
        private final String name;
        private volatile boolean stopped;

        Session(Application app, HierarchyProvider provider) throws IOException {
            this.provider = provider;
            this.name = app.getPackageName() + SESSION_SUFFIX;
            this.server = new LocalServerSocket(name);
            Thread thread = new Thread(this::loop, "inspector-session");
            thread.setDaemon(true);
            thread.start();
        }

        void touch() { }

        void close() {
            stopped = true;
            // Closing the server socket does not wake a blocked accept(); a self-connection does.
            try { LocalSocket wake = new LocalSocket(); wake.connect(new LocalSocketAddress(name)); wake.close(); }
            catch (IOException ignored) { }
            try { server.close(); } catch (IOException ignored) { }
        }

        private void loop() {
            while (!stopped) {
                LocalSocket client;
                try { client = server.accept(); }
                catch (IOException closed) { return; }
                if (stopped) {
                    try { client.close(); } catch (IOException ignored) { }
                    return;
                }
                handle(client);
            }
        }

        private void handle(LocalSocket client) {
            try {
                Credentials credentials = client.getPeerCredentials();
                int uid = credentials == null ? -1 : credentials.getUid();
                Log.i("InspectorSession", "peer uid=" + uid);
                if (uid != 2000 && uid != 0) return;
                BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                OutputStream output = client.getOutputStream();
                String line;
                while ((line = reader.readLine()) != null) {
                    JSONObject request = new JSONObject(line);
                    String method = request.getString("method");
                    String arg = request.isNull("arg") ? null : request.optString("arg", null);
                    Bundle extras = new Bundle();
                    JSONObject wanted = request.optJSONObject("extras");
                    if (wanted != null) {
                        for (Iterator<String> keys = wanted.keys(); keys.hasNext(); ) {
                            String key = keys.next();
                            Object value = wanted.get(key);
                            if (value instanceof Boolean) extras.putBoolean(key, (Boolean) value);
                            else extras.putString(key, String.valueOf(value));
                        }
                    }
                    Bundle answer;
                    if (isDataMethod(method)) {
                        answer = provider.dispatch(method, arg, extras);
                    } else {
                        answer = new Bundle();
                        answer.putString("error", "Unknown session method");
                    }
                    output.write(("Result: " + answer + "\n").getBytes(StandardCharsets.UTF_8));
                    output.flush();
                }
            } catch (Exception error) {
                Log.w("InspectorSession", "request failed: " + error);
            } finally {
                try { client.close(); } catch (IOException ignored) { }
            }
        }
    }

    /** Builds the hierarchy JSON on the main thread and publishes it atomically. */
    private void writeTreeFile(Application app, String fileName) throws Exception {
        AtomicReference<JSONObject> data = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Activity activity = resumed.get();
                if (activity == null) throw new IllegalStateException("No resumed Activity");
                View root = activity.getWindow().getDecorView();
                if (!root.isAttachedToWindow()) throw new IllegalStateException("Window is detached");
                data.set(captureTree(app, root));
            } catch (Throwable error) {
                failure.set(error);
            } finally {
                ready.countDown();
            }
        });
        if (!ready.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("View tree timed out");
        if (failure.get() != null) throw new IllegalStateException(failure.get().toString());
        // ponytail: stringify off the main thread; serializing a large tree costs seconds and used to sit inside the 3 s main-thread budget.
        byte[] bytes = data.get().toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 4_000_000) throw new IllegalStateException("View tree exceeds 4 MB");
        File file = new File(app.getNoBackupFilesDir(), fileName);
        File pending = new File(app.getNoBackupFilesDir(), fileName + ".tmp");
        try (FileOutputStream stream = new FileOutputStream(pending)) {
            stream.write(bytes);
        }
        if (!pending.renameTo(file)) throw new IllegalStateException("Could not publish View tree");
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
        final boolean inViewport;
        final long visibleArea;
        VisibleLayer(View view, int x, int y, boolean inViewport, long visibleArea) {
            this.view = view;
            this.ref = ref(view);
            this.x = x;
            this.y = y;
            this.inViewport = inViewport;
            this.visibleArea = visibleArea;
        }
    }

    private static final int MAX_PIPELINE_DEPTH = 4;

    private static final class VisibleRecord {
        final String ref;
        final int x, y;
        final byte[] image;
        final int crc;
        final boolean webp;
        VisibleRecord(String ref, int x, int y, byte[] image, int crc, boolean webp) {
            this.ref = ref;
            this.x = x;
            this.y = y;
            this.image = image;
            this.crc = crc;
            this.webp = webp;
        }
    }

    private static VisibleRecord encodeVisibleLayer(Bitmap bitmap, String ref, int x, int y, boolean webpLossless, AtomicLong encodeMs) {
        long imageStarted = SystemClock.uptimeMillis();
        try {
            ByteArrayOutputStream png = new ByteArrayOutputStream();
            Bitmap.CompressFormat format = webpLossless ? Bitmap.CompressFormat.WEBP_LOSSLESS : Bitmap.CompressFormat.PNG;
            if (!bitmap.compress(format, webpLossless ? 0 : 100, png) || png.size() > 10_000_000)
                throw new IllegalStateException("View image exceeds capture budget");
            byte[] image = png.toByteArray();
            int crc = 0;
            if (webpLossless) {
                CRC32 checksum = new CRC32();
                checksum.update(image);
                crc = (int) checksum.getValue();
            }
            return new VisibleRecord(ref, x, y, image, crc, webpLossless);
        } finally {
            encodeMs.addAndGet(SystemClock.uptimeMillis() - imageStarted);
            bitmap.recycle();
        }
    }

    private static int writeVisibleRecord(DataOutputStream output, Future<VisibleRecord> future) throws Exception {
        VisibleRecord record;
        try {
            record = future.get();
        } catch (ExecutionException wrapped) {
            Throwable cause = wrapped.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw wrapped;
        }
        output.writeByte(1);
        output.writeUTF(record.ref);
        output.writeByte(1);
        output.writeInt(record.x);
        output.writeInt(record.y);
        output.writeInt(record.image.length);
        output.write(record.image);
        if (record.webp) output.writeInt(record.crc);
        return 1;
    }

    private static boolean customDispatchDraw(Class<?> type) {
        for (Class<?> current = type; current != View.class && current != ViewGroup.class; current = current.getSuperclass()) {
            try { current.getDeclaredMethod("dispatchDraw", Canvas.class); return true; }
            catch (NoSuchMethodException ignored) { }
            catch (RuntimeException unknown) { return true; }
        }
        return false;
    }

    private Bundle captureVisible(Application app, String nonce, Bundle extras) {
        Bundle answer = new Bundle();
        if (nonce != null && !nonce.matches("[0-9a-f]{16}")) {
            answer.putString("error", "Invalid capture nonce");
            return answer;
        }
        String priorityRef = extras == null ? null : extras.getString("priorityViewRef");
        if (priorityRef != null && !priorityRef.matches("[\\w.$]+@[0-9a-fA-F]{1,8}")) {
            answer.putString("error", "Invalid priority View identity");
            return answer;
        }
        // Merged capture: write the hierarchy first so the desktop can adopt it while the
        // layers render; the layer request itself is unchanged and independent of the tree.
        if (extras != null && extras.getBoolean("withTree", false) && nonce != null) {
            try {
                writeTreeFile(app, "inspector-tree-" + nonce + ".json");
                answer.putString("tree", "ok");
            } catch (Exception error) {
                // The layer capture below is independent; the desktop falls back to the classic fetch.
                answer.putString("tree", "failed");
            }
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
                            if ((long) width * height <= 4_000_000) {
                                Rect visibleRect = new Rect();
                                boolean inViewport = view.getGlobalVisibleRect(visibleRect);
                                long visibleArea = inViewport ? (long) visibleRect.width() * visibleRect.height() : 0;
                                result.add(new VisibleLayer(view, position[0], position[1], inViewport, visibleArea));
                            }
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
                Collections.sort(result, (left, right) -> {
                    boolean leftSelected = priorityRef != null && priorityRef.equals(left.ref);
                    boolean rightSelected = priorityRef != null && priorityRef.equals(right.ref);
                    if (leftSelected != rightSelected) return leftSelected ? -1 : 1;
                    if (left.inViewport != right.inViewport) return left.inViewport ? -1 : 1;
                    return left.inViewport ? Long.compare(left.visibleArea, right.visibleArea) : 0;
                });
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
        ExecutorService encoders = null;
        try {
            if (!ready.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("View selection timed out");
            if (failure.get() != null) throw new IllegalStateException(failure.get().toString());
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            int count = 0, empty = 0;
            StringBuilder specialRefs = new StringBuilder();
            long renderMs = 0;
            AtomicLong encodeMs = new AtomicLong();
            boolean webpLossless = Build.VERSION.SDK_INT >= 30;
            // ponytail: render and encode used to run back-to-back in one loop; a bounded two-worker
            // pipeline now overlaps WEBP/PNG compression with the next View capture, while the ordered
            // writer keeps the streaming file and its digest identical to the serial loop.
            encoders = Executors.newFixedThreadPool(2, runnable -> {
                Thread thread = new Thread(runnable, "inspector-encode");
                thread.setDaemon(true);
                return thread;
            });
            ArrayDeque<Future<VisibleRecord>> inFlight = new ArrayDeque<>();
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
                    while (inFlight.size() >= MAX_PIPELINE_DEPTH) count += writeVisibleRecord(output, inFlight.pollFirst());
                    inFlight.addLast(encoders.submit(() -> encodeVisibleLayer(bitmap, layer.ref, layer.x, layer.y, webpLossless, encodeMs)));
                }
                while (!inFlight.isEmpty()) count += writeVisibleRecord(output, inFlight.pollFirst());
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
            answer.putLong("encodeMs", encodeMs.get());
            answer.putLong("durationMs", SystemClock.uptimeMillis() - started);
            answer.putLong("bytes", file.length());
            StringBuilder sha256 = new StringBuilder(64);
            for (byte value : digest.digest()) sha256.append(String.format("%02x", value & 0xff));
            answer.putString("sha256", sha256.toString());
        } catch (Throwable error) {
            file.delete();
            answer.putString("error", error.toString());
        } finally {
            if (encoders != null) encoders.shutdownNow();
            pending.delete();
        }
        return answer;
    }

    private Bundle captureRefs(Application app, String arg, Bundle extras) {
        Bundle answer = new Bundle();
        if (arg == null || arg.length() > 12_000) {
            answer.putString("error", "Invalid ref list");
            return answer;
        }
        String[] refs = arg.split(";", -1);
        if (refs.length < 1 || refs.length > 80) {
            answer.putString("error", "Ref batch supports 1-80 Views");
            return answer;
        }
        HashSet<String> unique = new HashSet<>();
        for (String ref : refs) {
            if (ref.length() > 256 || !ref.matches("[\\w.$]+@[0-9a-f]{1,8}") || !unique.add(ref)) {
                answer.putString("error", "Invalid or duplicate View identity");
                return answer;
            }
        }
        String nonce = extras == null ? null : extras.getString("nonce");
        if (nonce != null && !nonce.matches("[0-9a-f]{16}")) {
            answer.putString("error", "Invalid capture nonce");
            return answer;
        }
        File file = new File(app.getNoBackupFilesDir(), "inspector-ref-layers.bin");
        File pending = new File(app.getNoBackupFilesDir(), "inspector-ref-layers.bin.tmp");
        file.delete();
        pending.delete();
        AtomicReference<ArrayList<RefLayer>> selected = new AtomicReference<>();
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
                ArrayList<RefLayer> result = new ArrayList<>();
                int[] position = new int[2];
                for (String wanted : refs) {
                    View view = findUnique(root, wanted);
                    if (view == null || !view.isShown() || view.getWidth() <= 0 || view.getHeight() <= 0) {
                        result.add(new RefLayer(wanted, "控件缺失或不可见", '-'));
                        continue;
                    }
                    view.getLocationOnScreen(position);
                    int x = position[0], y = position[1];
                    if (view instanceof SurfaceView) {
                        // ponytail: surface buffers are copied after the main-thread pass; a live frame is required.
                        result.add(new RefLayer(wanted, (SurfaceView) view, x, y));
                        continue;
                    }
                    if (view instanceof TextureView) {
                        Bitmap frame = ((TextureView) view).getBitmap(view.getWidth(), view.getHeight());
                        result.add(frame == null ? new RefLayer(wanted, "缓冲层读取失败", 'T') : new RefLayer(wanted, frame, x, y, 'T'));
                        continue;
                    }
                    if ((flags.getInt(view) & 0x80) != 0 && (overlay == null || overlay.get(view) == null) && !customDispatchDraw(view.getClass())) {
                        result.add(new RefLayer(wanted, "结构容器，系统跳过自身绘制", '-', true));
                        continue;
                    }
                    Bitmap own = IsolatedCapture.own(view);
                    result.add(own == null ? new RefLayer(wanted, "位图生成失败", '-') : new RefLayer(wanted, own, x, y, '-'));
                }
                selectedRoot.set(root);
                selected.set(result);
            } catch (Throwable error) {
                failure.set(error);
            } finally {
                ready.countDown();
            }
        });
        long started = SystemClock.uptimeMillis();
        ExecutorService encoders = null;
        try {
            if (!ready.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("View selection timed out");
            if (failure.get() != null) throw new IllegalStateException(failure.get().toString());
            StringBuilder special = new StringBuilder();
            StringBuilder pure = new StringBuilder();
            StringBuilder failures = new StringBuilder();
            StringBuilder empties = new StringBuilder();
            for (RefLayer layer : selected.get()) {
                if (layer.surface != null) copySurfaceLayer(layer);
                if (layer.pure) {
                    if (pure.length() > 0) pure.append(';');
                    pure.append(layer.ref);
                } else if (layer.failure != null) {
                    if (failures.length() > 0) failures.append(';');
                    failures.append(layer.ref).append(':').append(layer.failure);
                } else {
                    boolean blank = isEmptyBitmap(layer.bitmap);
                    if (layer.special != '-' && blank) {
                        layer.bitmap.recycle();
                        layer.bitmap = null;
                        if (failures.length() > 0) failures.append(';');
                        failures.append(layer.ref).append(':').append(BUFFER_EMPTY_REASON);
                        continue;
                    }
                    if (layer.special != '-') {
                        if (special.length() > 0) special.append(';');
                        special.append(layer.special).append(':').append(layer.ref);
                    }
                    if (blank) {
                        if (empties.length() > 0) empties.append(';');
                        empties.append(layer.ref);
                    }
                }
                if (special.length() > 6_000 || pure.length() > 16_000 || failures.length() > 16_000 || empties.length() > 16_000)
                    throw new IllegalStateException("Ref capture result exceeds budget");
            }
            long renderMs = SystemClock.uptimeMillis() - started;
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            boolean webpLossless = Build.VERSION.SDK_INT >= 30;
            int count = 0;
            AtomicLong encodeMs = new AtomicLong();
            // ponytail: same bounded render/encode pipeline as capture-visible; records keep the request order.
            encoders = Executors.newFixedThreadPool(2, runnable -> {
                Thread thread = new Thread(runnable, "inspector-encode");
                thread.setDaemon(true);
                return thread;
            });
            ArrayDeque<Future<VisibleRecord>> inFlight = new ArrayDeque<>();
            try (DataOutputStream output = new DataOutputStream(new DigestOutputStream(new FileOutputStream(pending), digest))) {
                output.writeLong(nonce == null ? 0 : Long.parseUnsignedLong(nonce, 16));
                for (RefLayer layer : selected.get()) {
                    if (layer.bitmap == null) continue;
                    if (SystemClock.uptimeMillis() - started > 60_000) throw new IllegalStateException("Ref capture time budget exceeded");
                    while (inFlight.size() >= MAX_PIPELINE_DEPTH) count += writeVisibleRecord(output, inFlight.pollFirst());
                    Bitmap bitmap = layer.bitmap;
                    String ref = layer.ref;
                    int x = layer.x, y = layer.y;
                    inFlight.addLast(encoders.submit(() -> encodeVisibleLayer(bitmap, ref, x, y, webpLossless, encodeMs)));
                }
                while (!inFlight.isEmpty()) count += writeVisibleRecord(output, inFlight.pollFirst());
                output.writeByte(2);
            } finally {
                encoders.shutdownNow();
            }
            if (selectedRoot.get() != resumed.get().getWindow().getDecorView() || !selectedRoot.get().isAttachedToWindow()
                    || pending.length() > 64_000_000 || !pending.renameTo(file)) throw new IllegalStateException("Activity changed during ref capture");
            answer.putString("result", "ok");
            if (nonce != null) answer.putString("nonce", nonce);
            answer.putString("processInstance", processInstance);
            answer.putString("rootRef", ref(selectedRoot.get()));
            answer.putInt("count", count);
            answer.putInt("requested", refs.length);
            answer.putString("special", special.length() == 0 ? "-" : special.toString());
            answer.putString("pure", pure.length() == 0 ? "-" : pure.toString());
            answer.putString("failures", failures.length() == 0 ? "-" : failures.toString());
            answer.putString("empty", empties.length() == 0 ? "-" : empties.toString());
            answer.putLong("renderMs", renderMs);
            answer.putLong("encodeMs", encodeMs.get());
            answer.putLong("durationMs", SystemClock.uptimeMillis() - started);
            answer.putLong("bytes", file.length());
            StringBuilder sha256 = new StringBuilder(64);
            for (byte value : digest.digest()) sha256.append(String.format("%02x", value & 0xff));
            answer.putString("sha256", sha256.toString());
        } catch (Throwable error) {
            file.delete();
            answer.putString("error", error.toString());
        } finally {
            if (encoders != null) encoders.shutdownNow();
            pending.delete();
        }
        return answer;
    }

    private static final String BUFFER_EMPTY_REASON = "独立缓冲区返回全透明像素，未确认取得视频画面；不代表控件本身没有内容";

    private static final class RefLayer {
        final String ref;
        final SurfaceView surface;
        final char special;
        final boolean pure;
        final int x, y;
        Bitmap bitmap;
        String failure;
        RefLayer(String ref, String failure, char special) { this(ref, failure, special, false); }
        RefLayer(String ref, String failure, char special, boolean pure) {
            this.ref = ref;
            this.surface = null;
            this.special = special;
            this.pure = pure;
            this.x = 0;
            this.y = 0;
            this.failure = failure;
        }
        RefLayer(String ref, Bitmap bitmap, int x, int y, char special) {
            this.ref = ref;
            this.surface = null;
            this.special = special;
            this.pure = false;
            this.x = x;
            this.y = y;
            this.bitmap = bitmap;
        }
        RefLayer(String ref, SurfaceView surface, int x, int y) {
            this.ref = ref;
            this.surface = surface;
            this.special = 'S';
            this.pure = false;
            this.x = x;
            this.y = y;
        }
    }

    private static void copySurfaceLayer(RefLayer layer) {
        if (Build.VERSION.SDK_INT < 24) {
            layer.failure = "系统版本不支持独立缓冲采集";
            return;
        }
        Bitmap bitmap = Bitmap.createBitmap(layer.surface.getWidth(), layer.surface.getHeight(), Bitmap.Config.ARGB_8888);
        CountDownLatch copied = new CountDownLatch(1);
        int[] status = new int[1];
        try {
            PixelCopy.request(layer.surface, bitmap, (result) -> { status[0] = result; copied.countDown(); }, new Handler(Looper.getMainLooper()));
        } catch (Throwable error) {
            bitmap.recycle();
            layer.failure = "缓冲层读取失败";
            return;
        }
        try {
            if (!copied.await(2, TimeUnit.SECONDS)) {
                bitmap.recycle();
                layer.failure = "缓冲层未在限定时间内返回画面";
                return;
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            bitmap.recycle();
            layer.failure = "缓冲层读取失败";
            return;
        }
        if (status[0] != PixelCopy.SUCCESS) {
            bitmap.recycle();
            layer.failure = "缓冲层读取失败";
            return;
        }
        layer.bitmap = bitmap;
    }

    private static boolean isEmptyBitmap(Bitmap bitmap) {
        long pixels = (long) bitmap.getWidth() * bitmap.getHeight();
        if (pixels > 1_000_000) return false; // ponytail: skip the scan for oversized bitmaps; treat as opaque.
        int[] row = new int[bitmap.getWidth()];
        try {
            for (int y = 0; y < bitmap.getHeight(); y++) {
                bitmap.getPixels(row, 0, row.length, 0, y, row.length, 1);
                for (int value : row) if ((value >>> 24) != 0) return false;
            }
        } catch (Throwable unsupported) {
            return false; // ponytail: pixel access is not available for every bitmap config; unknown stays opaque.
        }
        return true;
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
        report.put("visibleStreamVersion", Build.VERSION.SDK_INT >= 30 ? 2 : 1);
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
            JSONObject layoutRules = layoutRules(view, params);
            if (layoutRules != null) item.put("layoutRules", layoutRules);
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

    private static JSONObject layoutRules(View view, ViewGroup.LayoutParams params) throws JSONException {
        JSONObject rules = new JSONObject();
        String type;
        if (params instanceof RelativeLayout.LayoutParams) {
            type = "RelativeLayout";
            RelativeLayout.LayoutParams relative = (RelativeLayout.LayoutParams) params;
            int[] values = relative.getRules();
            for (int i = 0; i < RELATIVE_RULES.length && i < values.length; i++) {
                int value = values[i];
                if (value == 0) continue;
                int rule = RELATIVE_RULES[i];
                boolean parentRule = rule == RelativeLayout.ALIGN_PARENT_LEFT || rule == RelativeLayout.ALIGN_PARENT_TOP
                        || rule == RelativeLayout.ALIGN_PARENT_RIGHT || rule == RelativeLayout.ALIGN_PARENT_BOTTOM
                        || rule == RelativeLayout.ALIGN_PARENT_START || rule == RelativeLayout.ALIGN_PARENT_END
                        || rule == RelativeLayout.CENTER_IN_PARENT || rule == RelativeLayout.CENTER_HORIZONTAL
                        || rule == RelativeLayout.CENTER_VERTICAL;
                if (parentRule) rules.put(RELATIVE_RULE_NAMES[i], value == RelativeLayout.TRUE);
                else rules.put(RELATIVE_RULE_NAMES[i], layoutTarget(view, value));
            }
        } else {
            Class<?> constraintParams = constraintLayoutParamsClass(params.getClass());
            if (constraintParams == null) return null;
            type = "ConstraintLayout";
            for (String name : CONSTRAINT_ANCHORS) {
                Object raw = constraintFieldValue(params, constraintParams, name);
                if (!(raw instanceof Integer) || (Integer) raw == -1) continue;
                rules.put(name, layoutTarget(view, (Integer) raw));
            }
            boolean horizontal = rules.has("leftToLeft") || rules.has("leftToRight") || rules.has("rightToLeft")
                    || rules.has("rightToRight") || rules.has("startToStart") || rules.has("startToEnd")
                    || rules.has("endToStart") || rules.has("endToEnd");
            boolean vertical = rules.has("topToTop") || rules.has("topToBottom") || rules.has("bottomToTop")
                    || rules.has("bottomToBottom") || rules.has("baselineToBaseline") || rules.has("baselineToTop")
                    || rules.has("baselineToBottom");
            if (horizontal) putConstraintNumber(params, constraintParams, rules, "horizontalBias");
            if (vertical) putConstraintNumber(params, constraintParams, rules, "verticalBias");
            if (rules.has("circleConstraint")) {
                putConstraintNumber(params, constraintParams, rules, "circleRadius");
                putConstraintNumber(params, constraintParams, rules, "circleAngle");
            }
            Object ratio = constraintFieldValue(params, constraintParams, "dimensionRatio");
            if (ratio instanceof String && !((String) ratio).isEmpty()) rules.put("dimensionRatio", ratio);
        }
        if (rules.length() == 0) return null;
        JSONObject result = new JSONObject();
        result.put("type", type);
        result.put("rules", rules);
        return result;
    }

    private static Class<?> constraintLayoutParamsClass(Class<?> type) {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            if ("androidx.constraintlayout.widget.ConstraintLayout$LayoutParams".equals(current.getName())) return current;
        }
        return null;
    }

    private static Object constraintFieldValue(ViewGroup.LayoutParams params, Class<?> type, String name) {
        HashMap<String, Field> fields = CONSTRAINT_FIELDS.get(type);
        if (fields == null) {
            fields = new HashMap<>();
            CONSTRAINT_FIELDS.put(type, fields);
        }
        if (!fields.containsKey(name)) {
            try { fields.put(name, type.getField(name)); }
            catch (NoSuchFieldException ignored) { fields.put(name, null); }
        }
        Field field = fields.get(name);
        if (field == null) return null;
        try { return field.get(params); }
        catch (IllegalAccessException ignored) { return null; }
    }

    private static void putConstraintNumber(ViewGroup.LayoutParams params, Class<?> type, JSONObject rules, String name) throws JSONException {
        Object value = constraintFieldValue(params, type, name);
        if (value instanceof Number) {
            float number = ((Number) value).floatValue();
            if (!Float.isNaN(number) && !Float.isInfinite(number)) rules.put(name, String.valueOf(value));
        }
    }

    private static String layoutTarget(View view, int id) {
        if (id == 0) return "parent";
        try { return view.getResources().getResourceName(id); }
        catch (RuntimeException ignored) { return "id/0x" + Integer.toHexString(id); }
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

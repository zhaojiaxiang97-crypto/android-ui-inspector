package com.artemis.helper;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

/** Scheduling metadata only. One focused root with prefetch disabled; no child traversal, screenshot or input ticket. */
public final class InspectorWindowState {
    private static final AtomicBoolean ACTIVE = new AtomicBoolean();
    private InspectorWindowState() {}
    private static final class Failure extends Exception {
        final String code;
        Failure(String code) { this.code = code; }
    }
    private static final class Sample {
        final JSONArray windows = new JSONArray();
        String foreground;
        Integer rootWindowId;
        int rootReads;
    }
    private static void check(AccessibilityService service, String instance, BooleanSupplier permitted, long deadline) throws Exception {
        if (!permitted.getAsBoolean()) throw new Failure("authorization_changed");
        if (!instance.equals(InspectorObservation.inputServiceId(service))) throw new Failure("service_changed");
        if (Thread.currentThread().isInterrupted() || SystemClock.elapsedRealtime() >= deadline) throw new Failure("timeout");
    }
    @SuppressWarnings("deprecation")
    private static JSONObject display(AccessibilityService service) throws Exception {
        DisplayManager manager = (DisplayManager) service.getSystemService(Context.DISPLAY_SERVICE);
        Display screen = manager == null ? null : manager.getDisplay(Display.DEFAULT_DISPLAY);
        if (screen == null) throw new Failure("display_changed");
        DisplayMetrics metrics = new DisplayMetrics(); screen.getRealMetrics(metrics);
        if (metrics.widthPixels <= 0 || metrics.heightPixels <= 0 || screen.getRotation() < 0 || screen.getRotation() > 3)
            throw new Failure("display_changed");
        return new JSONObject().put("width", metrics.widthPixels).put("height", metrics.heightPixels).put("rotation", screen.getRotation());
    }
    private static String type(int type) throws Exception {
        switch (type) {
            case AccessibilityWindowInfo.TYPE_APPLICATION: return "application";
            case AccessibilityWindowInfo.TYPE_SYSTEM: return "system";
            case AccessibilityWindowInfo.TYPE_INPUT_METHOD: return "input_method";
            case AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY: return "accessibility_overlay";
            case AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER: return "split_screen_divider";
            default: throw new Failure("incomplete");
        }
    }
    @SuppressWarnings("deprecation")
    private static Sample inventory(AccessibilityService service, String instance, BooleanSupplier permitted, long deadline, boolean readRoot) throws Exception {
        check(service, instance, permitted, deadline);
        List<AccessibilityWindowInfo> supplied = service.getWindows();
        if (supplied == null) throw new Failure("incomplete");
        List<AccessibilityWindowInfo> windows = new ArrayList<>(supplied);
        Sample sample = new Sample(); Set<Integer> ids = new HashSet<>();
        try {
            if (windows.size() > 16) throw new Failure("incomplete");
            windows.sort(Comparator.comparingInt(AccessibilityWindowInfo::getId));
            AccessibilityWindowInfo focus = null; int focuses = 0, active = 0;
            for (AccessibilityWindowInfo w : windows) {
                check(service, instance, permitted, deadline);
                if (w.getId() < 0 || !ids.add(w.getId()) || w.getDisplayId() != Display.DEFAULT_DISPLAY) throw new Failure("incomplete");
                Rect b = new Rect(); w.getBoundsInScreen(b);
                if (b.isEmpty() || w.getTransitionTimeMillis() < 0) throw new Failure("incomplete");
                AccessibilityWindowInfo parent = w.getParent();
                boolean hasParent = parent != null; if (parent != null) parent.recycle();
                sample.windows.put(new JSONObject().put("id", w.getId()).put("displayId", w.getDisplayId())
                    .put("type", type(w.getType())).put("layer", w.getLayer()).put("focused", w.isFocused()).put("active", w.isActive())
                    .put("hasParent", hasParent).put("transitionTimeMs", w.getTransitionTimeMillis())
                    .put("bounds", new JSONObject().put("left", b.left).put("top", b.top).put("right", b.right).put("bottom", b.bottom)));
                if (w.isFocused()) { focuses++; focus = w; }
                if (w.isActive()) active++;
            }
            if (readRoot && focuses == 1 && active == 1 && focus.isActive() && focus.getType() == AccessibilityWindowInfo.TYPE_APPLICATION) {
                AccessibilityNodeInfo root = null;
                try {
                    check(service, instance, permitted, deadline);
                    sample.rootReads++;
                    root = focus.getRoot(0); // Zero prefetch flags: never request descendants.
                    check(service, instance, permitted, deadline);
                    if (root != null) {
                        CharSequence pkg = root.getPackageName();
                        sample.foreground = pkg == null ? null : pkg.toString(); sample.rootWindowId = root.getWindowId();
                    }
                } finally { HierarchyDumper.safeRecycle(root); }
            }
            return sample;
        } finally { for (AccessibilityWindowInfo w : windows) if (w != null) w.recycle(); }
    }
    public static JSONObject execute(AccessibilityService service, String body, BooleanSupplier permitted) throws Exception {
        final JSONObject request; final String instance; final long started = SystemClock.elapsedRealtime(), deadline;
        try {
            if (body == null || body.getBytes(StandardCharsets.UTF_8).length > 4096) throw new IllegalArgumentException();
            request = new JSONObject(body);
            InspectorObservation.waitKeys(request, "version", "sessionId", "requestId", "serviceInstanceId", "packageName", "display", "timeoutMs");
            InspectorObservation.waitInteger(request, "version", 1, 1);
            for (String key : new String[]{"sessionId", "requestId", "serviceInstanceId"}) InspectorObservation.waitUuid(request, key);
            instance = request.getString("serviceInstanceId");
            String pkg = InspectorObservation.waitText(request, "packageName", 256);
            if (!pkg.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")) throw new IllegalArgumentException();
            JSONObject frame = request.getJSONObject("display"); InspectorObservation.waitKeys(frame, "width", "height", "rotation");
            InspectorObservation.waitInteger(frame, "width", 1, 16384); InspectorObservation.waitInteger(frame, "height", 1, 16384);
            InspectorObservation.waitInteger(frame, "rotation", 0, 3);
            deadline = started + InspectorObservation.waitInteger(request, "timeoutMs", 50, 500);
        } catch (Exception invalid) { return new JSONObject().put("success", false).put("errorCode", "invalid_request"); }
        if (!ACTIVE.compareAndSet(false, true)) return new JSONObject().put("success", false).put("errorCode", "busy");
        try {
            if (Build.VERSION.SDK_INT < 34) throw new Failure("unsupported");
            check(service, instance, permitted, deadline);
            if (!service.clearCache()) throw new Failure("incomplete");
            check(service, instance, permitted, deadline);
            JSONObject frame = display(service);
            if (!frame.toString().equals(request.getJSONObject("display").toString())) {
                JSONObject expected = request.getJSONObject("display");
                if (frame.getInt("width") != expected.getInt("width") || frame.getInt("height") != expected.getInt("height")
                    || frame.getInt("rotation") != expected.getInt("rotation")) throw new Failure("display_changed");
            }
            Sample before = inventory(service, instance, permitted, deadline, true);
            Sample after = inventory(service, instance, permitted, deadline, false);
            if (!frame.toString().equals(display(service).toString())) throw new Failure("display_changed");
            check(service, instance, permitted, deadline);
            JSONObject reply = new JSONObject();
            for (String key : new String[]{"version", "sessionId", "requestId", "serviceInstanceId", "packageName"}) reply.put(key, request.get(key));
            return reply.put("display", frame).put("readOnly", true).put("dispatchState", "not_sent")
                .put("startedAtMs", started).put("finishedAtMs", SystemClock.elapsedRealtime())
                .put("windowsBefore", before.windows).put("windowsAfter", after.windows)
                .put("foregroundPackage", before.foreground == null ? JSONObject.NULL : before.foreground)
                .put("rootWindowId", before.rootWindowId == null ? JSONObject.NULL : before.rootWindowId)
                .put("cacheCleared", true).put("rootReads", before.rootReads).put("childReads", 0).put("screenshots", 0);
        } catch (Exception error) {
            return new JSONObject().put("success", false).put("errorCode", error instanceof Failure ? ((Failure) error).code : "incomplete");
        } finally { ACTIVE.set(false); }
    }
}

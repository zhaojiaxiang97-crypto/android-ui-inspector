package com.artemis.helper;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Inspector-only read protocol. No actions, token management, or upstream endpoint changes. */
public final class InspectorObservation {
    private static final Map<AccessibilityService, String> INSTANCES = new WeakHashMap<>();
    private static final ExecutorService SCREENSHOTS = Executors.newSingleThreadExecutor();
    private static final int MAX_NODES = 5000;
    private static final int MAX_DEPTH = 75;
    // AOSP AccessibilityInteractionClient caches the entire uninterruptible batch
    // before returning the requested child. Ordinary prefetch returns that child
    // first, allowing the next DFS request to interrupt the remaining prefetch.
    // Each framework batch is capped at 50 nodes; our traversal still visits all.
    // https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android14-release/core/java/android/view/accessibility/AccessibilityNodeInfo.java
    // https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/view/accessibility/AccessibilityInteractionClient.java
    private static final int CHILD_PREFETCH_FLAGS = AccessibilityNodeInfo.FLAG_PREFETCH_DESCENDANTS_DEPTH_FIRST
            | AccessibilityNodeInfo.FLAG_PREFETCH_UNINTERRUPTIBLE;

    private InspectorObservation() {}

    private static synchronized String instanceId(AccessibilityService service) {
        String id = INSTANCES.get(service);
        if (id == null) { id = UUID.randomUUID().toString(); INSTANCES.put(service, id); }
        return id;
    }

    public static JSONObject capabilities(AccessibilityService service) throws Exception {
        boolean screenshot = Build.VERSION.SDK_INT >= 30;
        JSONObject flags = new JSONObject();
        for (String flag : new String[]{"tree", "completeFields", "windowIdentity", "visibleBounds",
                "includeInvisible", "orderedObservation"}) flags.put(flag, true);
        flags.put("screenshot", screenshot).put("losslessScreenshot", screenshot);
        return new JSONObject().put("success", true).put("protocolVersion", 1)
                .put("serviceInstanceId", instanceId(service)).put("capabilities", flags)
                .put("screenshotFormat", "png").put("visibility", "explicit-clipped");
    }

    private static final class Capture {
        boolean complete = true;
        boolean truncated = false;
        int nodes = 0;
        final List<AccessibilityNodeInfo> roots = new ArrayList<>();
        final JSONArray windows = new JSONArray();
        final List<String> trees = new ArrayList<>();
        String focusedId = "";
        String focusedPackage = "";
        int focusedCount = 0;
    }

    /** Serializes concurrent clients. Tree then PNG is ordered, never a same-frame claim. */
    public static synchronized JSONObject snapshot(AccessibilityService service) throws Exception {
        long started = SystemClock.elapsedRealtime();
        Capture before = new Capture();
        Capture after = new Capture();
        JSONObject result = new JSONObject().put("success", false).put("has_screenshot", false);
        JSONObject metadata = new JSONObject().put("protocolVersion", 1)
                .put("serviceInstanceId", instanceId(service)).put("captureId", UUID.randomUUID().toString())
                .put("screenshotTiming", "after-hierarchy").put("lossless", true)
                .put("visibility", "explicit-clipped").put("complete", false);
        JSONObject timing = new JSONObject().put("startedAtMs", started);
        metadata.put("timing", timing);
        result.put("helperObservation", metadata);
        Bitmap bitmap = null;
        try {
            // Root queries bypass the framework cache, but descendant queries may reuse it.
            // Clear once per observation while keeping descendant prefetch enabled. This does
            // not make the tree and screenshot atomic or refresh the app's own node provider.
            // API 30-32 retain their existing behavior; freshness there is not verified.
            if (Build.VERSION.SDK_INT >= 33 && !service.clearCache())
                throw new IllegalStateException("Accessibility cache could not be cleared");
            JSONObject displayBefore = display(service);
            metadata.put("displayBefore", displayBefore);
            enumerate(service, before, true);
            metadata.put("windowsBefore", before.windows);
            metadata.put("windowId", before.focusedId).put("packageName", before.focusedPackage);
            timing.put("hierarchyStartedAtMs", SystemClock.elapsedRealtime());
            Rect displayClip = new Rect(0, 0, displayBefore.getInt("width"), displayBefore.getInt("height"));
            for (int i = 0; i < before.roots.size(); i++) {
                AccessibilityNodeInfo root = before.roots.get(i);
                JSONObject window = before.windows.getJSONObject(i);
                if (root == null) continue;
                Rect clip = intersection(displayClip, fromJson(window.getJSONObject("bounds")));
                before.trees.add(node(root, 0, i, window.getString("id"), window, clip, true, before));
            }
            timing.put("hierarchyCompletedAtMs", SystemClock.elapsedRealtime());
            timing.put("screenshotStartedAtMs", SystemClock.elapsedRealtime());
            if (Build.VERSION.SDK_INT < 30) throw new IllegalStateException("Screenshot requires Android 11 or newer");
            Screenshot shot = takeScreenshot(service);
            bitmap = shot.bitmap;
            timing.put("screenshotCompletedAtMs", shot.completedAt);
            if (bitmap == null) throw new IllegalStateException("Screenshot unavailable: " + shot.error);
            // Optional v1 diagnostics use the same monotonic clock as the observation.
            // They do not replace geometry/window checks or claim a simultaneous frame.
            JSONObject postProcessing = new JSONObject();
            postProcessing.put("windowValidationStartedAtMs", SystemClock.elapsedRealtime());
            JSONObject displayAfter = display(service);
            metadata.put("displayAfter", displayAfter);
            enumerate(service, after, false);
            metadata.put("windowsAfter", after.windows);
            boolean stable = displayBefore.toString().equals(displayAfter.toString())
                    && before.windows.toString().equals(after.windows.toString())
                    && before.focusedCount == 1 && after.focusedCount == 1
                    && !before.focusedPackage.isEmpty()
                    && bitmap.getWidth() == displayBefore.getInt("width")
                    && bitmap.getHeight() == displayBefore.getInt("height");
            postProcessing.put("windowValidationCompletedAtMs", SystemClock.elapsedRealtime());
            StringBuilder xml = new StringBuilder("<?xml version='1.0' encoding='UTF-8'?>\n<hierarchy rotation=\"")
                    .append(displayBefore.getInt("rotation")).append("\">");
            for (String tree : before.trees) xml.append(tree);
            xml.append("</hierarchy>");
            postProcessing.put("pngEncodingStartedAtMs", SystemClock.elapsedRealtime());
            byte[] pngBytes = InspectorPngEncoder.encode(bitmap);
            postProcessing.put("pngEncodingCompletedAtMs", SystemClock.elapsedRealtime());
            postProcessing.put("base64EncodingStartedAtMs", SystemClock.elapsedRealtime());
            String screenshotBase64 = Base64.encodeToString(pngBytes, Base64.NO_WRAP);
            postProcessing.put("base64EncodingCompletedAtMs", SystemClock.elapsedRealtime());
            timing.put("postProcessing", postProcessing);
            result.put("xml", xml.toString()).put("width", bitmap.getWidth()).put("height", bitmap.getHeight())
                    .put("rotation", displayBefore.getInt("rotation")).put("node_count", before.nodes)
                    .put("window_count", before.windows.length()).put("truncated", before.truncated)
                    .put("screenshot_base64", screenshotBase64)
                    .put("screenshot_format", "png").put("has_screenshot", true).put("success", true);
            metadata.put("complete", stable && before.complete && after.complete && !before.truncated);
            if (!metadata.getBoolean("complete")) result.put("error", "Incomplete fields, window inventory changed, or display changed");
        } catch (Exception error) {
            result.put("error", error.getMessage() == null ? "Observation failed" : error.getMessage());
        } finally {
            if (bitmap != null) bitmap.recycle();
            for (AccessibilityNodeInfo root : before.roots) HierarchyDumper.safeRecycle(root);
            timing.put("completedAtMs", SystemClock.elapsedRealtime());
        }
        return result;
    }

    /** No guessed default dimensions or rotation may become input evidence. */
    @SuppressWarnings("deprecation")
    private static JSONObject display(AccessibilityService service) throws Exception {
        DisplayManager manager = (DisplayManager) service.getSystemService(Context.DISPLAY_SERVICE);
        Display display = manager == null ? null : manager.getDisplay(Display.DEFAULT_DISPLAY);
        if (display == null) throw new IllegalStateException("Default display unavailable");
        DisplayMetrics metrics = new DisplayMetrics();
        display.getRealMetrics(metrics);
        int rotation = display.getRotation();
        if (metrics.widthPixels <= 0 || metrics.heightPixels <= 0 || rotation < 0 || rotation > 3)
            throw new IllegalStateException("Invalid display geometry");
        return new JSONObject().put("width", metrics.widthPixels).put("height", metrics.heightPixels).put("rotation", rotation);
    }

    /** Inventory includes inaccessible roots and overlays; missing data fails completeness. */
    @SuppressWarnings("deprecation")
    private static void enumerate(AccessibilityService service, Capture capture, boolean retain) throws Exception {
        List<AccessibilityWindowInfo> supplied = service.getWindows();
        if (supplied == null || supplied.isEmpty()) { capture.complete = false; return; }
        List<AccessibilityWindowInfo> windows = new ArrayList<>(supplied);
        Collections.sort(windows, Comparator.comparingInt(AccessibilityWindowInfo::getId));
        Set<Integer> ids = new HashSet<>();
        try {
            for (AccessibilityWindowInfo window : windows) {
                AccessibilityNodeInfo root = null;
                JSONObject entry = new JSONObject();
                try {
                    int id = window.getId();
                    if (!ids.add(id)) capture.complete = false;
                    Rect bounds = new Rect();
                    window.getBoundsInScreen(bounds);
                    String type = windowType(window.getType());
                    entry.put("id", Integer.toString(id)).put("type", type).put("layer", window.getLayer())
                            .put("active", window.isActive()).put("focused", window.isFocused()).put("bounds", rectJson(bounds));
                    if (Build.VERSION.SDK_INT >= 30 && window.getDisplayId() != Display.DEFAULT_DISPLAY) capture.complete = false;
                    root = Build.VERSION.SDK_INT >= 33 ? window.getRoot(1 << 3) : window.getRoot();
                    String pkg = root == null ? "" : string(root.getPackageName());
                    entry.put("rootAvailable", root != null).put("packageName", pkg);
                    if (root == null || root.getWindowId() != id || bounds.isEmpty() || id < 0 || type.equals("unknown")) capture.complete = false;
                    if (window.isFocused() && type.equals("application")) {
                        capture.focusedCount++;
                        capture.focusedId = Integer.toString(id);
                        capture.focusedPackage = pkg;
                    }
                } catch (Exception error) {
                    capture.complete = false;
                    entry.put("rootAvailable", false);
                }
                capture.windows.put(entry);
                if (retain) capture.roots.add(root); else HierarchyDumper.safeRecycle(root);
            }
        } finally {
            for (AccessibilityWindowInfo window : windows) window.recycle();
        }
    }

    private static String node(AccessibilityNodeInfo node, int depth, int index, String windowId, JSONObject windowMetadata,
            Rect clip, boolean parentVisible, Capture capture) {
        if (depth > MAX_DEPTH || capture.nodes >= MAX_NODES) { capture.truncated = true; return ""; }
        capture.nodes++;
        StringBuilder xml = new StringBuilder("<node");
        try {
            Rect raw = new Rect();
            node.getBoundsInScreen(raw);
            Rect visibleBounds = intersection(raw, clip);
            boolean visible = parentVisible && node.isVisibleToUser() && !visibleBounds.isEmpty();
            if (!windowId.equals(Integer.toString(node.getWindowId()))) capture.complete = false;
            boolean scrollable = node.isScrollable();
            XmlUtils.appendIntAttribute(xml, "index", index);
            XmlUtils.appendAttribute(xml, "class", string(node.getClassName()));
            XmlUtils.appendAttribute(xml, "package", string(node.getPackageName()));
            XmlUtils.appendAttribute(xml, "text", string(node.getText()));
            XmlUtils.appendAttribute(xml, "resource-id", string(node.getViewIdResourceName()));
            XmlUtils.appendAttribute(xml, "content-desc", string(node.getContentDescription()));
            XmlUtils.appendAttribute(xml, "bounds", bounds(visibleBounds));
            XmlUtils.appendAttribute(xml, "bounds-screen", bounds(raw));
            XmlUtils.appendAttribute(xml, "visible-bounds", bounds(visibleBounds));
            XmlUtils.appendAttribute(xml, "window-id", windowId);
            if (windowMetadata != null) {
                XmlUtils.appendAttribute(xml, "window-type", windowMetadata.getString("type"));
                XmlUtils.appendIntAttribute(xml, "window-layer", windowMetadata.getInt("layer"));
                XmlUtils.appendBooleanAttribute(xml, "window-active", windowMetadata.getBoolean("active"));
                XmlUtils.appendBooleanAttribute(xml, "window-focused", windowMetadata.getBoolean("focused"));
            }
            XmlUtils.appendBooleanAttribute(xml, "visible-to-user", visible);
            XmlUtils.appendBooleanAttribute(xml, "enabled", node.isEnabled());
            XmlUtils.appendBooleanAttribute(xml, "clickable", node.isClickable());
            XmlUtils.appendBooleanAttribute(xml, "focusable", node.isFocusable());
            XmlUtils.appendBooleanAttribute(xml, "focused", node.isFocused());
            XmlUtils.appendBooleanAttribute(xml, "scrollable", scrollable);
            XmlUtils.appendBooleanAttribute(xml, "selected", node.isSelected());
            XmlUtils.appendBooleanAttribute(xml, "checkable", node.isCheckable());
            XmlUtils.appendBooleanAttribute(xml, "checked", node.isChecked());
            XmlUtils.appendBooleanAttribute(xml, "long-clickable", node.isLongClickable());
            XmlUtils.appendBooleanAttribute(xml, "password", node.isPassword());
            XmlUtils.appendBooleanAttribute(xml, "editable", node.isEditable());
            XmlUtils.appendIntAttribute(xml, "drawing-order", node.getDrawingOrder());
            xml.append('>');
            // Accessibility exposes clipping for the window/display and scrollable ancestors.
            // It does not expose arbitrary ViewGroup.clipChildren or pixel occlusion.
            Rect childClip = scrollable ? visibleBounds : clip;
            int children = node.getChildCount();
            for (int i = 0; i < children; i++) {
                AccessibilityNodeInfo child = null;
                try {
                    child = Build.VERSION.SDK_INT >= 33 ? node.getChild(i, CHILD_PREFETCH_FLAGS) : node.getChild(i);
                    if (child == null) capture.complete = false;
                    else xml.append(node(child, depth + 1, i, windowId, null, childClip, visible, capture));
                } catch (Exception error) { capture.complete = false; }
                finally { HierarchyDumper.safeRecycle(child); }
            }
            xml.append("</node>");
            return xml.toString();
        } catch (Exception error) {
            capture.complete = false;
            return "";
        }
    }

    private static final class Screenshot {
        final CountDownLatch ready = new CountDownLatch(1);
        Bitmap bitmap;
        long completedAt;
        String error = "timed out";
        boolean closed;
    }

    @android.annotation.TargetApi(30)
    private static Screenshot takeScreenshot(AccessibilityService service) throws InterruptedException {
        Screenshot shot = new Screenshot();
        requestScreenshot(service, shot, true);
        try { shot.ready.await(2500, TimeUnit.MILLISECONDS); }
        catch (InterruptedException error) {
            synchronized (shot) {
                shot.closed = true;
                if (shot.bitmap != null) { shot.bitmap.recycle(); shot.bitmap = null; }
            }
            Thread.currentThread().interrupt();
            throw error;
        }
        finally { synchronized (shot) { shot.closed = true; } }
        return shot;
    }

    @android.annotation.TargetApi(30)
    private static void requestScreenshot(AccessibilityService service, Screenshot shot, boolean retry) {
        synchronized (shot) { if (shot.closed) return; }
        try {
            service.takeScreenshot(Display.DEFAULT_DISPLAY, SCREENSHOTS, new AccessibilityService.TakeScreenshotCallback() {
                @Override public void onSuccess(AccessibilityService.ScreenshotResult result) {
                    Bitmap hardware = null;
                    Bitmap copy = null;
                    HardwareBuffer buffer = result.getHardwareBuffer();
                    try {
                        hardware = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
                        if (hardware != null) copy = hardware.copy(Bitmap.Config.ARGB_8888, false);
                        synchronized (shot) {
                            if (!shot.closed) { shot.bitmap = copy; copy = null; shot.completedAt = SystemClock.elapsedRealtime(); }
                        }
                    } catch (Exception error) { synchronized (shot) { shot.error = "bitmap copy failed"; } }
                    finally {
                        if (copy != null) copy.recycle();
                        if (hardware != null) hardware.recycle();
                        buffer.close();
                        shot.ready.countDown();
                    }
                }
                @Override public void onFailure(int code) {
                    synchronized (shot) {
                        if (shot.closed) return;
                        shot.error = "framework error " + code;
                    }
                    if (code == 3 && retry) {
                        new Handler(Looper.getMainLooper()).postDelayed(() -> requestScreenshot(service, shot, false), 350);
                    } else shot.ready.countDown();
                }
            });
        } catch (Exception error) { synchronized (shot) { shot.error = "screenshot request failed"; } shot.ready.countDown(); }
    }

    private static Rect intersection(Rect first, Rect second) {
        // Rect.intersect does not reject empty/inverted inputs. Keep the raw node
        // rectangle for diagnosis, but never publish it as a visible hit area.
        if (first.isEmpty() || second.isEmpty()) return new Rect();
        Rect result = new Rect(first);
        if (!result.intersect(second)) result.setEmpty();
        return result;
    }
    private static JSONObject rectJson(Rect rect) throws Exception {
        return new JSONObject().put("x", rect.left).put("y", rect.top).put("width", rect.width()).put("height", rect.height());
    }
    private static Rect fromJson(JSONObject rect) throws Exception {
        int x = rect.getInt("x"), y = rect.getInt("y");
        return new Rect(x, y, x + rect.getInt("width"), y + rect.getInt("height"));
    }
    private static String bounds(Rect rect) { return "[" + rect.left + "," + rect.top + "][" + rect.right + "," + rect.bottom + "]"; }
    private static String string(CharSequence value) { return value == null ? "" : value.toString(); }
    private static String windowType(int type) {
        switch (type) {
            case AccessibilityWindowInfo.TYPE_APPLICATION: return "application";
            case AccessibilityWindowInfo.TYPE_INPUT_METHOD: return "input_method";
            case AccessibilityWindowInfo.TYPE_SYSTEM: return "system";
            case AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY: return "accessibility_overlay";
            case AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER: return "split_screen_divider";
            default: return "unknown";
        }
    }
}

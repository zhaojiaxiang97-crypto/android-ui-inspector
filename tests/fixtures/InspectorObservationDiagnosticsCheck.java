import java.util.*;

/** Fault-injectable adapters run the production snapshot/enumeration/traversal. */
public class InspectorObservationDiagnosticsCheck {
    static final int MAX_NODES = 5000, MAX_DEPTH = 75;
    static final String PRIVATE = "private-page-text-token-and-exception";
    static Scenario scenario;
    static final Set<String> observedReasons = new HashSet<>();

    static class JSONObject {
        final Map<String, Object> values = new LinkedHashMap<>();
        JSONObject put(String key, Object value) { values.put(key, value); return this; }
        Object get(String key) { if (!values.containsKey(key)) throw new IllegalStateException(PRIVATE); return values.get(key); }
        int getInt(String key) { return ((Number) get(key)).intValue(); }
        String getString(String key) { return (String) get(key); }
        boolean getBoolean(String key) { return (Boolean) get(key); }
        JSONObject getJSONObject(String key) { return (JSONObject) get(key); }
        JSONArray getJSONArray(String key) { return (JSONArray) get(key); }
        public String toString() { return values.toString(); }
    }
    static class JSONArray {
        final List<Object> values = new ArrayList<>();
        JSONArray put(Object value) { values.add(value); return this; }
        JSONObject getJSONObject(int index) { return (JSONObject) values.get(index); }
        int length() { return values.size(); }
        public String toString() { return values.toString(); }
    }
    static class Build { static class VERSION { static int SDK_INT = 33; } }
    static class SystemClock { static long tick; static long elapsedRealtime() { return ++tick; } }
    static class Context { static final String DISPLAY_SERVICE = "display"; }
    static class DisplayMetrics { int widthPixels, heightPixels; }
    static class Display {
        static final int DEFAULT_DISPLAY = 0;
        final boolean after;
        Display(boolean after) { this.after = after; }
        void getRealMetrics(DisplayMetrics metrics) { metrics.widthPixels = after ? scenario.afterWidth : 100; metrics.heightPixels = 200; }
        int getRotation() { return 0; }
    }
    static class DisplayManager {
        Display getDisplay(int id) { return new Display(++scenario.displayReads > 1); }
    }
    static class Rect {
        int left, top, right, bottom;
        Rect() {} Rect(int l, int t, int r, int b) { left = l; top = t; right = r; bottom = b; }
        Rect(Rect rect) { this(rect.left, rect.top, rect.right, rect.bottom); }
        int width() { return right - left; } int height() { return bottom - top; }
        boolean isEmpty() { return left >= right || top >= bottom; }
        void setEmpty() { left = top = right = bottom = 0; }
        boolean intersect(Rect rect) {
            if (left >= rect.right || rect.left >= right || top >= rect.bottom || rect.top >= bottom) return false;
            left = Math.max(left, rect.left); top = Math.max(top, rect.top);
            right = Math.min(right, rect.right); bottom = Math.min(bottom, rect.bottom); return true;
        }
    }
    static class AccessibilityNodeInfo {
        static final int FLAG_PREFETCH_DESCENDANTS_DEPTH_FIRST = 8, FLAG_PREFETCH_UNINTERRUPTIBLE = 32;
        int windowId = 7;
        boolean readFailure, childFailure, visible = true;
        String pkg = "app.test";
        final List<AccessibilityNodeInfo> children = new ArrayList<>();
        void getBoundsInScreen(Rect rect) { if (readFailure) throw new IllegalStateException(PRIVATE); rect.right = 100; rect.bottom = 200; }
        boolean isVisibleToUser() { return visible; }
        int getWindowId() { return windowId; }
        String getClassName() { return "android.view.View"; }
        String getPackageName() { return pkg; }
        String getText() { return PRIVATE; }
        String getViewIdResourceName() { return "test/resource"; }
        String getContentDescription() { return "test description"; }
        boolean isEnabled() { return true; } boolean isClickable() { return true; }
        boolean isFocusable() { return true; } boolean isFocused() { return false; }
        boolean isScrollable() { return false; } boolean isSelected() { return false; }
        boolean isCheckable() { return false; } boolean isChecked() { return false; }
        boolean isLongClickable() { return false; } boolean isPassword() { return false; }
        boolean isEditable() { return false; } int getDrawingOrder() { return 3; }
        int getChildCount() { return children.size(); }
        AccessibilityNodeInfo getChild(int index) { if (childFailure) throw new IllegalStateException(PRIVATE); return children.get(index); }
        AccessibilityNodeInfo getChild(int index, int flags) { return getChild(index); }
    }
    static class AccessibilityWindowInfo {
        static final int TYPE_APPLICATION = 1, TYPE_INPUT_METHOD = 2, TYPE_SYSTEM = 3,
                TYPE_ACCESSIBILITY_OVERLAY = 4, TYPE_SPLIT_SCREEN_DIVIDER = 5;
        int id = 7, type = TYPE_APPLICATION, displayId, layer;
        boolean focused = true, emptyBounds, readFailure, idFailure, recycleFailure;
        AccessibilityNodeInfo root = new AccessibilityNodeInfo();
        int getId() { if (idFailure) throw new IllegalStateException(PRIVATE); return id; }
        void getBoundsInScreen(Rect rect) {
            if (readFailure) throw new IllegalStateException(PRIVATE);
            if (!emptyBounds) { rect.right = 100; rect.bottom = 200; }
        }
        int getType() { return type; } int getLayer() { return layer; }
        boolean isActive() { return true; } boolean isFocused() { return focused; }
        int getDisplayId() { return displayId; }
        AccessibilityNodeInfo getRoot() { return root; }
        AccessibilityNodeInfo getRoot(int flags) { return root; }
        void recycle() { if (recycleFailure) throw new IllegalStateException(PRIVATE); }
    }
    static class AccessibilityService {
        boolean clearCache() { if (scenario.cacheThrows) throw new IllegalStateException(PRIVATE); return scenario.cacheCleared; }
        Object getSystemService(String key) { return new DisplayManager(); }
        List<AccessibilityWindowInfo> getWindows() {
            if (scenario.windowsThrow) throw new IllegalStateException(PRIVATE);
            return ++scenario.windowReads > 1 && scenario.afterWindows != null ? scenario.afterWindows : scenario.windows;
        }
    }
    static class Bitmap {
        int getWidth() { return scenario.bitmapWidth; } int getHeight() { return 200; }
        void recycle() { if (scenario.recycleThrows) throw new IllegalStateException(PRIVATE); }
    }
    static class Screenshot { Bitmap bitmap; long completedAt = SystemClock.elapsedRealtime(); String error = PRIVATE; }
    static Screenshot takeScreenshot(AccessibilityService service) {
        Screenshot shot = new Screenshot(); if (!scenario.noScreenshot) shot.bitmap = new Bitmap(); return shot;
    }
    static class InspectorPngEncoder {
        static byte[] encode(Bitmap bitmap) { if (scenario.encoderThrows) throw new IllegalStateException(PRIVATE); return new byte[]{1, 2}; }
    }
    static class Base64 { static final int NO_WRAP = 2; static String encodeToString(byte[] value, int flags) { return "png"; } }
    static class HierarchyDumper { static void safeRecycle(AccessibilityNodeInfo node) {} }
    static class XmlUtils {
        static void appendAttribute(StringBuilder b, String key, String value) { b.append(' ').append(key).append("=\"").append(value).append('"'); }
        static void appendIntAttribute(StringBuilder b, String key, int value) { appendAttribute(b, key, Integer.toString(value)); }
        static void appendBooleanAttribute(StringBuilder b, String key, boolean value) { appendAttribute(b, key, Boolean.toString(value)); }
    }
    static String instanceId(AccessibilityService service) { return "service-instance"; }

    /* PRODUCTION_METHODS */

    static class Scenario {
        List<AccessibilityWindowInfo> windows = new ArrayList<>(), afterWindows;
        int windowReads, displayReads, afterWidth = 100, bitmapWidth = 100;
        boolean cacheCleared = true, cacheThrows, windowsThrow, encoderThrows, noScreenshot, recycleThrows;
        Scenario() { windows.add(new AccessibilityWindowInfo()); }
    }
    static AccessibilityWindowInfo reset() {
        scenario = new Scenario(); Build.VERSION.SDK_INT = 33; return scenario.windows.get(0);
    }
    static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    static Map<String, Integer> reasons(JSONObject result) {
        JSONObject diagnostics = result.getJSONObject("helperObservation").getJSONObject("diagnostics");
        check(diagnostics.values.size() == 2 && diagnostics.getInt("version") == 1, "diagnostic envelope fields");
        check(!diagnostics.toString().contains(PRIVATE), "private data in diagnostics");
        Map<String, Integer> counts = new HashMap<>();
        JSONArray entries = diagnostics.getJSONArray("reasons");
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            String code = entry.getString("code"); int count = entry.getInt("count");
            check(entry.values.size() == 2 && count > 0 && count <= 10000, "bounded diagnostic fields");
            check(counts.put(code, count) == null, "duplicate reason"); observedReasons.add(code);
        }
        return counts;
    }
    static JSONObject capture() throws Exception {
        JSONObject result = snapshot(new AccessibilityService()); reasons(result);
        if (result.values.containsKey("error")) check(!result.getString("error").contains(PRIVATE), "private exception escaped");
        return result;
    }
    static JSONObject fails(String... codes) throws Exception {
        JSONObject result = capture();
        check(!result.getJSONObject("helperObservation").getBoolean("complete"), "invalid capture accepted");
        Map<String, Integer> actual = reasons(result);
        for (String code : codes) check(actual.containsKey(code), "missing reason " + code + ": " + actual);
        return result;
    }
    public static void main(String[] args) throws Exception {
        AccessibilityWindowInfo window = reset();
        AccessibilityNodeInfo hidden = new AccessibilityNodeInfo(); hidden.visible = false;
        window.root.children.add(hidden);
        JSONObject valid = capture();
        check(valid.getJSONObject("helperObservation").getBoolean("complete") && reasons(valid).isEmpty(), "complete capture changed");
        check(valid.getInt("node_count") == 2 && valid.getBoolean("has_screenshot") && !valid.getBoolean("truncated"), "tree/image coverage changed");
        String xml = valid.getString("xml");
        for (String field : new String[]{"class", "package", "text", "resource-id", "content-desc", "bounds", "bounds-screen", "visible-bounds",
                "window-id", "window-type", "window-layer", "window-active", "window-focused", "visible-to-user", "enabled", "clickable", "focusable",
                "focused", "scrollable", "selected", "checkable", "checked", "long-clickable", "password", "editable", "drawing-order"})
            check(xml.contains(field + "=\""), "lost tree field " + field);
        check(xml.contains(PRIVATE) && xml.contains("visible-to-user=\"false\""), "full/hidden nodes removed");

        reset(); scenario.windows = null; fails("windows_unavailable");
        reset(); scenario.windows.clear(); fails("windows_unavailable");
        window = reset(); scenario.windows.add(new AccessibilityWindowInfo());
        check(reasons(fails("duplicate_window_id", "focus_invalid")).get("duplicate_window_id") == 2, "before/after counts not merged");
        window = reset(); window.displayId = 1; fails("non_default_display");
        window = reset(); window.root = null; fails("window_root_unavailable", "focus_invalid");
        window = reset(); window.root.windowId = 8; fails("window_root_mismatch", "node_window_mismatch");
        window = reset(); window.emptyBounds = true; fails("window_bounds_invalid");
        window = reset(); window.id = window.root.windowId = -1; fails("window_id_invalid");
        window = reset(); window.type = -1; fails("window_type_unknown", "focus_invalid");
        window = reset(); window.readFailure = true; fails("window_read_failed");
        window = reset(); window.recycleFailure = true; fails("window_read_failed");
        window = reset(); window.idFailure = true; scenario.windows.add(new AccessibilityWindowInfo()); fails("window_read_failed");
        reset(); scenario.windowsThrow = true; fails("window_read_failed");
        window = reset(); AccessibilityNodeInfo wrongWindow = new AccessibilityNodeInfo(); wrongWindow.windowId = 8;
        window.root.children.add(wrongWindow); fails("node_window_mismatch");
        window = reset(); window.root.children.add(null); window.root.children.add(null);
        check(reasons(fails("child_unavailable")).get("child_unavailable") == 2, "null children count");
        window = reset(); window.root.readFailure = true; fails("node_read_failed");
        window = reset(); window.root.childFailure = true; window.root.children.add(new AccessibilityNodeInfo()); fails("node_read_failed");
        window = reset(); for (int i = 0; i < MAX_NODES; i++) window.root.children.add(new AccessibilityNodeInfo());
        JSONObject limited = fails("tree_truncated");
        check(limited.getBoolean("truncated") && limited.getInt("node_count") == MAX_NODES, "node limit changed");
        window = reset(); AccessibilityNodeInfo leaf = window.root;
        for (int i = 0; i < MAX_DEPTH + 1; i++) { AccessibilityNodeInfo child = new AccessibilityNodeInfo(); leaf.children.add(child); leaf = child; }
        JSONObject deep = fails("tree_truncated"); check(deep.getInt("node_count") == MAX_DEPTH + 1, "depth limit changed");
        reset(); scenario.afterWidth = 101; fails("display_changed");
        reset(); AccessibilityWindowInfo replacement = new AccessibilityWindowInfo(); replacement.layer = 1;
        scenario.afterWindows = Arrays.asList(replacement); fails("window_inventory_changed");
        window = reset(); window.focused = false; fails("focus_invalid");
        window = reset(); window.root.pkg = ""; fails("focus_invalid");
        reset(); scenario.bitmapWidth = 101; fails("screenshot_size_mismatch");
        reset(); scenario.cacheCleared = false;
        check(reasons(fails("cache_clear_failed")).size() == 1, "known cache failure mislabeled unknown");
        check(scenario.windowReads == 0 && scenario.displayReads == 0, "cache failure continued to capture");
        reset(); scenario.cacheThrows = true; fails("cache_clear_failed");
        check(scenario.windowReads == 0 && scenario.displayReads == 0, "cache exception continued to capture");
        reset(); scenario.encoderThrows = true; fails("capture_exception");
        reset(); scenario.noScreenshot = true; fails("capture_exception");
        reset(); scenario.recycleThrows = true; fails("capture_exception");
        window = reset(); window.root.children.add(null); scenario.encoderThrows = true;
        fails("child_unavailable", "capture_exception");

        // Several independent failed checks must survive; a short-circuit must
        // not hide later causes or turn them into a guessed transient failure.
        window = reset(); window.root.children.add(null); window.focused = false;
        scenario.afterWidth = 101; scenario.bitmapWidth = 102;
        replacement = new AccessibilityWindowInfo(); replacement.layer = 1;
        scenario.afterWindows = Arrays.asList(replacement);
        fails("child_unavailable", "display_changed", "window_inventory_changed", "focus_invalid", "screenshot_size_mismatch");
        Capture first = new Capture(), second = new Capture();
        for (int i = 0; i < 20000; i++) { first.fail(Capture.Reason.node_read_failed); second.fail(Capture.Reason.node_read_failed); }
        check(first.reasons.get(Capture.Reason.node_read_failed) == 10000 && first.combinedCount(Capture.Reason.node_read_failed, second) == 10000,
                "per-cause or merged counts unbounded");
        reset(); Build.VERSION.SDK_INT = 32; scenario.cacheCleared = false;
        check(capture().getJSONObject("helperObservation").getBoolean("complete"), "API32 cache behavior changed");
        check(observedReasons.size() == 19, "not all reason branches exercised: " + observedReasons);
        System.out.println("19 diagnostic codes checked; complete trees preserved; private errors excluded");
    }
}

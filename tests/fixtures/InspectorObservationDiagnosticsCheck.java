import java.util.*;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;
import java.util.concurrent.locks.ReentrantLock;

/** Fault-injectable adapters run the production snapshot/enumeration/traversal. */
public class InspectorObservationDiagnosticsCheck {
    static final int MAX_NODES = 5000, MAX_DEPTH = 75;
    static final String PRIVATE = "private-page-text-token-and-exception";
    static final String SERVICE_ID = "22222222-2222-4222-8222-222222222222";
    static Scenario scenario;
    static final Set<String> observedReasons = new HashSet<>();

    static class JSONObject {
        final Map<String, Object> values = new LinkedHashMap<>();
        static JSONObject body;
        JSONObject() {}
        JSONObject(String text) {
            if (body == null || !text.equals(body.toString())) throw new IllegalStateException(PRIVATE);
            values.putAll(body.values);
        }
        int length() { return values.size(); }
        boolean has(String key) { return values.containsKey(key); }
        Iterator<String> keys() { return values.keySet().iterator(); }
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
    static class SystemClock {
        static long tick, step = 1, offsetMs; static boolean realTime;
        static long elapsedRealtime() { if (realTime) return System.nanoTime() / 1000000 + offsetMs; tick += step; return tick; }
    }
    static class Context { static final String DISPLAY_SERVICE = "display", ACCESSIBILITY_SERVICE = "accessibility"; }
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
        static final int ACTION_CLICK = 16, ACTION_SCROLL_FORWARD = 4096, ACTION_SCROLL_BACKWARD = 8192;
        static class AccessibilityAction {
            final int id;
            AccessibilityAction(int id) { this.id = id; }
            int getId() { return id; }
        }
        int windowId = 7;
        int left, top, right = 100, bottom = 200;
        boolean readFailure, childFailure, visible = true, enabled = true, clickable = true, emptyBounds, scrollable, actionsUnavailable;
        String pkg = "app.test", className = "android.view.View", text = PRIVATE, resourceId = "test/resource", contentDesc = "test description";
        AccessibilityNodeInfo source;
        final List<AccessibilityNodeInfo> children = new ArrayList<>();
        final List<AccessibilityAction> actions = new ArrayList<>();
        static AccessibilityNodeInfo obtain(AccessibilityNodeInfo node) {
            AccessibilityNodeInfo copy = new AccessibilityNodeInfo(); copy.source = node; copy.copyFrom(node); return copy;
        }
        void copyFrom(AccessibilityNodeInfo node) {
            windowId = node.windowId; left = node.left; top = node.top; right = node.right; bottom = node.bottom;
            readFailure = node.readFailure; visible = node.visible; enabled = node.enabled; clickable = node.clickable;
            scrollable = node.scrollable; actionsUnavailable = node.actionsUnavailable; actions.clear(); actions.addAll(node.actions);
            emptyBounds = node.emptyBounds; pkg = node.pkg; className = node.className; text = node.text; resourceId = node.resourceId; contentDesc = node.contentDesc;
        }
        boolean refresh() {
            if (scenario.refreshHook != null) scenario.refreshHook.run();
            if (scenario.refreshFails) return false;
            if (source != null) copyFrom(source); return true;
        }
        boolean performAction(int action) {
            check(action == ACTION_CLICK || action == ACTION_SCROLL_FORWARD || action == ACTION_SCROLL_BACKWARD, "unexpected semantic action");
            scenario.actionCalls++; scenario.lastAction = action;
            if (scenario.actionChangesScroll) scenario.actionScrollY += 37;
            if (scenario.actionThrows) throw new IllegalStateException(PRIVATE);
            SystemClock.offsetMs += scenario.actionAdvanceMs;
            return scenario.actionAccepted;
        }
        void getBoundsInScreen(Rect rect) {
            SystemClock.offsetMs += scenario.nodeReadAdvanceMs;
            if (scenario.expireOnNodeRead) SystemClock.tick += 1001;
            if (scenario.changeTokenOnNodeRead) scenario.authorized = false;
            if (scenario.interruptOnNodeRead) Thread.currentThread().interrupt();
            if (readFailure) throw new IllegalStateException(PRIVATE);
            if (!emptyBounds) { rect.left = left; rect.top = top; rect.right = right; rect.bottom = bottom; }
        }
        boolean isVisibleToUser() { return visible; }
        int getWindowId() { return windowId; }
        String getClassName() { return className; }
        String getPackageName() { return pkg; }
        String getText() { return text; }
        String getViewIdResourceName() { return resourceId; }
        String getContentDescription() { return contentDesc; }
        boolean isEnabled() { return enabled; } boolean isClickable() { return clickable; }
        boolean isFocusable() { return true; } boolean isFocused() { return false; }
        boolean isScrollable() { return scrollable; } boolean isSelected() { return false; }
        List<AccessibilityAction> getActionList() { return actionsUnavailable ? null : actions; }
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
        String serviceId = SERVICE_ID;
        boolean clearCache() { scenario.cacheCalls++; SystemClock.tick += scenario.cacheCostMs;
            if (scenario.cacheThrows) throw new IllegalStateException(PRIVATE); return scenario.cacheCleared; }
        Object getSystemService(String key) { return new DisplayManager(); }
        List<AccessibilityWindowInfo> getWindows() {
            SystemClock.offsetMs += scenario.windowReadAdvanceMs;
            if (scenario.windowReadDelayMs > 0) try { Thread.sleep(scenario.windowReadDelayMs); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
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
    static class HierarchyDumper { static void safeRecycle(AccessibilityNodeInfo node) { if (node != null) scenario.recycled++; } }
    static class XmlUtils {
        static void appendAttribute(StringBuilder b, String key, String value) { b.append(' ').append(key).append("=\"").append(value).append('"'); }
        static void appendIntAttribute(StringBuilder b, String key, int value) { appendAttribute(b, key, Integer.toString(value)); }
        static void appendBooleanAttribute(StringBuilder b, String key, boolean value) { appendAttribute(b, key, Boolean.toString(value)); }
    }
    static String instanceId(AccessibilityService service) { return service.serviceId; }

    /* PRODUCTION_METHODS */

    static class Scenario {
        List<AccessibilityWindowInfo> windows = new ArrayList<>(), afterWindows;
        int windowReads, displayReads, afterWidth = 100, bitmapWidth = 100, cacheCalls, recycled, cacheCostMs, windowReadDelayMs, windowReadAdvanceMs;
        boolean cacheCleared = true, cacheThrows, windowsThrow, encoderThrows, noScreenshot, recycleThrows;
        boolean authorized = true, expireOnNodeRead, changeTokenOnNodeRead, interruptOnNodeRead;
        boolean refreshFails, actionThrows, actionAccepted = true, actionChangesScroll;
        int actionCalls, actionAdvanceMs, nodeReadAdvanceMs, lastAction, actionScrollY;
        Runnable refreshHook;
        Scenario() { windows.add(new AccessibilityWindowInfo()); }
    }
    static AccessibilityWindowInfo reset() {
        scenario = new Scenario(); Build.VERSION.SDK_INT = 33; SystemClock.tick = 0; SystemClock.step = 1;
        SystemClock.realTime = false; SystemClock.offsetMs = 0;
        Thread.interrupted(); return scenario.windows.get(0);
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
    static JSONObject waitInput() {
        return new JSONObject().put("version", 1).put("sessionId", "11111111-1111-4111-8111-111111111111")
                .put("requestId", "33333333-3333-4333-8333-333333333333").put("serviceInstanceId", SERVICE_ID)
                .put("packageName", "app.test").put("selector", new JSONObject().put("resourceId", "test/resource"))
                .put("state", "visible").put("display", new JSONObject().put("width", 100).put("height", 200).put("rotation", 0))
                .put("timeoutMs", 1000);
    }
    static JSONObject waitCall(JSONObject input) throws Exception {
        JSONObject.body = input;
        return waitForCondition(new AccessibilityService(), input.toString(), () -> scenario.authorized);
    }
    static void waitFails(JSONObject input, String code) throws Exception {
        JSONObject result = waitCall(input);
        check(!result.getBoolean("success") && result.getString("errorCode").equals(code), "wrong wait failure: " + result);
        check(result.values.size() == 2 && !result.toString().contains(PRIVATE), "private fields escaped wait failure");
    }
    static void waitChecks() throws Exception {
        reset(); SystemClock.step = 0;
        JSONObject ready = waitCall(waitInput());
        check(ready.getBoolean("success") && ready.getString("status").equals("ready"), "visible hint missing");
        check(ready.values.size() == 13 && ready.getInt("attempts") == 1 && ready.getInt("matchCount") == 1,
                "unexpected wait response fields");
        check(!ready.toString().contains(PRIVATE) && !ready.values.containsKey("xml") && !ready.values.containsKey("screenshot_base64"),
                "wait hint leaked page data");
        check(scenario.cacheCalls == 1 && scenario.recycled == 2, "one probe must clear cache and release both roots");
        reset(); SystemClock.step = 0;
        JSONObject input = waitInput(); input.put("selector", new JSONObject().put("resourceId", "test/resource")
                .put("text", PRIVATE).put("contentDesc", "test description").put("className", "android.view.View"));
        check(waitCall(input).getString("status").equals("ready"), "AND selector rejected exact match");
        input.getJSONObject("selector").put("text", "different"); input.put("state", "absent");
        check(waitCall(input).getString("status").equals("ready"), "selector fields were OR matched");
        AccessibilityWindowInfo window = reset(); SystemClock.step = 0; window.root.enabled = false;
        check(waitCall(waitInput().put("state", "disabled")).getString("status").equals("ready"), "disabled state mismatch");
        reset(); SystemClock.step = 0;
        check(waitCall(waitInput().put("state", "enabled")).getString("status").equals("ready"), "enabled state mismatch");
        window = reset(); SystemClock.step = 0; window.root.visible = false;
        check(waitCall(waitInput().put("state", "absent")).getInt("matchCount") == 0, "explicit hidden node blocked absent hint");
        reset(); SystemClock.step = 0;
        JSONObject pending = waitCall(waitInput().put("selector", new JSONObject().put("resourceId", "not-present")));
        check(pending.getString("status").equals("pending") && pending.getInt("attempts") == 8 && scenario.cacheCalls == 8,
                "pending probes must be bounded and refresh every attempt");
        reset(); SystemClock.step = 0; scenario.cacheCostMs = 400;
        pending = waitCall(waitInput().put("selector", new JSONObject().put("resourceId", "not-present")));
        check(pending.getString("status").equals("pending") && pending.getInt("attempts") == 2
                && pending.getInt("finishedAtMs") == 800, "complete false probe should yield before a slow next read exceeds budget");
        reset(); SystemClock.step = 0; scenario.cacheCostMs = 25;
        pending = waitCall(waitInput().put("timeoutMs", 50).put("selector", new JSONObject().put("resourceId", "not-present")));
        check(pending.getString("status").equals("pending") && pending.getInt("attempts") == 1,
                "short slice with complete false result must remain pending");

        reset(); Build.VERSION.SDK_INT = 32; waitFails(waitInput(), "unsupported");
        check(scenario.cacheCalls == 0, "unsupported API touched cache");
        reset(); waitFails(waitInput().put("unexpected", true), "invalid_request");
        reset(); waitFails(waitInput().put("version", "1"), "invalid_request");
        reset(); waitFails(waitInput().put("timeoutMs", 49), "invalid_request");
        reset(); waitFails(waitInput().put("timeoutMs", 1001), "invalid_request");
        reset(); waitFails(waitInput().put("timeoutMs", 50.5), "invalid_request");
        reset(); waitFails(waitInput().put("sessionId", "not-uuid"), "invalid_request");
        reset(); waitFails(waitInput().put("packageName", "invalid package"), "invalid_request");
        reset(); waitFails(waitInput().put("state", "clicked"), "invalid_request");
        reset(); waitFails(waitInput().put("selector", new JSONObject()), "invalid_request");
        reset(); waitFails(waitInput().put("selector", new JSONObject().put("contains", "text")), "invalid_request");
        reset(); waitFails(waitInput().put("selector", new JSONObject().put("text", 123)), "invalid_request");
        reset(); waitFails(waitInput().put("display", new JSONObject().put("width", 0).put("height", 200).put("rotation", 0)), "invalid_request");
        reset(); waitFails(waitInput().put("display", new JSONObject().put("width", 100).put("height", 200).put("rotation", 0).put("extra", 1)), "invalid_request");
        reset(); JSONObject invalid = waitForCondition(new AccessibilityService(), "malformed", () -> true);
        check(invalid.getString("errorCode").equals("invalid_request"), "malformed body accepted");
        reset(); StringBuilder oversized = new StringBuilder(); for (int i = 0; i < 1400; i++) oversized.append('\u4e2d');
        check(waitForCondition(new AccessibilityService(), oversized.toString(), () -> true).getString("errorCode").equals("invalid_request"),
                "UTF-8 body limit ignored");
        reset(); waitFails(waitInput().put("serviceInstanceId", "44444444-4444-4444-8444-444444444444"), "service_changed");
        reset(); scenario.authorized = false; waitFails(waitInput(), "authorization_changed");
        check(scenario.cacheCalls == 0, "revoked token continued to read");
        reset(); scenario.changeTokenOnNodeRead = true; waitFails(waitInput(), "authorization_changed");
        reset(); scenario.expireOnNodeRead = true; waitFails(waitInput(), "timeout");
        check(scenario.recycled > 0, "timeout leaked roots");
        reset(); scenario.interruptOnNodeRead = true; waitFails(waitInput(), "interrupted");
        check(Thread.currentThread().isInterrupted(), "interrupt flag lost"); Thread.interrupted();
        reset(); Thread.currentThread().interrupt(); waitFails(waitInput(), "interrupted"); Thread.interrupted();
        reset(); scenario.cacheCleared = false; waitFails(waitInput(), "cache_clear_failed");
        check(scenario.windowReads == 0, "failed cache clear continued to enumerate");
        reset(); scenario.cacheThrows = true; waitFails(waitInput(), "read_failed");
        reset(); waitFails(waitInput().put("packageName", "different.app"), "incomplete");
        reset(); waitFails(waitInput().put("display", new JSONObject().put("width", 101).put("height", 200).put("rotation", 0)), "display_changed");
        window = reset(); window.root = null; waitFails(waitInput().put("state", "absent"), "incomplete");
        window = reset(); window.root.children.add(null); waitFails(waitInput().put("state", "absent"), "incomplete");
        window = reset(); window.root.children.add(new AccessibilityNodeInfo()); waitFails(waitInput(), "ambiguous");
        window = reset(); window.root.emptyBounds = true; waitFails(waitInput().put("state", "absent"), "incomplete");
        window = reset(); window.root.readFailure = true; waitFails(waitInput().put("state", "absent"), "read_failed");
        window = reset(); SystemClock.step = 0; window.root.visible = false;
        for (int i = 0; i < MAX_NODES; i++) window.root.children.add(new AccessibilityNodeInfo());
        waitFails(waitInput().put("state", "absent"), "incomplete");
        window = reset(); SystemClock.step = 0; AccessibilityNodeInfo leaf = window.root; leaf.visible = false;
        for (int i = 0; i <= MAX_DEPTH; i++) { AccessibilityNodeInfo child = new AccessibilityNodeInfo(); leaf.children.add(child); leaf = child; }
        waitFails(waitInput().put("state", "absent"), "incomplete");
        window = reset(); AccessibilityWindowInfo replacement = new AccessibilityWindowInfo(); replacement.layer = 1;
        scenario.afterWindows = Arrays.asList(replacement); waitFails(waitInput(), "window_changed");
        reset(); scenario.afterWidth = 101; waitFails(waitInput(), "display_changed");

        reset();
        java.util.concurrent.CountDownLatch held = new java.util.concurrent.CountDownLatch(1), release = new java.util.concurrent.CountDownLatch(1);
        Thread holder = new Thread(() -> { READS.lock(); try { held.countDown(); release.await(); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); } finally { READS.unlock(); } });
        holder.start(); held.await();
        try {
            waitFails(waitInput(), "busy");
            check(!snapshot(new AccessibilityService()).getJSONObject("helperObservation").getBoolean("complete"), "busy snapshot was accepted");
            check(scenario.cacheCalls == 0 && scenario.windowReads == 0, "busy read queued instead of refusing");
        } finally { release.countDown(); holder.join(1000); }
        reset(); check(waitCall(waitInput()).getString("status").equals("ready"), "lock leaked after failure");
        System.out.println("bounded condition wait hints checked; authorization and read failures rejected");
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
        waitChecks();
    }
}

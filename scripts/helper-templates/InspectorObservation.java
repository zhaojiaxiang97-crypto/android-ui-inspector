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
import java.util.EnumMap;
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
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import java.nio.charset.StandardCharsets;

/** Inspector-only read protocol. No actions, token management, or upstream endpoint changes. */
public final class InspectorObservation {
    private static final Map<AccessibilityService, String> INSTANCES = new WeakHashMap<>();
    private static final ExecutorService SCREENSHOTS = Executors.newSingleThreadExecutor();
    private static final ReentrantLock READS = new ReentrantLock();
    private static InputCapture inputCapture;
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
        flags.put("screenshot", screenshot).put("losslessScreenshot", screenshot).put("guardedInput", true);
        return new JSONObject().put("success", true).put("protocolVersion", 1)
                .put("serviceInstanceId", instanceId(service)).put("capabilities", flags)
                .put("screenshotFormat", "png").put("visibility", "explicit-clipped");
    }

    private static final class WaitFailure extends Exception {
        final String code;
        WaitFailure(String code) { this.code = code; }
    }

    static void waitKeys(JSONObject value, String... allowed) throws Exception {
        Set<String> keys = new HashSet<>();
        Collections.addAll(keys, allowed);
        for (java.util.Iterator<String> iterator = value.keys(); iterator.hasNext();)
            if (!keys.contains(iterator.next())) throw new WaitFailure("invalid_request");
    }

    static String waitText(JSONObject value, String key, int maximum) throws Exception {
        Object item = value.get(key);
        if (!(item instanceof String) || ((String) item).isEmpty() || ((String) item).length() > maximum)
            throw new WaitFailure("invalid_request");
        return (String) item;
    }

    static long waitInteger(JSONObject value, String key, long minimum, long maximum) throws Exception {
        Object item = value.get(key);
        if (!(item instanceof Number)) throw new WaitFailure("invalid_request");
        Number number = (Number) item;
        long result = number.longValue();
        if (number.doubleValue() != result || result < minimum || result > maximum) throw new WaitFailure("invalid_request");
        return result;
    }

    static String waitUuid(JSONObject value, String key) throws Exception {
        String text = waitText(value, key, 36);
        if (!text.matches("(?i)([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)"))
            throw new WaitFailure("invalid_request");
        return text;
    }

    private static final class WaitRequest {
        final JSONObject input, selector, expectedDisplay;
        final String sessionId, requestId, serviceId, packageName, state;
        final long deadline;
        final BooleanSupplier authenticated;
        int matches, nodes;
        boolean enabled;

        WaitRequest(String body, long started, BooleanSupplier authenticated) throws Exception {
            if (body == null || body.getBytes(StandardCharsets.UTF_8).length > 4096) throw new WaitFailure("invalid_request");
            input = new JSONObject(body);
            waitKeys(input, "version", "sessionId", "requestId", "serviceInstanceId", "packageName", "selector", "state", "display", "timeoutMs");
            waitInteger(input, "version", 1, 1);
            sessionId = waitUuid(input, "sessionId"); requestId = waitUuid(input, "requestId");
            serviceId = waitUuid(input, "serviceInstanceId");
            packageName = waitText(input, "packageName", 256);
            if (!packageName.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")) throw new WaitFailure("invalid_request");
            state = waitText(input, "state", 8);
            if (!state.equals("visible") && !state.equals("absent") && !state.equals("enabled") && !state.equals("disabled"))
                throw new WaitFailure("invalid_request");
            selector = input.getJSONObject("selector");
            waitKeys(selector, "resourceId", "text", "contentDesc", "className");
            if (selector.length() < 1) throw new WaitFailure("invalid_request");
            for (java.util.Iterator<String> keys = selector.keys(); keys.hasNext();) waitText(selector, keys.next(), 512);
            expectedDisplay = input.getJSONObject("display");
            waitKeys(expectedDisplay, "width", "height", "rotation");
            waitInteger(expectedDisplay, "width", 1, 16384); waitInteger(expectedDisplay, "height", 1, 16384);
            waitInteger(expectedDisplay, "rotation", 0, 3);
            deadline = started + waitInteger(input, "timeoutMs", 50, 1000);
            this.authenticated = authenticated;
        }

        void check(AccessibilityService service) throws Exception {
            if (Thread.currentThread().isInterrupted()) throw new WaitFailure("interrupted");
            if (SystemClock.elapsedRealtime() >= deadline) throw new WaitFailure("timeout");
            if (!authenticated.getAsBoolean()) throw new WaitFailure("authorization_changed");
            if (!serviceId.equals(instanceId(service))) throw new WaitFailure("service_changed");
        }
    }

    private static boolean waitSameDisplay(JSONObject first, JSONObject second) throws Exception {
        return first.getInt("width") == second.getInt("width") && first.getInt("height") == second.getInt("height")
                && first.getInt("rotation") == second.getInt("rotation");
    }

    static final class InputBoundaryFailure extends Exception {
        final String code;
        InputBoundaryFailure(String code) { this.code = code; }
    }

    private static final class InputCapture {
        final String serviceId, captureId, packageName, windowId, windows;
        final int width, height, rotation;
        final long completedAtMs;
        boolean consumed;
        InputCapture(JSONObject metadata, long completedAtMs) throws Exception {
            serviceId = metadata.getString("serviceInstanceId"); captureId = metadata.getString("captureId");
            packageName = metadata.getString("packageName"); windowId = metadata.getString("windowId");
            windows = metadata.getJSONArray("windowsAfter").toString();
            JSONObject frame = metadata.getJSONObject("displayAfter");
            width = frame.getInt("width"); height = frame.getInt("height"); rotation = frame.getInt("rotation");
            this.completedAtMs = completedAtMs;
        }
    }

    static String inputServiceId(AccessibilityService service) { return instanceId(service); }

    static final class InputTicket {
        final long expiresAtMs;
        final AccessibilityNodeInfo target;
        InputTicket(long expiresAtMs, AccessibilityNodeInfo target) { this.expiresAtMs = expiresAtMs; this.target = target; }
    }

    /** Immutable input target-scan progress snapshot. Attached only to timeout receipts; never carries node content. */
    static final class InputScanProgress {
        final long scanStartedAtMs;
        final String operation;
        final long operationStartedAtMs;
        final int nodesVisited;
        final int childReadsStarted;
        final int childReadsCompleted;
        final long childReadTotalMs;
        final long childReadMaxMs;
        InputScanProgress(long scanStartedAtMs, String operation, long operationStartedAtMs, int nodesVisited,
                int childReadsStarted, int childReadsCompleted, long childReadTotalMs, long childReadMaxMs) {
            this.scanStartedAtMs = scanStartedAtMs;
            this.operation = operation;
            this.operationStartedAtMs = operationStartedAtMs;
            this.nodesVisited = nodesVisited;
            this.childReadsStarted = childReadsStarted;
            this.childReadsCompleted = childReadsCompleted;
            this.childReadTotalMs = childReadTotalMs;
            this.childReadMaxMs = childReadMaxMs;
        }
    }

    private static final class InputSearch {
        final Set<AccessibilityNodeInfo> visited = new HashSet<>();
        AccessibilityNodeInfo match;
        Rect clip;
        long scanStartedAtMs = -1;
        String operation = "node";
        long operationStartedAtMs = -1;
        int nodesVisited, childReadsStarted, childReadsCompleted;
        long childReadTotalMs, childReadMaxMs;

        void beginScan(java.util.function.Consumer<InputScanProgress> scanProgress) {
            scanStartedAtMs = SystemClock.elapsedRealtime();
            operation = "node";
            operationStartedAtMs = scanStartedAtMs;
            publish(scanProgress);
        }

        void beginNode(java.util.function.Consumer<InputScanProgress> scanProgress) {
            nodesVisited++;
            operation = "node";
            operationStartedAtMs = SystemClock.elapsedRealtime();
            publish(scanProgress);
        }

        long beginChildRead(java.util.function.Consumer<InputScanProgress> scanProgress) {
            childReadsStarted++;
            operation = "child";
            operationStartedAtMs = SystemClock.elapsedRealtime();
            publish(scanProgress);
            return operationStartedAtMs;
        }

        void completeChildRead(long startedAtMs, java.util.function.Consumer<InputScanProgress> scanProgress) {
            // Duration covers only the getChild call; the recursive scan below stays excluded.
            long end = SystemClock.elapsedRealtime();
            long duration = end - startedAtMs;
            childReadsCompleted++;
            childReadTotalMs += duration;
            childReadMaxMs = Math.max(childReadMaxMs, duration);
            operation = "node";
            operationStartedAtMs = end;
            publish(scanProgress);
        }

        private void publish(java.util.function.Consumer<InputScanProgress> scanProgress) {
            if (scanProgress == null) return;
            scanProgress.accept(new InputScanProgress(scanStartedAtMs, operation, operationStartedAtMs,
                    nodesVisited, childReadsStarted, childReadsCompleted, childReadTotalMs, childReadMaxMs));
        }
    }

    /** Consumes only the latest complete capture, with a final fresh window check; no input is performed here. */
    static InputTicket consumeInputCapture(AccessibilityService service, String serviceId, String captureId,
            String packageName, String windowId, JSONObject frame, JSONObject target, int targetAction, long deadline, BooleanSupplier permitted,
            BooleanSupplier enterDispatch, java.util.function.Consumer<String> progress,
            java.util.function.Consumer<InputScanProgress> scanProgress) throws InputBoundaryFailure {
        if (!READS.tryLock()) throw new InputBoundaryFailure("busy");
        Capture current = new Capture();
        InputSearch search = new InputSearch();
        boolean handedOff = false;
        try {
            checkInputRead(service, serviceId, deadline, permitted);
            if (Build.VERSION.SDK_INT < 33) throw new InputBoundaryFailure("unsupported");
            InputCapture last = inputCapture;
            if (last == null || !last.captureId.equals(captureId) || last.consumed) throw new InputBoundaryFailure("capture_changed");
            if (!last.serviceId.equals(serviceId)) throw new InputBoundaryFailure("service_changed");
            long age = SystemClock.elapsedRealtime() - last.completedAtMs;
            if (age < 0 || age > 5000) throw new InputBoundaryFailure("capture_expired");
            if (!last.packageName.equals(packageName) || !last.windowId.equals(windowId)) throw new InputBoundaryFailure("window_changed");
            if (last.width != frame.getInt("width") || last.height != frame.getInt("height") || last.rotation != frame.getInt("rotation"))
                throw new InputBoundaryFailure("display_changed");
            progress.accept("cache_clear");
            if (!service.clearCache()) throw new InputBoundaryFailure("incomplete");
            checkInputRead(service, serviceId, deadline, permitted);
            progress.accept("display_check");
            JSONObject currentDisplay = display(service);
            if (!waitSameDisplay(currentDisplay, frame)) throw new InputBoundaryFailure("display_changed");
            ReadCheck inputCheck = () -> checkInputRead(service, serviceId, deadline, permitted);
            progress.accept("window_inventory");
            enumerateChecked(service, current, target != null, inputCheck);
            checkInputRead(service, serviceId, deadline, permitted);
            if (!current.complete || current.windows.length() > 16 || current.focusedCount != 1) throw new InputBoundaryFailure("incomplete");
            if (!packageName.equals(current.focusedPackage) || !windowId.equals(current.focusedId)
                    || !last.windows.equals(current.windows.toString())) throw new InputBoundaryFailure("window_changed");
            if (target != null) {
                Rect clip = new Rect(0, 0, last.width, last.height);
                progress.accept("target_scan");
                search.beginScan(scanProgress);
                for (int i = 0; i < current.windows.length(); i++) if (windowId.equals(current.windows.getJSONObject(i).getString("id"))) {
                    JSONObject bounds = current.windows.getJSONObject(i).getJSONObject("bounds");
                    clip = intersection(clip, fromJson(bounds));
                    findInputTarget(current.roots.get(i), 0, windowId, packageName, target, targetAction, clip, true, search, inputCheck, scanProgress);
                }
                if (search.match == null) throw new InputBoundaryFailure("window_changed");
                inputCheck.check();
                progress.accept("target_refresh");
                if (!search.match.refresh()) throw new InputBoundaryFailure("window_changed");
                inputCheck.check();
                if (!inputTargetMatches(search.match, windowId, packageName, target)
                        || !inputTargetUsable(search.match, search.clip, true, targetAction)) throw new InputBoundaryFailure("window_changed");
                progress.accept("window_recheck");
                if (!service.clearCache()) throw new InputBoundaryFailure("incomplete");
                Capture after = new Capture();
                enumerateChecked(service, after, false, inputCheck);
                if (!after.complete || after.focusedCount != 1) throw new InputBoundaryFailure("incomplete");
                if (!current.windows.toString().equals(after.windows.toString()) || !windowId.equals(after.focusedId)
                        || !packageName.equals(after.focusedPackage)) throw new InputBoundaryFailure("window_changed");
            }
            progress.accept("final_checks");
            if (!waitSameDisplay(display(service), frame)) throw new InputBoundaryFailure("display_changed");
            checkInputRead(service, serviceId, deadline, permitted);
            if (SystemClock.elapsedRealtime() - last.completedAtMs > 5000) throw new InputBoundaryFailure("capture_expired");
            // Commit under the same lock as snapshot replacement. Until this gate wins, a new capture invalidates the request.
            if (inputCapture != last) throw new InputBoundaryFailure("capture_changed");
            if (!enterDispatch.getAsBoolean()) throw new InputBoundaryFailure("timeout");
            last.consumed = true;
            handedOff = true;
            return new InputTicket(last.completedAtMs + 5000, search.match);
        } catch (InputBoundaryFailure failure) { throw failure; }
        catch (Exception failure) { throw new InputBoundaryFailure("incomplete"); }
        finally {
            for (AccessibilityNodeInfo root : current.roots) HierarchyDumper.safeRecycle(root);
            if (!handedOff) HierarchyDumper.safeRecycle(search.match);
            READS.unlock();
        }
    }

    private static void findInputTarget(AccessibilityNodeInfo node, int depth, String windowId, String packageName,
            JSONObject target, int targetAction, Rect clip, boolean parentVisible, InputSearch search, ReadCheck check,
            java.util.function.Consumer<InputScanProgress> scanProgress) throws Exception {
        check.check();
        if (node == null || depth > MAX_DEPTH || search.visited.size() >= MAX_NODES || !search.visited.add(node)
                || !windowId.equals(Integer.toString(node.getWindowId()))) throw new InputBoundaryFailure("incomplete");
        search.beginNode(scanProgress);
        Rect raw = new Rect(); node.getBoundsInScreen(raw);
        Rect visibleBounds = intersection(raw, clip);
        boolean visible = parentVisible && node.isVisibleToUser() && !visibleBounds.isEmpty();
        if (inputTargetMatches(node, windowId, packageName, target)) {
            if (search.match != null) throw new InputBoundaryFailure("incomplete");
            if (!inputTargetUsable(node, clip, parentVisible, targetAction)) throw new InputBoundaryFailure("window_changed");
            search.match = AccessibilityNodeInfo.obtain(node); search.clip = new Rect(clip);
        }
        int children = node.getChildCount();
        if (children < 0 || children > MAX_NODES) throw new InputBoundaryFailure("incomplete");
        Rect childClip = node.isScrollable() ? visibleBounds : clip;
        for (int i = 0; i < children; i++) {
            check.check();
            AccessibilityNodeInfo child = null;
            try {
                long childStartedAtMs = search.beginChildRead(scanProgress);
                try { child = node.getChild(i, CHILD_PREFETCH_FLAGS); }
                finally { search.completeChildRead(childStartedAtMs, scanProgress); }
                findInputTarget(child, depth + 1, windowId, packageName, target, targetAction, childClip, visible, search, check, scanProgress);
            } finally { HierarchyDumper.safeRecycle(child); }
        }
        check.check();
    }

    private static boolean inputTargetMatches(AccessibilityNodeInfo node, String windowId, String packageName, JSONObject target) throws Exception {
        Rect raw = new Rect(); node.getBoundsInScreen(raw);
        JSONObject bounds = target.getJSONObject("bounds");
        return windowId.equals(Integer.toString(node.getWindowId())) && packageName.equals(string(node.getPackageName()))
                && (target.has("resourceId") ? target.getString("resourceId").equals(string(node.getViewIdResourceName()))
                    : string(node.getViewIdResourceName()).isEmpty())
                && target.getString("className").equals(string(node.getClassName()))
                && (!target.has("text") || target.getString("text").equals(string(node.getText())))
                && (!target.has("contentDesc") || target.getString("contentDesc").equals(string(node.getContentDescription())))
                && raw.left == bounds.getInt("left") && raw.top == bounds.getInt("top")
                && raw.right == bounds.getInt("right") && raw.bottom == bounds.getInt("bottom");
    }

    private static boolean inputTargetUsable(AccessibilityNodeInfo node, Rect clip, boolean parentVisible, int action) {
        Rect raw = new Rect(); node.getBoundsInScreen(raw); Rect visible = intersection(raw, clip);
        boolean actionable = action == AccessibilityNodeInfo.ACTION_CLICK ? node.isClickable()
                : node.isScrollable() && supportsAction(node, action);
        return parentVisible && node.isVisibleToUser() && node.isEnabled() && actionable && !raw.isEmpty()
                && raw.left == visible.left && raw.top == visible.top && raw.right == visible.right && raw.bottom == visible.bottom;
    }

    private static boolean supportsAction(AccessibilityNodeInfo node, int actionId) {
        List<AccessibilityNodeInfo.AccessibilityAction> actions = node.getActionList();
        if (actions == null || actions.size() > 128) throw new IllegalStateException("Action list unavailable");
        for (AccessibilityNodeInfo.AccessibilityAction action : actions) {
            if (action == null) throw new IllegalStateException("Action unavailable");
            if (action.getId() == actionId) return true;
        }
        return false;
    }

    private static void checkInputRead(AccessibilityService service, String serviceId, long deadline,
            BooleanSupplier permitted) throws InputBoundaryFailure {
        if (Thread.currentThread().isInterrupted() || SystemClock.elapsedRealtime() >= deadline) throw new InputBoundaryFailure("timeout");
        if (!permitted.getAsBoolean()) throw new InputBoundaryFailure("authorization_changed");
        if (!serviceId.equals(instanceId(service))) throw new InputBoundaryFailure("service_changed");
    }

    /** A scheduling hint only: no screenshots, assertion proof, input, or desktop grant. */
    public static JSONObject waitForCondition(AccessibilityService service, String body, BooleanSupplier authenticated) throws Exception {
        long started = SystemClock.elapsedRealtime();
        try {
            final WaitRequest request;
            try { request = new WaitRequest(body, started, authenticated); }
            catch (Exception invalid) { throw new WaitFailure("invalid_request"); }
            if (Build.VERSION.SDK_INT < 33) throw new WaitFailure("unsupported");
            String inventory = null, windowId = null;
            for (int attempt = 1; attempt <= 8; attempt++) {
                request.check(service);
                long probeStarted = SystemClock.elapsedRealtime();
                if (!READS.tryLock()) throw new WaitFailure("busy");
                boolean ready;
                Capture before = new Capture(), after = new Capture();
                try {
                    request.check(service);
                    if (!service.clearCache()) throw new WaitFailure("cache_clear_failed");
                    request.check(service);
                    JSONObject displayBefore = display(service);
                    if (!waitSameDisplay(displayBefore, request.expectedDisplay)) throw new WaitFailure("display_changed");
                    enumerate(service, before, true, request);
                    request.check(service);
                    if (!before.complete || before.windows.length() > 16 || before.focusedCount != 1 || !request.packageName.equals(before.focusedPackage))
                        throw new WaitFailure("incomplete");
                    request.matches = 0; request.nodes = 0;
                    Rect screen = new Rect(0, 0, displayBefore.getInt("width"), displayBefore.getInt("height"));
                    for (int i = 0; i < before.roots.size(); i++) {
                        JSONObject window = before.windows.getJSONObject(i);
                        waitNode(before.roots.get(i), 0, window.getString("id"),
                                intersection(screen, fromJson(window.getJSONObject("bounds"))), true, request, service);
                    }
                    request.check(service);
                    enumerate(service, after, false, request);
                    if (!after.complete || after.focusedCount != 1 || !request.packageName.equals(after.focusedPackage))
                        throw new WaitFailure("incomplete");
                    String current = before.windows.toString();
                    if (!current.equals(after.windows.toString()) || (inventory != null && !inventory.equals(current)))
                        throw new WaitFailure("window_changed");
                    if (!waitSameDisplay(displayBefore, display(service))) throw new WaitFailure("display_changed");
                    inventory = current; windowId = before.focusedId;
                    request.check(service);
                    ready = request.state.equals("absent") ? request.matches == 0 : request.matches == 1
                            && (request.state.equals("visible") || request.enabled == request.state.equals("enabled"));
                } finally {
                    for (AccessibilityNodeInfo root : before.roots) HierarchyDumper.safeRecycle(root);
                    READS.unlock();
                }
                request.check(service);
                long finished = SystemClock.elapsedRealtime();
                if (finished >= request.deadline) throw new WaitFailure("timeout");
                // A complete false probe may yield to the host before the next read would exhaust this slice.
                boolean sliceFull = request.deadline - finished <= Math.max(50, finished - probeStarted + 50);
                if (ready || attempt == 8 || sliceFull) return new JSONObject().put("success", true).put("protocolVersion", 1)
                        .put("sessionId", request.sessionId).put("requestId", request.requestId)
                        .put("serviceInstanceId", request.serviceId).put("packageName", request.packageName)
                        .put("windowId", windowId).put("display", request.expectedDisplay)
                        .put("status", ready ? "ready" : "pending").put("matchCount", request.matches)
                        .put("attempts", attempt).put("startedAtMs", started).put("finishedAtMs", finished);
                try { Thread.sleep(Math.min(50, Math.max(1, request.deadline - SystemClock.elapsedRealtime()))); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new WaitFailure("interrupted"); }
            }
            throw new WaitFailure("timeout");
        } catch (WaitFailure failure) {
            return new JSONObject().put("success", false).put("errorCode", failure.code);
        } catch (Exception failure) {
            return new JSONObject().put("success", false).put("errorCode", "read_failed");
        }
    }

    private static void waitNode(AccessibilityNodeInfo node, int depth, String windowId, Rect clip,
            boolean parentVisible, WaitRequest request, AccessibilityService service) throws Exception {
        request.check(service);
        if (node == null || depth > MAX_DEPTH || request.nodes >= MAX_NODES) throw new WaitFailure("incomplete");
        request.nodes++;
        if (!windowId.equals(Integer.toString(node.getWindowId()))) throw new WaitFailure("incomplete");
        Rect raw = new Rect(); node.getBoundsInScreen(raw);
        Rect visibleBounds = intersection(raw, clip);
        boolean visibleFlag = parentVisible && node.isVisibleToUser();
        boolean visible = visibleFlag && !visibleBounds.isEmpty();
        JSONObject selector = request.selector;
        boolean matched = request.packageName.equals(string(node.getPackageName()))
                && (!selector.has("resourceId") || selector.getString("resourceId").equals(string(node.getViewIdResourceName())))
                && (!selector.has("text") || selector.getString("text").equals(string(node.getText())))
                && (!selector.has("contentDesc") || selector.getString("contentDesc").equals(string(node.getContentDescription())))
                && (!selector.has("className") || selector.getString("className").equals(string(node.getClassName())));
        if (matched && visibleFlag && raw.isEmpty()) throw new WaitFailure("incomplete");
        if (visible && matched) {
            if (++request.matches > 1) throw new WaitFailure("ambiguous");
            request.enabled = node.isEnabled();
        }
        Rect childClip = node.isScrollable() ? visibleBounds : clip;
        int children = node.getChildCount();
        request.check(service);
        for (int i = 0; i < children; i++) {
            request.check(service);
            AccessibilityNodeInfo child = null;
            try {
                child = node.getChild(i, CHILD_PREFETCH_FLAGS);
                waitNode(child, depth + 1, windowId, childClip, visible, request, service);
            } finally { HierarchyDumper.safeRecycle(child); }
        }
        request.check(service);
    }

    private static final class Capture {
        // Only these protocol codes can leave the device. Exception messages,
        // node text and arbitrary keys never enter the diagnostics envelope.
        enum Reason {
            windows_unavailable, duplicate_window_id, non_default_display,
            window_root_unavailable, window_root_mismatch, window_bounds_invalid,
            window_id_invalid, window_type_unknown, window_read_failed,
            node_window_mismatch, child_unavailable, node_read_failed,
            tree_truncated, display_changed, window_inventory_changed, focus_invalid,
            screenshot_size_mismatch, cache_clear_failed, capture_exception
        }
        static final class DiagnosedFailure extends IllegalStateException {}
        private static final int MAX_REASON_COUNT = 10000;
        final Map<Reason, Integer> reasons = new EnumMap<>(Reason.class);
        boolean complete = true;
        boolean truncated = false;
        int nodes = 0;
        final List<AccessibilityNodeInfo> roots = new ArrayList<>();
        final JSONArray windows = new JSONArray();
        final List<String> trees = new ArrayList<>();
        SnapshotTimings snapshotTimings;
        Runnable checkpoint;
        void check() { if (checkpoint != null) checkpoint.run(); }
        String focusedId = "";
        String focusedPackage = "";
        int focusedCount = 0;

        void fail(Reason reason) {
            complete = false;
            int count = reasons.containsKey(reason) ? reasons.get(reason) : 0;
            reasons.put(reason, Math.min(MAX_REASON_COUNT, count + 1));
        }

        int combinedCount(Reason reason, Capture other) {
            int first = reasons.containsKey(reason) ? reasons.get(reason) : 0;
            int second = other.reasons.containsKey(reason) ? other.reasons.get(reason) : 0;
            return Math.min(MAX_REASON_COUNT, first + second);
        }
    }

    /** Optional numeric response-header diagnostics. Never part of observation evidence or authorization. */
    public static final class SnapshotTimings {
        private static final long MAX_NANOS = 60000000000L;
        private final java.util.function.LongSupplier clock;
        private final long workerStarted;
        private final long queueNanos;
        private long observationStarted;
        private long preObservationNanos = -1, observationNanos = -1;
        private long jsonSerializationNanos = -1, utf8EncodingNanos = -1;
        private long cacheClearNanos = -1, initialWindowReadNanos = -1;
        private long getChildNanos = -1, nodeLocalNanos = -1;
        private boolean valid = true;

        public SnapshotTimings(long submitted, long workerStarted) { this(submitted, workerStarted, System::nanoTime); }
        SnapshotTimings(long submitted, long workerStarted, java.util.function.LongSupplier clock) {
            this.clock = clock;
            this.workerStarted = workerStarted;
            this.queueNanos = duration(submitted, workerStarted);
        }
        long now() { return clock.getAsLong(); }
        private long duration(long start, long end) {
            long value = end - start;
            if (value < 0 || value > MAX_NANOS) { valid = false; return 0; }
            return value;
        }
        long elapsed(long start) { return duration(start, now()); }
        public void startObservation() {
            observationStarted = now();
            preObservationNanos = duration(workerStarted, observationStarted);
        }
        public void finishObservation() { observationNanos = elapsed(observationStarted); }
        void startHierarchy() { getChildNanos = nodeLocalNanos = 0; }
        void addChild(long value) { getChildNanos = accumulated(getChildNanos, value); }
        void addLocal(long value) { nodeLocalNanos = accumulated(nodeLocalNanos, value); }
        private long accumulated(long previous, long value) {
            if (previous < 0 || value < 0 || value > MAX_NANOS - previous) { valid = false; return 0; }
            return previous + value;
        }
        /** Serialize the response body and encode its UTF-8 bytes exactly once. */
        public byte[] serialize(JSONObject json) {
            return serialize(json, JSONObject::toString);
        }
        public byte[] serialize(JSONObject json, java.util.function.Function<JSONObject, String> serializer) {
            long started = now();
            String text;
            try { text = serializer.apply(json); }
            finally { jsonSerializationNanos = elapsed(started); }
            started = now();
            try { return text.getBytes(java.nio.charset.StandardCharsets.UTF_8); }
            finally { utf8EncodingNanos = elapsed(started); }
        }
        private static String milliseconds(long nanos) {
            long micros = nanos / 1000;
            return (micros / 1000) + "." + Long.toString(1000 + micros % 1000).substring(1);
        }
        public String header() {
            if (!valid || preObservationNanos < 0 || observationNanos < 0 || jsonSerializationNanos < 0 || utf8EncodingNanos < 0)
                return null;
            long measured = Math.max(0, cacheClearNanos) + Math.max(0, initialWindowReadNanos)
                    + Math.max(0, getChildNanos) + Math.max(0, nodeLocalNanos);
            if (measured > observationNanos) return null;
            StringBuilder header = new StringBuilder("v=1");
            String[] names = { "queueMs", "preObservationMs", "observationMs", "jsonSerializationMs", "utf8EncodingMs",
                    "cacheClearMs", "initialWindowReadMs", "getChildMs", "nodeLocalMs" };
            long[] values = { queueNanos, preObservationNanos, observationNanos, jsonSerializationNanos, utf8EncodingNanos,
                    cacheClearNanos, initialWindowReadNanos, getChildNanos, nodeLocalNanos };
            for (int i = 0; i < values.length; i++) if (values[i] >= 0) header.append(';').append(names[i]).append('=').append(milliseconds(values[i]));
            return header.length() <= 512 ? header.toString() : null;
        }
    }

    /** Serializes concurrent clients. Tree then PNG is ordered, never a same-frame claim. */
    public static JSONObject snapshot(AccessibilityService service) throws Exception {
        return snapshot(service, null);
    }

    static JSONObject snapshot(AccessibilityService service, SnapshotTimings snapshotTimings) throws Exception {
        boolean acquired = READS.tryLock();
        try { return snapshotLocked(service, acquired, snapshotTimings); }
        finally { if (acquired) READS.unlock(); }
    }

    private static JSONObject snapshotLocked(AccessibilityService service, boolean acquired, SnapshotTimings snapshotTimings) throws Exception {
        return snapshotLocked(service, acquired, snapshotTimings, null);
    }

    static JSONObject controlledSnapshot(AccessibilityService service, SnapshotTimings timings, Runnable checkpoint) throws Exception {
        boolean acquired = READS.tryLock();
        try { return snapshotLocked(service, acquired, timings, checkpoint); }
        finally { if (acquired) READS.unlock(); }
    }

    private static InputCapture pendingControlledCapture;

    static void publishControlledSnapshot(JSONObject result, java.util.function.Consumer<Runnable> completion) throws Exception {
        if (!READS.tryLock()) throw new IllegalStateException("Read busy");
        try {
            final InputCapture pending = pendingControlledCapture;
            if (pending == null || !pending.captureId.equals(result.getJSONObject("helperObservation").getString("captureId")))
                throw new IllegalStateException("Read superseded");
            completion.accept(() -> { inputCapture = pending; pendingControlledCapture = null; });
        } finally { READS.unlock(); }
    }

    private static JSONObject snapshotLocked(AccessibilityService service, boolean acquired, SnapshotTimings snapshotTimings, Runnable checkpoint) throws Exception {
        long started = SystemClock.elapsedRealtime();
        if (acquired) { inputCapture = null; pendingControlledCapture = null; }
        Capture before = new Capture();
        before.snapshotTimings = snapshotTimings;
        before.checkpoint = checkpoint;
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
            if (!acquired) throw new Capture.DiagnosedFailure();
            before.check();
            // Root queries bypass the framework cache, but descendant queries may reuse it.
            // Clear once per observation while keeping descendant prefetch enabled. This does
            // not make the tree and screenshot atomic or refresh the app's own node provider.
            // API 30-32 retain their existing behavior; freshness there is not verified.
            long cacheStarted = snapshotTimings == null ? 0 : snapshotTimings.now();
            if (Build.VERSION.SDK_INT >= 33) {
                try {
                    if (!service.clearCache()) throw new Capture.DiagnosedFailure();
                } catch (Exception error) {
                    before.fail(Capture.Reason.cache_clear_failed);
                    throw new Capture.DiagnosedFailure();
                } finally { if (snapshotTimings != null) snapshotTimings.cacheClearNanos = snapshotTimings.elapsed(cacheStarted); }
            }
            long windowsStarted = snapshotTimings == null ? 0 : snapshotTimings.now();
            JSONObject displayBefore;
            try {
                displayBefore = display(service);
                metadata.put("displayBefore", displayBefore);
                enumerate(service, before, true);
            } finally { if (snapshotTimings != null) snapshotTimings.initialWindowReadNanos = snapshotTimings.elapsed(windowsStarted); }
            metadata.put("windowsBefore", before.windows);
            before.check();
            metadata.put("windowId", before.focusedId).put("packageName", before.focusedPackage);
            timing.put("hierarchyStartedAtMs", SystemClock.elapsedRealtime());
            if (snapshotTimings != null) snapshotTimings.startHierarchy();
            Rect displayClip = new Rect(0, 0, displayBefore.getInt("width"), displayBefore.getInt("height"));
            for (int i = 0; i < before.roots.size(); i++) {
                AccessibilityNodeInfo root = before.roots.get(i);
                JSONObject window = before.windows.getJSONObject(i);
                if (root == null) continue;
                Rect clip = intersection(displayClip, fromJson(window.getJSONObject("bounds")));
                before.trees.add(node(root, 0, i, window.getString("id"), window, clip, true, before));
            }
            timing.put("hierarchyCompletedAtMs", SystemClock.elapsedRealtime());
            before.check();
            timing.put("screenshotStartedAtMs", SystemClock.elapsedRealtime());
            if (Build.VERSION.SDK_INT < 30) throw new IllegalStateException("Screenshot requires Android 11 or newer");
            Screenshot shot = takeScreenshot(service);
            bitmap = shot.bitmap;
            before.check();
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
            boolean sameDisplay = displayBefore.toString().equals(displayAfter.toString());
            boolean sameWindows = before.windows.toString().equals(after.windows.toString());
            boolean validFocus = before.focusedCount == 1 && after.focusedCount == 1
                    && !before.focusedPackage.isEmpty();
            boolean sameScreenshotSize = bitmap.getWidth() == displayBefore.getInt("width")
                    && bitmap.getHeight() == displayBefore.getInt("height");
            if (!sameDisplay) before.fail(Capture.Reason.display_changed);
            if (!sameWindows) before.fail(Capture.Reason.window_inventory_changed);
            if (!validFocus) before.fail(Capture.Reason.focus_invalid);
            if (!sameScreenshotSize) before.fail(Capture.Reason.screenshot_size_mismatch);
            boolean stable = sameDisplay && sameWindows && validFocus && sameScreenshotSize;
            postProcessing.put("windowValidationCompletedAtMs", SystemClock.elapsedRealtime());
            StringBuilder xml = new StringBuilder("<?xml version='1.0' encoding='UTF-8'?>\n<hierarchy rotation=\"")
                    .append(displayBefore.getInt("rotation")).append("\">");
            for (String tree : before.trees) xml.append(tree);
            xml.append("</hierarchy>");
            postProcessing.put("pngEncodingStartedAtMs", SystemClock.elapsedRealtime());
            before.check();
            byte[] pngBytes = InspectorPngEncoder.encode(bitmap);
            before.check();
            postProcessing.put("pngEncodingCompletedAtMs", SystemClock.elapsedRealtime());
            postProcessing.put("base64EncodingStartedAtMs", SystemClock.elapsedRealtime());
            String screenshotBase64 = Base64.encodeToString(pngBytes, Base64.NO_WRAP);
            before.check();
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
            if (!(error instanceof Capture.DiagnosedFailure)) before.fail(Capture.Reason.capture_exception);
            result.put("error", "Observation failed");
        } finally {
            if (bitmap != null) {
                try { bitmap.recycle(); }
                catch (Exception error) { before.fail(Capture.Reason.capture_exception); }
            }
            for (AccessibilityNodeInfo root : before.roots) HierarchyDumper.safeRecycle(root);
            // Merge before/after counts once. A later failure must not replace an
            // earlier cause, and one reason is emitted at most once.
            JSONArray reasons = new JSONArray();
            for (Capture.Reason reason : Capture.Reason.values()) {
                int count = before.combinedCount(reason, after);
                if (count > 0) reasons.put(new JSONObject().put("code", reason.name()).put("count", count));
            }
            metadata.put("diagnostics", new JSONObject().put("version", 1).put("reasons", reasons));
            if (!before.complete || !after.complete) metadata.put("complete", false);
            long completedAt = SystemClock.elapsedRealtime();
            timing.put("completedAtMs", completedAt);
            before.check();
            if (acquired && result.getBoolean("success") && metadata.getBoolean("complete")) {
                InputCapture captured = new InputCapture(metadata, completedAt);
                if (checkpoint == null) inputCapture = captured;
                else pendingControlledCapture = captured;
            }
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
        enumerate(service, capture, retain, null);
    }

    @SuppressWarnings("deprecation")
    private static void enumerate(AccessibilityService service, Capture capture, boolean retain, WaitRequest request) throws Exception {
        enumerateChecked(service, capture, retain, request == null ? null : () -> request.check(service));
    }

    private interface ReadCheck { void check() throws Exception; }

    @SuppressWarnings("deprecation")
    private static void enumerateChecked(AccessibilityService service, Capture capture, boolean retain, ReadCheck check) throws Exception {
        if (check != null) check.check();
        List<AccessibilityWindowInfo> supplied;
        try { supplied = service.getWindows(); }
        catch (Exception error) { capture.fail(Capture.Reason.window_read_failed); return; }
        if (check != null) check.check();
        if (supplied == null || supplied.isEmpty()) { capture.fail(Capture.Reason.windows_unavailable); return; }
        List<AccessibilityWindowInfo> windows = new ArrayList<>(supplied);
        Set<Integer> ids = new HashSet<>();
        try {
            if (check != null && windows.size() > 16) { capture.fail(Capture.Reason.window_read_failed); return; }
            try { Collections.sort(windows, Comparator.comparingInt(AccessibilityWindowInfo::getId)); }
            catch (Exception error) { capture.fail(Capture.Reason.window_read_failed); return; }
            for (AccessibilityWindowInfo window : windows) {
                if (check != null) check.check();
                AccessibilityNodeInfo root = null;
                JSONObject entry = new JSONObject();
                try {
                    int id = window.getId();
                    if (!ids.add(id)) capture.fail(Capture.Reason.duplicate_window_id);
                    Rect bounds = new Rect();
                    window.getBoundsInScreen(bounds);
                    String type = windowType(window.getType());
                    entry.put("id", Integer.toString(id)).put("type", type).put("layer", window.getLayer())
                            .put("active", window.isActive()).put("focused", window.isFocused()).put("bounds", rectJson(bounds));
                    if (Build.VERSION.SDK_INT >= 30 && window.getDisplayId() != Display.DEFAULT_DISPLAY)
                        capture.fail(Capture.Reason.non_default_display);
                    root = Build.VERSION.SDK_INT >= 33 ? window.getRoot(1 << 3) : window.getRoot();
                    String pkg = root == null ? "" : string(root.getPackageName());
                    entry.put("rootAvailable", root != null).put("packageName", pkg);
                    if (root == null) capture.fail(Capture.Reason.window_root_unavailable);
                    else if (root.getWindowId() != id) capture.fail(Capture.Reason.window_root_mismatch);
                    if (bounds.isEmpty()) capture.fail(Capture.Reason.window_bounds_invalid);
                    if (id < 0) capture.fail(Capture.Reason.window_id_invalid);
                    if (type.equals("unknown")) capture.fail(Capture.Reason.window_type_unknown);
                    if (window.isFocused() && type.equals("application")) {
                        capture.focusedCount++;
                        capture.focusedId = Integer.toString(id);
                        capture.focusedPackage = pkg;
                    }
                } catch (Exception error) {
                    capture.fail(Capture.Reason.window_read_failed);
                    entry.put("rootAvailable", false);
                }
                capture.windows.put(entry);
                if (retain) capture.roots.add(root); else HierarchyDumper.safeRecycle(root);
            }
        } finally {
            for (AccessibilityWindowInfo window : windows) {
                try { if (window != null) window.recycle(); }
                catch (Exception error) { capture.fail(Capture.Reason.window_read_failed); }
            }
        }
    }

    private static String node(AccessibilityNodeInfo node, int depth, int index, String windowId, JSONObject windowMetadata,
            Rect clip, boolean parentVisible, Capture capture) {
        capture.check();
        SnapshotTimings profile = capture.snapshotTimings;
        long started = profile == null ? 0 : profile.now();
        long directChildNanos = 0, recursiveNanos = 0;
        try {
        if (depth > MAX_DEPTH || capture.nodes >= MAX_NODES) {
            capture.truncated = true;
            capture.fail(Capture.Reason.tree_truncated);
            return "";
        }
        capture.nodes++;
        StringBuilder xml = new StringBuilder("<node");
        try {
            Rect raw = new Rect();
            node.getBoundsInScreen(raw);
            Rect visibleBounds = intersection(raw, clip);
            boolean visible = parentVisible && node.isVisibleToUser() && !visibleBounds.isEmpty();
            if (!windowId.equals(Integer.toString(node.getWindowId()))) capture.fail(Capture.Reason.node_window_mismatch);
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
            XmlUtils.appendBooleanAttribute(xml, "scroll-forward-supported", supportsAction(node, AccessibilityNodeInfo.ACTION_SCROLL_FORWARD));
            XmlUtils.appendBooleanAttribute(xml, "scroll-backward-supported", supportsAction(node, AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD));
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
                capture.check();
                AccessibilityNodeInfo child = null;
                try {
                    long childStarted = profile == null ? 0 : profile.now();
                    try { child = Build.VERSION.SDK_INT >= 33 ? node.getChild(i, CHILD_PREFETCH_FLAGS) : node.getChild(i); }
                    finally { if (profile != null) {
                        long duration = profile.elapsed(childStarted);
                        directChildNanos += duration;
                        profile.addChild(duration);
                    } }
                    if (child == null) capture.fail(Capture.Reason.child_unavailable);
                    else {
                        long recursiveStarted = profile == null ? 0 : profile.now();
                        String childXml;
                        try { childXml = node(child, depth + 1, i, windowId, null, childClip, visible, capture); }
                        finally { if (profile != null) recursiveNanos += profile.elapsed(recursiveStarted); }
                        xml.append(childXml);
                    }
                } catch (Exception error) { capture.fail(Capture.Reason.node_read_failed); }
                finally { HierarchyDumper.safeRecycle(child); }
            }
            xml.append("</node>");
            return xml.toString();
        } catch (Exception error) {
            capture.fail(Capture.Reason.node_read_failed);
            return "";
        }
        } finally {
            if (profile != null) profile.addLocal(profile.elapsed(started) - directChildNanos - recursiveNanos);
            capture.check();
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

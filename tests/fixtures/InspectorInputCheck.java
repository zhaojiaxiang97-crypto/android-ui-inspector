import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BooleanSupplier;

/** Runs production input and observation methods against deterministic platform adapters. */
public class InspectorInputCheck extends InspectorObservationDiagnosticsCheck {
    static class InspectorObservation extends InspectorObservationDiagnosticsCheck {}
    static class Looper { static Looper getMainLooper() { return new Looper(); } }
    static class Handler {
        static boolean blocked, asynchronous, reject;
        static final List<Runnable> queued = new CopyOnWriteArrayList<>();
        static final List<Thread> workers = new CopyOnWriteArrayList<>();
        static Runnable last;
        Handler(Looper looper) {}
        boolean post(Runnable runnable) {
            last = runnable;
            if (reject) return false;
            if (blocked) queued.add(runnable);
            else if (asynchronous) { Thread worker = new Thread(runnable); workers.add(worker); worker.start(); }
            else runnable.run();
            return true;
        }
        void removeCallbacks(Runnable runnable) { queued.remove(runnable); }
        static void drain() { for (Runnable runnable : new ArrayList<>(queued)) { queued.remove(runnable); runnable.run(); } }
    }
    static class Path { final List<Float> coordinates = new ArrayList<>();
        void moveTo(float x, float y) { coordinates.add(x); coordinates.add(y); }
        void lineTo(float x, float y) { coordinates.add(x); coordinates.add(y); }
    }
    static class GestureDescription {
        Path path; long duration; int display;
        static class StrokeDescription { final Path path; final long duration;
            StrokeDescription(Path path, long start, long duration) { this.path = path; this.duration = duration; }
        }
        static class Builder {
            final GestureDescription gesture = new GestureDescription();
            Builder setDisplayId(int id) { gesture.display = id; return this; }
            Builder addStroke(StrokeDescription stroke) { gesture.path = stroke.path; gesture.duration = stroke.duration; return this; }
            GestureDescription build() { return gesture; }
        }
    }
    static class AccessibilityService extends InspectorObservationDiagnosticsCheck.AccessibilityService {
        static final int GLOBAL_ACTION_BACK = 1;
        static class GestureResultCallback {
            public void onCompleted(GestureDescription ignored) {}
            public void onCancelled(GestureDescription ignored) {}
        }
        String mode = "completed";
        int calls, backCalls;
        boolean backAccepted = true;
        boolean touchExploration, magnification, missingManager, missingConfig, environmentThrows;
        GestureResultCallback callback;
        GestureDescription lastGesture;
        Object getSystemService(String key) {
            if (!key.equals(Context.ACCESSIBILITY_SERVICE)) return super.getSystemService(key);
            if (environmentThrows) throw new IllegalStateException(PRIVATE);
            return missingManager ? null : new AccessibilityManager(touchExploration);
        }
        MagnificationController getMagnificationController() { return new MagnificationController(this); }
        boolean dispatchGesture(GestureDescription gesture, GestureResultCallback callback, Handler handler) {
            calls++; this.callback = callback; lastGesture = gesture;
            if (mode.equals("throw")) throw new IllegalStateException(PRIVATE);
            if (mode.equals("rejected")) return false;
            if (mode.equals("completed")) callback.onCompleted(gesture);
            if (mode.equals("cancelled")) callback.onCancelled(gesture);
            return true;
        }
        boolean performGlobalAction(int action) { check(action == GLOBAL_ACTION_BACK, "unsupported global action"); backCalls++; return backAccepted; }
    }
    static class AccessibilityManager {
        final boolean enabled;
        AccessibilityManager(boolean enabled) { this.enabled = enabled; }
        boolean isTouchExplorationEnabled() { return enabled; }
    }
    static class MagnificationController {
        final AccessibilityService service;
        MagnificationController(AccessibilityService service) { this.service = service; }
        MagnificationConfig getMagnificationConfig() { return service.missingConfig ? null : new MagnificationConfig(service.magnification); }
    }
    static class MagnificationConfig {
        final boolean active;
        MagnificationConfig(boolean active) { this.active = active; }
        boolean isActivated() { return active; }
    }

    /* PRODUCTION_INPUT */

    static AccessibilityService fixture() throws Exception {
        for (Thread worker : Handler.workers) worker.join(2500);
        Handler.workers.clear(); Handler.queued.clear(); Handler.blocked = Handler.asynchronous = Handler.reject = false;
        reset(); Build.VERSION.SDK_INT = 34; SystemClock.realTime = true;
        AccessibilityService service = new AccessibilityService(); service.serviceId = UUID.randomUUID().toString();
        return service;
    }
    static JSONObject input(AccessibilityService service) throws Exception {
        JSONObject snapshot = InspectorObservation.snapshot(service);
        check(snapshot.getJSONObject("helperObservation").getBoolean("complete"), "test capture failed");
        JSONObject metadata = snapshot.getJSONObject("helperObservation");
        return new JSONObject().put("version", 1).put("sessionId", "11111111-1111-4111-8111-111111111111")
                .put("requestId", UUID.randomUUID().toString()).put("serviceInstanceId", service.serviceId)
                .put("captureId", metadata.getString("captureId")).put("packageName", "app.test").put("windowId", "7")
                .put("display", new JSONObject().put("width", 100).put("height", 200).put("rotation", 0))
                .put("action", new JSONObject().put("kind", "tap").put("x", 30).put("y", 40));
    }
    static JSONObject call(AccessibilityService service, JSONObject input) throws Exception {
        JSONObject.body = input;
        return InspectorInput.execute(service, input.toString(), () -> scenario.authorized);
    }
    static JSONObject semantic(AccessibilityService service) throws Exception {
        AccessibilityNodeInfo root = scenario.windows.get(0).root;
        root.className = "android.widget.FrameLayout"; root.clickable = false;
        AccessibilityNodeInfo button = new AccessibilityNodeInfo();
        button.className = "android.widget.Button"; button.resourceId = "app.test:id/start"; button.text = "Start|Ready";
        button.contentDesc = ""; button.left = 10; button.top = 20; button.right = 90; button.bottom = 80; root.children.add(button);
        return input(service).put("target", new JSONObject().put("resourceId", button.resourceId).put("className", button.className)
                .put("text", button.text).put("contentDesc", button.contentDesc)
                .put("bounds", new JSONObject().put("left", 10).put("top", 20).put("right", 90).put("bottom", 80)));
    }
    static JSONObject descriptionOnly(AccessibilityService service) throws Exception {
        JSONObject request = semantic(service);
        AccessibilityNodeInfo node = scenario.windows.get(0).root.children.get(0);
        node.resourceId = null; node.className = "androidx.appcompat.app.ActionBar$Tab"; node.text = null; node.contentDesc = "我";
        JSONObject target = request.getJSONObject("target");
        target.values.remove("resourceId"); target.values.remove("text");
        target.put("className", node.className).put("contentDesc", node.contentDesc);
        JSONObject snapshot = InspectorObservation.snapshot(service);
        check(snapshot.getJSONObject("helperObservation").getBoolean("complete"), "description target capture incomplete");
        return request.put("captureId", snapshot.getJSONObject("helperObservation").getString("captureId"));
    }
    static JSONObject scroll(AccessibilityService service, String direction) throws Exception {
        JSONObject request = semantic(service);
        AccessibilityNodeInfo node = scenario.windows.get(0).root.children.get(0);
        node.className = "android.widget.ScrollView"; node.clickable = false; node.scrollable = true;
        node.resourceId = "app.test:id/list"; node.text = "";
        node.actions.add(new AccessibilityNodeInfo.AccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD));
        node.actions.add(new AccessibilityNodeInfo.AccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD));
        request.getJSONObject("target").put("resourceId", node.resourceId).put("className", node.className).put("text", "");
        JSONObject snapshot = InspectorObservation.snapshot(service);
        check(snapshot.getJSONObject("helperObservation").getBoolean("complete"), "scroll capture incomplete");
        String tree = snapshot.getString("xml");
        check(tree.contains("scroll-forward-supported=\"true\"") && tree.contains("scroll-backward-supported=\"true\""), "actual action flags missing from observation");
        return request.put("captureId", snapshot.getJSONObject("helperObservation").getString("captureId"))
                .put("action", new JSONObject().put("kind", "scroll").put("direction", direction));
    }
    static void result(JSONObject reply, String status, String state, String error) {
        check(reply != null && reply.getString("status").equals(status) && reply.getString("dispatchState").equals(state), "wrong receipt: " + reply);
        check(reply.values.size() == (error == null ? 13 : 14), "unexpected receipt fields: " + reply);
        check(Arrays.asList("accessibility-click", "accessibility-scroll", "gesture", "global-back").contains(reply.getString("method")), "missing selected input method");
        if (error != null) check(reply.getString("errorCode").equals(error), "wrong error: " + reply);
        check(!reply.toString().contains(PRIVATE) && !reply.has("action") && !reply.has("success"), "input receipt leaked data");
    }
    static FutureTask<JSONObject> pending(AccessibilityService service, JSONObject input) throws Exception {
        FutureTask<JSONObject> result = new FutureTask<>(() -> call(service, input));
        new Thread(result).start();
        long limit = System.nanoTime() + 500000000L;
        while (Handler.queued.isEmpty() && System.nanoTime() < limit) Thread.sleep(1);
        check(!Handler.queued.isEmpty(), "request did not reach the main queue"); return result;
    }
    public static void main(String[] args) throws Exception {
        AccessibilityService service = fixture(); JSONObject request = input(service);
        JSONObject reply = call(service, request); result(reply, "completed", "sent", null);
        check(service.calls == 1 && service.lastGesture.duration == 60 && service.lastGesture.display == 0, "tap was not sent exactly once");
        check(call(service, request) == reply && service.calls == 1, "same request replayed");
        request.getJSONObject("action").put("x", 31);
        JSONObject conflict = call(service, request);
        check(!conflict.getBoolean("success") && conflict.getString("errorCode").equals("invalid_request") && service.calls == 1,
                "changed request reused identity");
        request.getJSONObject("action").put("x", 30); request.put("requestId", UUID.randomUUID().toString());
        result(call(service, request), "rejected", "not_sent", "capture_changed");
        check(service.calls == 1, "capture consumed twice");

        service = fixture(); request = input(service); service.mode = "rejected";
        long start = System.nanoTime(); result(call(service, request), "rejected", "not_sent", "dispatch_rejected");
        check((System.nanoTime() - start) / 1000000 < 500 && service.calls == 1, "immediate false waited for callback");
        service = fixture(); request = input(service); service.mode = "cancelled";
        result(call(service, request), "cancelled", "unknown", "cancelled"); check(service.calls == 1, "cancelled gesture retried");
        service = fixture(); request = input(service); service.mode = "throw";
        result(call(service, request), "cancelled", "unknown", "dispatch_error");

        service = fixture(); request = input(service); service.touchExploration = true;
        result(call(service, request), "rejected", "not_sent", "unsupported"); check(service.calls == 0, "touch exploration transformed a guarded point");
        service = fixture(); request = input(service); service.magnification = true;
        result(call(service, request), "rejected", "not_sent", "unsupported"); check(service.calls == 0, "active magnification transformed a guarded point");
        service = fixture(); request = input(service); service.missingManager = true;
        result(call(service, request), "rejected", "not_sent", "unsupported");
        service = fixture(); request = input(service); service.missingConfig = true;
        result(call(service, request), "rejected", "not_sent", "unsupported");
        service = fixture(); request = input(service); service.environmentThrows = true;
        result(call(service, request), "rejected", "not_sent", "unsupported");
        service = fixture(); request = input(service); Build.VERSION.SDK_INT = 33;
        result(call(service, request), "rejected", "not_sent", "unsupported"); check(service.calls == 0, "API 33 guessed magnifier activation");
        request.put("requestId", UUID.randomUUID().toString()).put("action", new JSONObject().put("kind", "back"));
        result(call(service, request), "completed", "sent", null); check(service.backCalls == 1, "back inherited the coordinate limitation");

        service = fixture(); request = input(service);
        request.put("action", new JSONObject().put("kind", "swipe").put("fromX", 10).put("fromY", 20)
                .put("toX", 50).put("toY", 90).put("durationMs", 350));
        result(call(service, request), "completed", "sent", null);
        check(service.lastGesture.duration == 350 && service.lastGesture.path.coordinates.equals(Arrays.asList(10f, 20f, 50f, 90f)), "swipe parameters changed");
        service = fixture(); request = input(service).put("action", new JSONObject().put("kind", "back"));
        result(call(service, request), "completed", "sent", null); check(service.backCalls == 1 && service.calls == 0, "back used gesture transport");
        service = fixture(); request = input(service).put("action", new JSONObject().put("kind", "back")); service.backAccepted = false;
        result(call(service, request), "rejected", "not_sent", "dispatch_rejected");

        service = fixture(); request = input(service); request.getJSONObject("action").put("x", 100);
        result(call(service, request), "rejected", "not_sent", "coordinates_invalid"); check(service.calls == 0, "outside point sent");
        service = fixture(); request = input(service); request.put("display", new JSONObject().put("width", 101).put("height", 200).put("rotation", 0));
        result(call(service, request), "rejected", "not_sent", "display_changed");
        service = fixture(); request = input(service); request.put("windowId", "8");
        result(call(service, request), "rejected", "not_sent", "window_changed");
        service = fixture(); request = input(service); request.put("serviceInstanceId", UUID.randomUUID().toString());
        result(call(service, request), "rejected", "not_sent", "service_changed");
        service = fixture(); request = input(service); SystemClock.offsetMs = 5001;
        result(call(service, request), "rejected", "not_sent", "capture_expired");
        service = fixture(); request = input(service); SystemClock.offsetMs = 4900; scenario.windowReadAdvanceMs = 200;
        result(call(service, request), "rejected", "not_sent", "capture_expired"); check(service.calls == 0, "capture expired during preflight but sent");
        service = fixture(); request = input(service); input(service);
        result(call(service, request), "rejected", "not_sent", "capture_changed");
        service = fixture(); request = input(service);
        final AccessibilityService atomicService = service;
        InspectorObservation.consumeInputCapture(service, service.serviceId, request.getString("captureId"), "app.test", "7",
                request.getJSONObject("display"), null, AccessibilityNodeInfo.ACTION_CLICK, SystemClock.elapsedRealtime() + 1000, () -> true, () -> {
                    FutureTask<JSONObject> overlapping = new FutureTask<>(() -> InspectorObservation.snapshot(atomicService));
                    new Thread(overlapping).start();
                    try { check(!overlapping.get(500, TimeUnit.MILLISECONDS).getBoolean("success"), "snapshot replaced ticket before atomic dispatch commit"); }
                    catch (Exception failure) { throw new AssertionError("dispatch commit did not hold the read gate", failure); }
                    return true;
                });
        service = fixture(); request = input(service); scenario.cacheCleared = false; InspectorObservation.snapshot(service); scenario.cacheCleared = true;
        result(call(service, request), "rejected", "not_sent", "capture_changed");
        service = fixture(); request = input(service); scenario.windows.get(0).root.pkg = "different.app";
        result(call(service, request), "rejected", "not_sent", "window_changed");
        service = fixture(); request = input(service); scenario.windows.get(0).root = null;
        result(call(service, request), "rejected", "not_sent", "incomplete");
        service = fixture(); request = input(service); scenario.afterWidth = 101;
        result(call(service, request), "rejected", "not_sent", "display_changed");
        service = fixture(); request = input(service); scenario.authorized = false;
        result(call(service, request), "rejected", "not_sent", "authorization_changed");
        service = fixture(); request = input(service); request.put("unexpected", true);
        check(call(service, request).getString("errorCode").equals("invalid_request") && service.calls == 0, "unknown schema fields accepted");

        service = fixture(); request = input(service); Handler.blocked = true;
        reply = call(service, request); result(reply, "timeout", "not_sent", "timeout");
        Runnable lateQueued = Handler.last; Handler.blocked = false; Handler.drain(); lateQueued.run();
        check(service.calls == 0 && Handler.queued.isEmpty(), "queued timeout sent a late gesture");
        check(call(service, request) == reply && service.calls == 0, "queued timeout replayed");

        service = fixture(); request = input(service); Handler.blocked = true;
        FutureTask<JSONObject> first = pending(service, request);
        FutureTask<JSONObject> duplicate = pending(service, request);
        check(Handler.queued.size() == 1, "duplicate request queued another dispatch");
        Handler.blocked = false; Handler.drain();
        check(first.get(2, TimeUnit.SECONDS) == duplicate.get(2, TimeUnit.SECONDS) && service.calls == 1, "concurrent duplicate replayed");
        service = fixture(); request = input(service); Handler.blocked = true;
        first = pending(service, request); scenario.authorized = false; Handler.blocked = false; Handler.drain();
        result(first.get(2, TimeUnit.SECONDS), "rejected", "not_sent", "authorization_changed"); check(service.calls == 0, "queued token revocation still sent");
        service = fixture(); request = input(service); Handler.blocked = true;
        first = pending(service, request); service.serviceId = UUID.randomUUID().toString(); Handler.blocked = false; Handler.drain();
        result(first.get(2, TimeUnit.SECONDS), "rejected", "not_sent", "service_changed"); check(service.calls == 0, "queued service restart still sent");
        service = fixture(); request = input(service); Handler.blocked = true;
        first = pending(service, request); input(service); Handler.blocked = false; Handler.drain();
        result(first.get(2, TimeUnit.SECONDS), "rejected", "not_sent", "capture_changed"); check(service.calls == 0, "new capture did not invalidate queued input");

        service = fixture(); request = input(service); scenario.windowReadDelayMs = 1500; Handler.asynchronous = true;
        result(call(service, request), "timeout", "not_sent", "timeout");
        for (Thread worker : Handler.workers) worker.join(2500);
        check(service.calls == 0, "timeout during boundary read later sent");

        service = fixture(); request = input(service); service.mode = "hold";
        reply = call(service, request); result(reply, "timeout", "unknown", "timeout");
        check(service.calls == 1, "callback timeout dispatched twice");
        JSONObject next = input(service); result(call(service, next), "rejected", "not_sent", "busy");
        service.callback.onCompleted(service.lastGesture);
        check(call(service, request) == reply && reply.getString("dispatchState").equals("unknown") && service.calls == 1,
                "late callback erased uncertain receipt or replayed input");

        service = fixture(); request = input(service); Handler.reject = true;
        result(call(service, request), "rejected", "not_sent", "dispatch_rejected"); check(service.calls == 0, "rejected main queue still sent");
        service = fixture(); request = input(service); scenario.cacheCleared = false;
        result(call(service, request), "rejected", "not_sent", "incomplete");

        service = fixture(); request = semantic(service); Build.VERSION.SDK_INT = 33;
        service.touchExploration = service.magnification = true; service.environmentThrows = true;
        reply = call(service, request); result(reply, "completed", "sent", null);
        check(reply.getString("method").equals("accessibility-click") && scenario.actionCalls == 1 && service.calls == 0,
                "semantic click used coordinate gesture or magnification state");
        check(call(service, request) == reply && scenario.actionCalls == 1, "semantic duplicate performed again");
        JSONObject target = request.getJSONObject("target");
        request.put("target", new JSONObject().put("bounds", target.getJSONObject("bounds")).put("contentDesc", "")
                .put("text", "Start|Ready").put("className", "android.widget.Button").put("resourceId", "app.test:id/start"));
        check(call(service, request) == reply && scenario.actionCalls == 1, "JSON key order changed request identity");
        request.getJSONObject("target").put("text", "Start").put("contentDesc", "Ready|");
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 1,
                "descriptor with pipe characters bypassed identity check");
        request.getJSONObject("target").put("text", "Start|Ready").put("contentDesc", "");
        request.getJSONObject("target").values.remove("contentDesc");
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 1,
                "absent descriptor field equalled an empty field");
        service = fixture(); request = semantic(service);
        request.getJSONObject("target").values.remove("text"); request.getJSONObject("target").values.remove("contentDesc");
        result(call(service, request), "completed", "sent", null); check(scenario.actionCalls == 1 && service.calls == 0, "optional descriptor fields became required");

        service = fixture(); request = semantic(service); request.put("action", new JSONObject().put("kind", "back"));
        check(call(service, request).getString("errorCode").equals("invalid_request") && service.backCalls == 0, "target accepted for back");
        service = fixture(); request = semantic(service); request.getJSONObject("target").put("unexpected", true);
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0, "unknown target field accepted");
        service = fixture(); request = semantic(service); request.getJSONObject("target").getJSONObject("bounds").put("right", 101);
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0, "target escaped display");
        service = fixture(); request = semantic(service); request.getJSONObject("target").getJSONObject("bounds").put("right", 10);
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0, "empty target bounds accepted");
        service = fixture(); request = semantic(service); request.getJSONObject("action").put("x", 90);
        result(call(service, request), "rejected", "not_sent", "coordinates_invalid"); check(scenario.actionCalls == 0, "point outside target was accepted");

        for (String field : Arrays.asList("resourceId", "className", "text", "contentDesc")) {
            service = fixture(); request = semantic(service); request.getJSONObject("target").put(field, "changed");
            result(call(service, request), "rejected", "not_sent", "window_changed");
            check(scenario.actionCalls == 0 && service.calls == 0, "changed descriptor fell back to a gesture");
        }
        service = fixture(); request = semantic(service); scenario.windows.get(0).root.children.get(0).right = 89;
        result(call(service, request), "rejected", "not_sent", "window_changed");
        service = fixture(); request = semantic(service); scenario.windows.get(0).root.children.get(0).visible = false;
        result(call(service, request), "rejected", "not_sent", "window_changed");
        service = fixture(); request = semantic(service); scenario.windows.get(0).root.children.get(0).enabled = false;
        result(call(service, request), "rejected", "not_sent", "window_changed");
        service = fixture(); request = semantic(service); scenario.windows.get(0).root.children.get(0).clickable = false;
        scenario.windows.get(0).root.clickable = true;
        result(call(service, request), "rejected", "not_sent", "window_changed");
        check(scenario.actionCalls == 0 && service.calls == 0, "nonclickable exact target fell back to its parent");
        service = fixture(); request = semantic(service); scenario.windows.get(0).root.visible = false;
        result(call(service, request), "rejected", "not_sent", "window_changed");
        service = fixture(); request = semantic(service);
        scenario.windows.get(0).root.children.add(AccessibilityNodeInfo.obtain(scenario.windows.get(0).root.children.get(0)));
        result(call(service, request), "rejected", "not_sent", "incomplete"); check(scenario.actionCalls == 0 && service.calls == 0, "ambiguous target dispatched");
        service = fixture(); request = semantic(service);
        scenario.windows.get(0).root.children.add(scenario.windows.get(0).root.children.get(0));
        result(call(service, request), "rejected", "not_sent", "incomplete");
        service = fixture(); request = semantic(service); scenario.windows.get(0).root.children.add(null);
        result(call(service, request), "rejected", "not_sent", "incomplete"); check(scenario.actionCalls == 0, "incomplete tree still clicked first match");
        service = fixture(); request = semantic(service); AccessibilityNodeInfo chain = scenario.windows.get(0).root;
        for (int i = 0; i < 77; i++) { AccessibilityNodeInfo child = new AccessibilityNodeInfo(); chain.children.add(child); chain = child; }
        result(call(service, request), "rejected", "not_sent", "incomplete"); check(scenario.actionCalls == 0, "truncated depth still clicked");
        service = fixture(); request = semantic(service);
        for (int i = 0; i < 5000; i++) scenario.windows.get(0).root.children.add(new AccessibilityNodeInfo());
        result(call(service, request), "rejected", "not_sent", "incomplete"); check(scenario.actionCalls == 0, "truncated breadth still clicked");

        service = fixture(); request = semantic(service); scenario.refreshFails = true;
        result(call(service, request), "rejected", "not_sent", "window_changed");
        service = fixture(); request = semantic(service); scenario.refreshHook = () -> scenario.windows.get(0).root.children.get(0).text = "changed";
        result(call(service, request), "rejected", "not_sent", "window_changed"); check(scenario.actionCalls == 0, "stale pre-refresh text clicked");
        service = fixture(); request = semantic(service); scenario.refreshHook = () -> scenario.windows.get(0).root.children.get(0).visible = false;
        result(call(service, request), "rejected", "not_sent", "window_changed");
        service = fixture(); request = semantic(service); scenario.refreshHook = () -> scenario.authorized = false;
        result(call(service, request), "rejected", "not_sent", "authorization_changed");
        service = fixture(); request = semantic(service); scenario.refreshHook = () -> scenario.windows.get(0).root.pkg = "other.app";
        result(call(service, request), "rejected", "not_sent", "window_changed"); check(scenario.actionCalls == 0, "changed final inventory still clicked");
        service = fixture(); request = semantic(service); scenario.refreshHook = () -> SystemClock.offsetMs += 1001;
        result(call(service, request), "timeout", "not_sent", "timeout"); check(scenario.actionCalls == 0, "late refresh performed action");
        service = fixture(); request = semantic(service); scenario.nodeReadAdvanceMs = 1001;
        result(call(service, request), "timeout", "not_sent", "timeout"); check(scenario.actionCalls == 0, "late traversal performed action");

        service = fixture(); request = semantic(service); scenario.actionAccepted = false;
        reply = call(service, request); result(reply, "cancelled", "unknown", "dispatch_error");
        check(reply.getString("method").equals("accessibility-click") && scenario.actionCalls == 1 && service.calls == 0,
                "false semantic result fell back or became not_sent");
        check(call(service, request) == reply && scenario.actionCalls == 1, "uncertain semantic result replayed");
        service = fixture(); request = semantic(service); scenario.actionThrows = true;
        result(call(service, request), "cancelled", "unknown", "dispatch_error"); check(scenario.actionCalls == 1 && service.calls == 0, "semantic exception retried");
        service = fixture(); request = semantic(service); scenario.actionAdvanceMs = 3501;
        result(call(service, request), "timeout", "unknown", "timeout"); check(scenario.actionCalls == 1 && service.calls == 0, "late semantic result claimed completion");
        service = fixture(); request = semantic(service); Handler.blocked = true;
        reply = call(service, request); result(reply, "timeout", "not_sent", "timeout");
        lateQueued = Handler.last; Handler.blocked = false; Handler.drain(); lateQueued.run();
        check(scenario.actionCalls == 0 && service.calls == 0, "semantic queue timeout dispatched late");

        service = fixture(); request = descriptionOnly(service); Build.VERSION.SDK_INT = 33;
        service.environmentThrows = true;
        reply = call(service, request); result(reply, "completed", "sent", null);
        check(reply.getString("method").equals("accessibility-click") && scenario.actionCalls == 1 && service.calls == 0,
                "description-only target did not use semantic click");
        JSONObject originalDescription = request.getJSONObject("target");
        request.put("target", new JSONObject().put("contentDesc", "我").put("bounds", originalDescription.getJSONObject("bounds"))
                .put("className", originalDescription.getString("className")));
        check(call(service, request) == reply && scenario.actionCalls == 1, "description key order changed identity or replayed");
        request.getJSONObject("target").put("contentDesc", "我|Ready");
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 1, "description change reused request identity");
        request.getJSONObject("target").put("contentDesc", "我").put("resourceId", "app.test:id/new");
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 1, "missing ID canonicalized to a present ID");
        request.getJSONObject("target").values.remove("resourceId"); request.getJSONObject("target").put("text", "");
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 1, "absent text canonicalized to empty text");

        for (String invalid : Arrays.asList("missing", "", " ", "\t\r\n", "\u00a0", "\u3000", "\ufeff")) {
            service = fixture(); request = descriptionOnly(service);
            if (invalid.equals("missing")) request.getJSONObject("target").values.remove("contentDesc");
            else request.getJSONObject("target").put("contentDesc", invalid);
            check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0 && service.calls == 0,
                    "blank or missing exact description accepted");
        }
        service = fixture(); request = descriptionOnly(service); request.getJSONObject("target").put("contentDesc", null);
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0, "null description accepted");
        service = fixture(); request = descriptionOnly(service); request.getJSONObject("target").put("resourceId", "");
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0, "present empty ID accepted as absent");
        service = fixture(); request = descriptionOnly(service); request.getJSONObject("target").put("resourceId", null);
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0, "present null ID accepted as absent");
        service = fixture(); request = descriptionOnly(service); request.getJSONObject("target").values.remove("className");
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0, "description target accepted without class");
        service = fixture(); request = descriptionOnly(service); request.getJSONObject("action").put("x", 90);
        result(call(service, request), "rejected", "not_sent", "coordinates_invalid"); check(scenario.actionCalls == 0, "description target accepted outside point");
        service = fixture(); request = descriptionOnly(service); request.getJSONObject("target").put("contentDesc", " 我 ");
        result(call(service, request), "rejected", "not_sent", "window_changed"); check(scenario.actionCalls == 0, "description was trimmed for matching");
        service = fixture(); request = descriptionOnly(service); scenario.windows.get(0).root.children.get(0).resourceId = "";
        result(call(service, request), "completed", "sent", null); check(scenario.actionCalls == 1, "actual empty resource ID failed exact absence");
        service = fixture(); request = descriptionOnly(service); scenario.windows.get(0).root.children.get(0).contentDesc = " 我 ";
        request.getJSONObject("target").put("contentDesc", " 我 ");
        result(call(service, request), "completed", "sent", null); check(scenario.actionCalls == 1, "nonblank description whitespace was normalized");
        service = fixture(); request = descriptionOnly(service); scenario.windows.get(0).root.children.get(0).resourceId = "app.test:id/tab";
        result(call(service, request), "rejected", "not_sent", "window_changed");
        check(scenario.actionCalls == 0 && service.calls == 0, "omitted resource ID became a wildcard");
        service = fixture(); request = descriptionOnly(service);
        scenario.windows.get(0).root.children.add(AccessibilityNodeInfo.obtain(scenario.windows.get(0).root.children.get(0)));
        result(call(service, request), "rejected", "not_sent", "incomplete"); check(scenario.actionCalls == 0, "duplicate no-ID tuple clicked");
        for (String change : Arrays.asList("id", "description", "class", "bounds", "hidden", "disabled", "clickable", "window", "token", "deadline")) {
            service = fixture(); request = descriptionOnly(service);
            scenario.refreshHook = () -> {
                AccessibilityNodeInfo node = scenario.windows.get(0).root.children.get(0);
                if (change.equals("id")) node.resourceId = "app.test:id/now_present";
                if (change.equals("description")) node.contentDesc = "other";
                if (change.equals("class")) node.className = "android.widget.Button";
                if (change.equals("bounds")) node.right--;
                if (change.equals("hidden")) node.visible = false;
                if (change.equals("disabled")) node.enabled = false;
                if (change.equals("clickable")) node.clickable = false;
                if (change.equals("window")) scenario.windows.get(0).root.pkg = "other.app";
                if (change.equals("token")) scenario.authorized = false;
                if (change.equals("deadline")) SystemClock.offsetMs += 1001;
            };
            result(call(service, request), change.equals("deadline") ? "timeout" : "rejected", "not_sent",
                    change.equals("deadline") ? "timeout" : change.equals("token") ? "authorization_changed" : "window_changed");
            check(scenario.actionCalls == 0 && service.calls == 0, "changed refreshed description target sent: " + change);
        }
        service = fixture(); request = descriptionOnly(service); request.put("action", new JSONObject().put("kind", "scroll").put("direction", "down"));
        scenario.windows.get(0).root.children.get(0).scrollable = true;
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0, "scroll accepted description-only identity");
        service = fixture(); request = descriptionOnly(service); scenario.actionAccepted = false;
        reply = call(service, request); result(reply, "cancelled", "unknown", "dispatch_error");
        check(call(service, request) == reply && scenario.actionCalls == 1 && service.calls == 0, "uncertain no-ID click replayed or fell back");
        service = fixture(); request = descriptionOnly(service); scenario.actionThrows = true;
        result(call(service, request), "cancelled", "unknown", "dispatch_error"); check(scenario.actionCalls == 1 && service.calls == 0, "no-ID exception retried");
        service = fixture(); request = descriptionOnly(service); Handler.blocked = true;
        reply = call(service, request); result(reply, "timeout", "not_sent", "timeout");
        lateQueued = Handler.last; Handler.blocked = false; Handler.drain(); lateQueued.run();
        check(scenario.actionCalls == 0 && service.calls == 0, "description-only queue timeout clicked late");

        for (String direction : Arrays.asList("down", "up")) {
            service = fixture(); request = scroll(service, direction); Build.VERSION.SDK_INT = 33;
            service.environmentThrows = true;
            reply = call(service, request); result(reply, "completed", "sent", null);
            check(reply.getString("method").equals("accessibility-scroll") && scenario.actionCalls == 1 && service.calls == 0,
                    "semantic scroll used coordinate transport or magnification state");
            check(scenario.lastAction == (direction.equals("down") ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD),
                    "semantic scroll direction changed");
            check(call(service, request) == reply && scenario.actionCalls == 1, "scroll replay sent twice");
            request.getJSONObject("action").put("direction", direction.equals("down") ? "up" : "down");
            check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 1,
                    "scroll identity allowed changed direction");
        }
        service = fixture(); request = scroll(service, "down"); request.values.remove("target");
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0, "scroll accepted without target");
        service = fixture(); request = scroll(service, "left");
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0, "horizontal scroll accepted");
        service = fixture(); request = scroll(service, "down"); request.getJSONObject("action").put("durationMs", 350);
        check(call(service, request).getString("errorCode").equals("invalid_request") && scenario.actionCalls == 0, "scroll accepted gesture fields");
        service = fixture(); request = scroll(service, "down"); request.getJSONObject("target").put("text", "other");
        result(call(service, request), "rejected", "not_sent", "window_changed"); check(scenario.actionCalls == 0, "scroll ignored descriptor identity");
        for (String state : Arrays.asList("not_scrollable", "no_action", "wrong_action", "hidden", "disabled", "bounds_changed", "unavailable_actions")) {
            service = fixture(); request = scroll(service, "down");
            AccessibilityNodeInfo node = scenario.windows.get(0).root.children.get(0);
            if (state.equals("not_scrollable")) node.scrollable = false;
            if (state.equals("no_action")) node.actions.clear();
            if (state.equals("wrong_action")) { node.actions.clear(); node.actions.add(new AccessibilityNodeInfo.AccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)); }
            if (state.equals("hidden")) node.visible = false;
            if (state.equals("disabled")) node.enabled = false;
            if (state.equals("bounds_changed")) node.bottom--;
            if (state.equals("unavailable_actions")) node.actionsUnavailable = true;
            result(call(service, request), "rejected", "not_sent", state.equals("unavailable_actions") ? "incomplete" : "window_changed");
            check(scenario.actionCalls == 0 && service.calls == 0, "unusable semantic scroll fell back: " + state);
        }
        service = fixture(); request = scroll(service, "down");
        scenario.windows.get(0).root.children.add(AccessibilityNodeInfo.obtain(scenario.windows.get(0).root.children.get(0)));
        result(call(service, request), "rejected", "not_sent", "incomplete"); check(scenario.actionCalls == 0, "ambiguous scroll performed action");
        service = fixture(); request = scroll(service, "down"); scenario.windows.get(0).root.children.add(null);
        result(call(service, request), "rejected", "not_sent", "incomplete"); check(scenario.actionCalls == 0, "incomplete scroll tree performed action");
        for (String change : Arrays.asList("action", "scrollable", "window", "token", "deadline")) {
            service = fixture(); request = scroll(service, "down");
            scenario.refreshHook = () -> {
                AccessibilityNodeInfo node = scenario.windows.get(0).root.children.get(0);
                if (change.equals("action")) node.actions.clear();
                if (change.equals("scrollable")) node.scrollable = false;
                if (change.equals("window")) node.windowId = 8;
                if (change.equals("token")) scenario.authorized = false;
                if (change.equals("deadline")) SystemClock.offsetMs += 1001;
            };
            result(call(service, request), change.equals("deadline") ? "timeout" : "rejected", "not_sent",
                    change.equals("deadline") ? "timeout" : change.equals("token") ? "authorization_changed" : "window_changed");
            check(scenario.actionCalls == 0 && service.calls == 0, "stale refreshed scroll dispatched: " + change);
        }
        service = fixture(); request = scroll(service, "down"); scenario.actionAccepted = false; scenario.actionChangesScroll = true;
        reply = call(service, request); result(reply, "cancelled", "unknown", "dispatch_error");
        check(scenario.actionScrollY == 37 && scenario.actionCalls == 1 && service.calls == 0
                && reply.getString("method").equals("accessibility-scroll"), "side effect before false became not_sent or fell back");
        check(call(service, request) == reply && scenario.actionCalls == 1 && scenario.actionScrollY == 37, "uncertain scroll replayed its side effect");
        service = fixture(); request = scroll(service, "down"); scenario.actionThrows = true;
        result(call(service, request), "cancelled", "unknown", "dispatch_error"); check(scenario.actionCalls == 1 && service.calls == 0, "scroll exception retried");
        service = fixture(); request = scroll(service, "down"); scenario.actionAdvanceMs = 3501;
        result(call(service, request), "timeout", "unknown", "timeout"); check(scenario.actionCalls == 1 && service.calls == 0, "late scroll claimed success");
        service = fixture(); request = scroll(service, "down"); Handler.blocked = true;
        reply = call(service, request); result(reply, "timeout", "not_sent", "timeout");
        lateQueued = Handler.last; Handler.blocked = false; Handler.drain(); lateQueued.run();
        check(scenario.actionCalls == 0 && service.calls == 0, "scroll timeout dispatched late");
        check(call(service, request) == reply && scenario.actionCalls == 0, "timed out scroll replayed");

        service = fixture(); request = input(service); request.put("captureId", UUID.randomUUID().toString());
        for (int i = 0; i < 1000; i++) {
            request.put("requestId", UUID.randomUUID().toString()); result(call(service, request), "rejected", "not_sent", "capture_changed");
        }
        request.put("requestId", UUID.randomUUID().toString()); result(call(service, request), "rejected", "not_sent", "capacity");
        check(service.calls == 0, "capacity pressure evicted and replayed a request");
        System.out.println("Guarded input: tap/swipe/back, strict identity, once-only captures, bounded ledger, queue race, false, callbacks and late timeouts checked; semantic targets and directional scroll actions uniquely refreshed without fallback");
        System.out.println("Description-only taps: exact empty resource ID, nonblank unmodified description/class/bounds, unique refreshed tuple and once-only unknown outcomes checked");
    }
}

package com.artemis.helper;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.accessibilityservice.MagnificationConfig;
import android.content.Context;
import android.graphics.Path;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Display;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.ArrayList;
import java.util.List;
import java.util.WeakHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** Private paired transport. The desktop owns grant checks and UI verification; callbacks never prove the UI result. */
public final class InspectorInput {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Map<AccessibilityService, Map<String, Record>> RECORDS = new WeakHashMap<>();
    private static final AtomicReference<Record> ACTIVE = new AtomicReference<>();
    private static final int QUEUED = 0, DISPATCHING = 1, CLOSED = 2;
    private static final long QUEUE_MS = 1000, TOTAL_MS = 3500;
    private InspectorInput() {}

    static JSONObject probeTarget(JSONObject target, int width, int height) throws Exception {
        return Request.parseTarget(target, width, height, true);
    }

    static JSONObject probeDiagnostics(InspectorObservation.InputScanProgress scan, long main, long stage, long finished) throws Exception {
        return Record.scanDiagnostics(scan, main, stage, finished);
    }

    private static final class Request {
        final String sessionId, requestId, serviceId, captureId, packageName, windowId, kind, direction, fingerprint, method;
        final JSONObject display, target;
        final int x, y, toX, toY, durationMs;
        Request(String body) throws Exception {
            if (body == null || body.getBytes(StandardCharsets.UTF_8).length > 4096) throw new IllegalArgumentException();
            JSONObject input = new JSONObject(body);
            List<String> keys = new ArrayList<>();
            java.util.Collections.addAll(keys, "version", "sessionId", "requestId", "serviceInstanceId", "captureId", "packageName", "windowId", "display", "action");
            if (input.has("target")) keys.add("target");
            InspectorObservation.waitKeys(input, keys.toArray(new String[0]));
            InspectorObservation.waitInteger(input, "version", 1, 1);
            sessionId = InspectorObservation.waitUuid(input, "sessionId"); requestId = InspectorObservation.waitUuid(input, "requestId");
            serviceId = InspectorObservation.waitUuid(input, "serviceInstanceId"); captureId = InspectorObservation.waitUuid(input, "captureId");
            packageName = InspectorObservation.waitText(input, "packageName", 256);
            if (!packageName.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")) throw new IllegalArgumentException();
            windowId = InspectorObservation.waitText(input, "windowId", 128);
            if (!windowId.matches("[0-9]+")) throw new IllegalArgumentException();
            JSONObject rawDisplay = input.getJSONObject("display");
            InspectorObservation.waitKeys(rawDisplay, "width", "height", "rotation");
            int width = (int) InspectorObservation.waitInteger(rawDisplay, "width", 1, 16384);
            int height = (int) InspectorObservation.waitInteger(rawDisplay, "height", 1, 16384);
            int rotation = (int) InspectorObservation.waitInteger(rawDisplay, "rotation", 0, 3);
            display = new JSONObject().put("width", width).put("height", height).put("rotation", rotation);
            JSONObject action = input.getJSONObject("action");
            kind = InspectorObservation.waitText(action, "kind", 6);
            String scrollDirection = null;
            if (kind.equals("tap")) {
                InspectorObservation.waitKeys(action, "kind", "x", "y");
                x = coordinate(action, "x"); y = coordinate(action, "y"); toX = x; toY = y; durationMs = 60;
            } else if (kind.equals("swipe")) {
                InspectorObservation.waitKeys(action, "kind", "fromX", "fromY", "toX", "toY", "durationMs");
                x = coordinate(action, "fromX"); y = coordinate(action, "fromY");
                toX = coordinate(action, "toX"); toY = coordinate(action, "toY");
                durationMs = (int) InspectorObservation.waitInteger(action, "durationMs", 150, 1000);
            } else if (kind.equals("back")) {
                InspectorObservation.waitKeys(action, "kind"); x = y = toX = toY = durationMs = 0;
            } else if (kind.equals("scroll")) {
                InspectorObservation.waitKeys(action, "kind", "direction");
                scrollDirection = InspectorObservation.waitText(action, "direction", 4);
                if (!scrollDirection.equals("up") && !scrollDirection.equals("down")) throw new IllegalArgumentException();
                x = y = toX = toY = durationMs = 0;
            } else throw new IllegalArgumentException();
            direction = scrollDirection;
            target = input.has("target") ? parseTarget(input.getJSONObject("target"), width, height, kind.equals("tap")) : null;
            if (kind.equals("scroll") ? target == null : target != null && !kind.equals("tap")) throw new IllegalArgumentException();
            method = kind.equals("scroll") ? "accessibility-scroll" : target != null ? "accessibility-click" : kind.equals("back") ? "global-back" : "gesture";
            fingerprint = serviceId + "|" + captureId + "|" + packageName + "|" + windowId + "|" + width + "|" + height
                    + "|" + rotation + "|" + kind + "|" + x + "|" + y + "|" + toX + "|" + toY + "|" + durationMs
                    + "|" + direction + "|" + (target == null ? "none" : target.toString());
        }
        private static JSONObject parseTarget(JSONObject raw, int width, int height, boolean descriptionOnlyAllowed) throws Exception {
            List<String> keys = new ArrayList<>(); java.util.Collections.addAll(keys, "className", "bounds");
            if (raw.has("resourceId")) keys.add("resourceId");
            for (String optional : new String[]{"text", "contentDesc"}) if (raw.has(optional)) keys.add(optional);
            InspectorObservation.waitKeys(raw, keys.toArray(new String[0]));
            JSONObject target = new JSONObject();
            if (raw.has("resourceId")) target.put("resourceId", InspectorObservation.waitText(raw, "resourceId", 512));
            target.put("className", InspectorObservation.waitText(raw, "className", 512));
            for (String optional : new String[]{"text", "contentDesc"}) if (raw.has(optional)) {
                Object value = raw.get(optional);
                if (!(value instanceof String) || ((String) value).length() > 512) throw new IllegalArgumentException();
                target.put(optional, value);
            }
            // Blank checking never normalizes the exact description used for matching and request identity.
            if (!target.has("resourceId") && (!descriptionOnlyAllowed || !target.has("contentDesc")
                    || target.getString("contentDesc").matches("[\\s\\p{Z}\\uFEFF]*"))) throw new IllegalArgumentException();
            JSONObject bounds = raw.getJSONObject("bounds");
            InspectorObservation.waitKeys(bounds, "left", "top", "right", "bottom");
            int left = (int) InspectorObservation.waitInteger(bounds, "left", 0, width);
            int top = (int) InspectorObservation.waitInteger(bounds, "top", 0, height);
            int right = (int) InspectorObservation.waitInteger(bounds, "right", 0, width);
            int bottom = (int) InspectorObservation.waitInteger(bounds, "bottom", 0, height);
            if (left >= right || top >= bottom) throw new IllegalArgumentException();
            return target.put("bounds", new JSONObject().put("left", left).put("top", top).put("right", right).put("bottom", bottom));
        }
        private static int coordinate(JSONObject value, String key) throws Exception {
            return (int) InspectorObservation.waitInteger(value, key, 0, 100000);
        }
        boolean coordinatesValid() throws Exception {
            if (kind.equals("scroll")) return true;
            if (target != null) {
                JSONObject bounds = target.getJSONObject("bounds");
                if (x < bounds.getInt("left") || x >= bounds.getInt("right") || y < bounds.getInt("top") || y >= bounds.getInt("bottom")) return false;
            }
            return kind.equals("back") || x < display.getInt("width") && toX < display.getInt("width")
                    && y < display.getInt("height") && toY < display.getInt("height")
                    && (!kind.equals("swipe") || x != toX || y != toY);
        }
        int targetAction() {
            return !kind.equals("scroll") ? AccessibilityNodeInfo.ACTION_CLICK : direction.equals("down")
                    ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
        }
    }

    private static final class Record {
        private static final class PreflightStage {
            final String name;
            final long startedAtMs;
            PreflightStage(String name, long startedAtMs) { this.name = name; this.startedAtMs = startedAtMs; }
        }
        final Request request;
        final long startedAtMs = SystemClock.elapsedRealtime();
        final long queueDeadline = startedAtMs + QUEUE_MS, deadline = startedAtMs + TOTAL_MS;
        final AtomicInteger phase = new AtomicInteger(QUEUED);
        final CountDownLatch started = new CountDownLatch(1), done = new CountDownLatch(1);
        volatile Runnable runnable;
        volatile long mainStartedAtMs = -1;
        volatile PreflightStage preflightStage;
        volatile InspectorObservation.InputScanProgress scanProgress;
        private JSONObject reply;
        private String lateOutcome;
        Record(Request request) { this.request = request; }
        void markStage(String name) { preflightStage = new PreflightStage(name, SystemClock.elapsedRealtime()); }
        void markScan(InspectorObservation.InputScanProgress progress) { scanProgress = progress; }
        synchronized JSONObject reply() { return reply; }
        synchronized void finish(String status, String dispatchState, String errorCode) {
            try {
                if (reply == null) {
                    // Freeze progress before taking the receipt timestamp; late reads publish new snapshots only.
                    InspectorObservation.InputScanProgress scan = scanProgress;
                    PreflightStage stage = preflightStage;
                    long mainStarted = mainStartedAtMs;
                    reply = response(request, status, dispatchState, startedAtMs, errorCode);
                    if (mainStarted >= startedAtMs && mainStarted <= reply.getLong("finishedAtMs"))
                        reply.put("mainStartedAtMs", mainStarted);
                    if (status.equals("timeout") && dispatchState.equals("not_sent") && stage != null
                            && mainStarted >= startedAtMs && stage.startedAtMs >= mainStarted
                            && stage.startedAtMs <= reply.getLong("finishedAtMs"))
                        reply.put("preflightStage", stage.name).put("preflightStageStartedAtMs", stage.startedAtMs);
                    if (reply.has("preflightStage") && stage.name.equals("target_scan") && scan != null) {
                        JSONObject diagnostics = scanDiagnostics(scan, mainStarted, stage.startedAtMs, reply.getLong("finishedAtMs"));
                        if (diagnostics != null) reply.put("scanDiagnostics", diagnostics);
                    }
                } else lateOutcome = status;
            } catch (Exception invalid) { throw new IllegalStateException("Input receipt failed"); }
            runnable = null;
            started.countDown(); done.countDown();
        }
        private static JSONObject scanDiagnostics(InspectorObservation.InputScanProgress scan, long main, long stage, long finished) throws Exception {
            int delta = scan.childReadsStarted - scan.childReadsCompleted;
            if (main > stage || stage > scan.scanStartedAtMs || scan.scanStartedAtMs > scan.operationStartedAtMs
                    || scan.operationStartedAtMs > finished || scan.scanStartedAtMs < 0
                    || scan.nodesVisited < 0 || scan.nodesVisited > 5000
                    || scan.childReadsStarted < 0 || scan.childReadsStarted > 5000
                    || scan.childReadsCompleted < 0 || scan.childReadsCompleted > 5000
                    || !(delta == 0 && "node".equals(scan.operation) || delta == 1 && "child".equals(scan.operation))
                    || scan.childReadMaxMs < 0 || scan.childReadTotalMs < scan.childReadMaxMs
                    || scan.childReadTotalMs > 7000 || scan.childReadTotalMs > finished - scan.scanStartedAtMs
                    || scan.childReadsCompleted == 0 && scan.childReadTotalMs != 0) return null;
            return new JSONObject().put("version", 1).put("scanStartedAtMs", scan.scanStartedAtMs)
                    .put("operation", scan.operation).put("operationStartedAtMs", scan.operationStartedAtMs)
                    .put("nodesVisited", scan.nodesVisited).put("childReadsStarted", scan.childReadsStarted)
                    .put("childReadsCompleted", scan.childReadsCompleted).put("childReadTotalMs", scan.childReadTotalMs)
                    .put("childReadMaxMs", scan.childReadMaxMs);
        }
        boolean closeQueued(String status, String code) {
            if (!phase.compareAndSet(QUEUED, CLOSED)) return false;
            Runnable pending = runnable;
            if (pending != null) MAIN.removeCallbacks(pending);
            finish(status, "not_sent", code);
            ACTIVE.compareAndSet(this, null);
            return true;
        }
        void callback(String status, String dispatchState, String code) {
            phase.set(CLOSED);
            if (SystemClock.elapsedRealtime() >= deadline && !dispatchState.equals("not_sent")) {
                finish("timeout", "unknown", "timeout");
                synchronized (this) { lateOutcome = status; }
            } else finish(status, dispatchState, code);
            ACTIVE.compareAndSet(this, null);
        }
    }

    private static JSONObject response(Request request, String status, String dispatchState, long started, String code) throws Exception {
        JSONObject result = new JSONObject().put("version", 1).put("sessionId", request.sessionId).put("requestId", request.requestId)
                .put("serviceInstanceId", request.serviceId).put("captureId", request.captureId).put("packageName", request.packageName)
                .put("windowId", request.windowId).put("display", request.display).put("status", status).put("dispatchState", dispatchState)
                .put("method", request.method)
                .put("startedAtMs", started).put("finishedAtMs", SystemClock.elapsedRealtime());
        if (code != null) result.put("errorCode", code);
        return result;
    }

    public static JSONObject execute(AccessibilityService service, String body, BooleanSupplier authenticated) throws Exception {
        final Request request;
        try { request = new Request(body); }
        catch (Exception invalid) { return invalidRequest(); }
        Record record;
        boolean created = false;
        synchronized (RECORDS) {
            Map<String, Record> records = RECORDS.get(service);
            if (records == null) { records = new HashMap<>(); RECORDS.put(service, records); }
            String key = request.sessionId + "|" + request.requestId;
            record = records.get(key);
            if (record != null && !record.request.fingerprint.equals(request.fingerprint)) return invalidRequest();
            if (record == null) {
                if (records.size() >= 1000) return response(request, "rejected", "not_sent", SystemClock.elapsedRealtime(), "capacity");
                record = new Record(request); records.put(key, record); created = true;
            }
        }
        if (created) try {
            final Record owned = record;
            if (!authenticated.getAsBoolean()) owned.closeQueued("rejected", "authorization_changed");
            else if (!request.serviceId.equals(InspectorObservation.inputServiceId(service))) owned.closeQueued("rejected", "service_changed");
            else if (!request.coordinatesValid()) owned.closeQueued("rejected", "coordinates_invalid");
            else if (!ACTIVE.compareAndSet(null, owned)) owned.closeQueued("rejected", "busy");
            else {
                if (owned.phase.get() != QUEUED) ACTIVE.compareAndSet(owned, null);
                else {
                    owned.runnable = () -> dispatch(service, owned, authenticated);
                    if (!MAIN.post(owned.runnable)) owned.closeQueued("rejected", "dispatch_rejected");
                }
            }
        } catch (Throwable failure) { record.closeQueued("rejected", "dispatch_error"); }
        try {
            if (!record.started.await(Math.max(0, record.queueDeadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS))
                record.closeQueued("timeout", "timeout");
            if (!record.done.await(Math.max(0, record.deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS)) {
                if (!record.closeQueued("timeout", "timeout")) record.finish("timeout", "unknown", "timeout");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            if (!record.closeQueued("rejected", "cancelled")) record.finish("cancelled", "unknown", "cancelled");
        }
        return record.reply();
    }

    private static JSONObject invalidRequest() throws Exception {
        return new JSONObject().put("success", false).put("errorCode", "invalid_request");
    }

    private static void dispatch(AccessibilityService service, Record record, BooleanSupplier authenticated) {
        Request request = record.request;
        InspectorObservation.InputTicket ticket = null;
        try {
            record.mainStartedAtMs = SystemClock.elapsedRealtime();
            record.markStage("precheck");
            if (record.phase.get() != QUEUED) return;
            GestureDescription gesture = request.method.equals("gesture") ? gesture(request) : null;
            if (gesture != null && !gestureCoordinatesSupported(service)) {
                record.closeQueued("rejected", "unsupported"); return;
            }
            ticket = InspectorObservation.consumeInputCapture(service, request.serviceId, request.captureId, request.packageName,
                    request.windowId, request.display, request.target, request.targetAction(), record.queueDeadline,
                    () -> record.phase.get() == QUEUED && authenticated.getAsBoolean(),
                    () -> record.phase.compareAndSet(QUEUED, DISPATCHING), record::markStage, record::markScan);
            record.started.countDown();
            // The queue timer and this transition share the same gate. A closed queued request can never send.
            boolean coordinatesSupported = gesture == null || gestureCoordinatesSupported(service);
            long now = SystemClock.elapsedRealtime();
            String closedCode = now >= record.queueDeadline ? "timeout" : now > ticket.expiresAtMs ? "capture_expired"
                    : !authenticated.getAsBoolean() ? "authorization_changed"
                    : !request.serviceId.equals(InspectorObservation.inputServiceId(service)) ? "service_changed"
                    : !coordinatesSupported ? "unsupported" : null;
            if (closedCode != null) {
                if (record.phase.compareAndSet(DISPATCHING, CLOSED)) {
                    record.finish(closedCode.equals("timeout") ? "timeout" : "rejected", "not_sent", closedCode);
                    ACTIVE.compareAndSet(record, null);
                }
                return;
            }
            if (request.target != null) {
                boolean accepted = ticket.target.performAction(request.targetAction());
                record.callback(accepted ? "completed" : "cancelled", accepted ? "sent" : "unknown", accepted ? null : "dispatch_error");
            } else if (request.kind.equals("back")) {
                boolean accepted = service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
                record.callback(accepted ? "completed" : "rejected", accepted ? "sent" : "not_sent", accepted ? null : "dispatch_rejected");
            } else {
                boolean accepted = service.dispatchGesture(gesture, new AccessibilityService.GestureResultCallback() {
                    @Override public void onCompleted(GestureDescription ignored) { record.callback("completed", "sent", null); }
                    @Override public void onCancelled(GestureDescription ignored) { record.callback("cancelled", "unknown", "cancelled"); }
                }, MAIN);
                if (!accepted) record.callback("rejected", "not_sent", "dispatch_rejected");
            }
        } catch (InspectorObservation.InputBoundaryFailure failure) { record.closeQueued(failure.code.equals("timeout") ? "timeout" : "rejected", failure.code); }
        catch (Throwable failure) {
            if (!record.closeQueued("rejected", "dispatch_error")) record.callback("cancelled", "unknown", "dispatch_error");
        } finally { if (ticket != null) HierarchyDumper.safeRecycle(ticket.target); }
    }

    private static boolean gestureCoordinatesSupported(AccessibilityService service) {
        // The scale alone cannot identify an active window magnifier. API 34 adds its explicit activation state.
        if (Build.VERSION.SDK_INT < 34) return false;
        try {
            AccessibilityManager manager = (AccessibilityManager) service.getSystemService(Context.ACCESSIBILITY_SERVICE);
            MagnificationConfig config = service.getMagnificationController().getMagnificationConfig();
            return manager != null && !manager.isTouchExplorationEnabled() && config != null && !config.isActivated();
        } catch (Exception unavailable) { return false; }
    }

    private static GestureDescription gesture(Request request) {
        Path path = new Path(); path.moveTo(request.x, request.y);
        if (request.kind.equals("swipe")) path.lineTo(request.toX, request.toY);
        return new GestureDescription.Builder().setDisplayId(Display.DEFAULT_DISPLAY)
                .addStroke(new GestureDescription.StrokeDescription(path, 0, request.durationMs)).build();
    }
}

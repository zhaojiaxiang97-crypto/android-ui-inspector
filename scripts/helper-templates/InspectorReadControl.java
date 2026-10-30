package com.artemis.helper;

import android.accessibilityservice.AccessibilityService;
import android.os.SystemClock;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.UUID;
import java.util.function.BooleanSupplier;

/** Optional read-only lifecycle. Cancellation never unlocks another thread's read. */
public final class InspectorReadControl {
    private static final LinkedHashMap<String, Read> READS = new LinkedHashMap<>();
    private static final int RUNNING_LIMIT = 32, EARLY_CANCEL_LIMIT = 32, RECORD_LIMIT = 256;
    static final class Stopped extends IllegalStateException {
        final String code;
        Stopped(String code) { this.code = code; }
    }
    static final class Identity {
        final String session, request, service, pkg, token;
        final int budget;
        Identity(String body, String token) throws Exception {
            if (body == null || body.getBytes(StandardCharsets.UTF_8).length > 4096) throw new Stopped("invalid_request");
            JSONObject input = new JSONObject(body);
            if (input.length() != 6) throw new Stopped("invalid_request");
            if (!(input.get("version") instanceof Integer) || input.getInt("version") != 1) throw new Stopped("invalid_request");
            session = uuid(input, "sessionId"); request = uuid(input, "requestId"); service = uuid(input, "serviceInstanceId");
            pkg = input.getString("packageName");
            if (!pkg.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+") || pkg.length() > 256)
                throw new Stopped("invalid_request");
            Object value = input.get("timeoutMs");
            if (!(value instanceof Integer) || (Integer)value < 1 || (Integer)value > 30000) throw new Stopped("invalid_request");
            budget = (Integer)value; this.token = token;
        }
        private static String uuid(JSONObject object, String key) throws Exception {
            String value = object.getString(key);
            if (!UUID.fromString(value).toString().equals(value)) throw new Stopped("invalid_request");
            return value;
        }
        boolean same(Identity other) {
            return session.equals(other.session) && request.equals(other.request) && service.equals(other.service)
                && pkg.equals(other.pkg) && token.equals(other.token);
        }
    }
    static final class Read {
        final Identity identity;
        final long deadline;
        final BooleanSupplier permitted;
        boolean running, started;
        String state = "active";
        Read(Identity identity, BooleanSupplier permitted, long deadline) {
            this.identity = identity; this.permitted = permitted;
            this.deadline = deadline;
        }
        synchronized void check() {
            if (!state.equals("active")) throw new Stopped(state);
            if (!permitted.getAsBoolean()) { state = "authorization_changed"; throw new Stopped(state); }
            if (Thread.currentThread().isInterrupted() || SystemClock.elapsedRealtime() >= deadline) {
                state = "timeout"; throw new Stopped(state);
            }
        }
        synchronized void complete(Runnable publication) {
            check(); publication.run(); state = "completed";
        }
        synchronized String cancel() {
            if (state.equals("active")) state = "cancelled";
            return state;
        }
        synchronized void finish() { running = false; if (state.equals("active")) state = "failed"; }
    }
    private static synchronized Read find(Identity identity, BooleanSupplier permitted, boolean start, long deadline) {
        long now = SystemClock.elapsedRealtime();
        Iterator<Read> iterator = READS.values().iterator();
        while (iterator.hasNext()) {
            Read old = iterator.next();
            synchronized (old) { if (!old.running && now > old.deadline + 60000) iterator.remove(); }
        }
        Read read = READS.get(identity.request);
        if (read != null && !read.identity.same(identity)) throw new Stopped("identity_changed");
        if (read == null) {
            // Finished identities retain replay protection without occupying live worker slots.
            int running = 0, earlyCancels = 0;
            for (Read existing : READS.values()) synchronized (existing) {
                if (existing.running) running++;
                if (!existing.started && existing.state.equals("cancelled")) earlyCancels++;
            }
            if (READS.size() >= RECORD_LIMIT || (start ? running >= RUNNING_LIMIT : earlyCancels >= EARLY_CANCEL_LIMIT))
                throw new Stopped("capacity");
            read = new Read(identity, permitted, deadline); READS.put(identity.request, read);
        }
        if (start) synchronized (read) {
            if (read.started) throw new Stopped("duplicate_request");
            read.check(); read.started = true; read.running = true;
        }
        return read;
    }
    private static void authorize(AccessibilityService service, Identity identity, BooleanSupplier permitted) throws Exception {
        if (!permitted.getAsBoolean() || !identity.service.equals(InspectorObservation.capabilities(service).getString("serviceInstanceId")))
            throw new Stopped("authorization_changed");
    }
    public static JSONObject capabilities(AccessibilityService service) throws Exception {
        return new JSONObject().put("success", true).put("protocolVersion", 1).put("maxTimeoutMs", 30000)
            .put("serviceInstanceId", InspectorObservation.capabilities(service).getString("serviceInstanceId"));
    }
    public static JSONObject cancel(AccessibilityService service, String body, String token, BooleanSupplier permitted) throws Exception {
        try {
            Identity identity = new Identity(body, token); authorize(service, identity, permitted);
            Read read = find(identity, permitted, false, SystemClock.elapsedRealtime() + identity.budget);
            return new JSONObject().put("success", true).put("requestId", identity.request).put("state", read.cancel());
        } catch (Exception error) { return failure(error); }
    }
    public static byte[] snapshot(AccessibilityService service, String body, String token, BooleanSupplier permitted,
            InspectorObservation.SnapshotTimings timings) throws Exception {
        return snapshot(service, body, token, permitted, timings, 0);
    }
    public static byte[] snapshot(AccessibilityService service, String body, String token, BooleanSupplier permitted,
            InspectorObservation.SnapshotTimings timings, long queuedMs) throws Exception {
        long started = SystemClock.elapsedRealtime();
        Read read = null;
        try {
            Identity identity = new Identity(body, token); authorize(service, identity, permitted);
            read = find(identity, permitted, true, started + identity.budget - Math.max(0, queuedMs));
            final Read context = read;
            timings.startObservation();
            JSONObject result;
            try { result = InspectorObservation.controlledSnapshot(service, timings, context::check); }
            finally { timings.finishObservation(); }
            context.check();
            JSONObject wrapper = new JSONObject().put("requestId", identity.request).put("snapshot", result);
            byte[] bytes = timings.serialize(wrapper, InspectorSnapshotJson::stringify);
            context.check();
            if (result.getBoolean("success") && result.getJSONObject("helperObservation").getBoolean("complete")) {
                if (!identity.pkg.equals(result.getJSONObject("helperObservation").getString("packageName"))) throw new Stopped("identity_changed");
                InspectorObservation.publishControlledSnapshot(result, context::complete);
            } else context.complete(() -> {});
            return bytes;
        } catch (Exception error) { return failure(error).toString().getBytes(StandardCharsets.UTF_8); }
        finally { if (read != null) read.finish(); }
    }
    private static JSONObject failure(Exception error) throws Exception {
        return new JSONObject().put("success", false).put("errorCode", error instanceof Stopped ? ((Stopped)error).code : "read_failed");
    }
}

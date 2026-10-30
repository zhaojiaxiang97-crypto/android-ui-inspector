import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;

/** Production controller and snapshot against fixed, fault-injectable Android adapters. */
public class InspectorControlledReadCheck extends InspectorObservationDiagnosticsCheck {
    static Runnable serializationHook, publicationHook;
    static class InspectorSnapshotJson {
        static String stringify(JSONObject value) { if (serializationHook != null) serializationHook.run(); return value.toString(); }
    }
    static class InspectorObservation extends InspectorObservationDiagnosticsCheck {
        static JSONObject capabilities(AccessibilityService service) { return new JSONObject().put("serviceInstanceId", service.serviceId); }
        static void publishControlledSnapshot(JSONObject result, java.util.function.Consumer<Runnable> completion) throws Exception {
            if (publicationHook != null) publicationHook.run();
            InspectorObservationDiagnosticsCheck.publishControlledSnapshot(result, completion);
        }
    }
    /* PRODUCTION_CONTROL */
    static final AccessibilityService service = new AccessibilityService();
    static JSONObject input() {
        return new JSONObject().put("version", 1).put("sessionId", "11111111-1111-4111-8111-111111111111")
            .put("requestId", UUID.randomUUID().toString()).put("serviceInstanceId", SERVICE_ID).put("packageName", "app.test").put("timeoutMs", 1000);
    }
    static String read(JSONObject input) throws Exception {
        JSONObject.body = input;
        return new String(InspectorReadControl.snapshot(service, input.toString(), "token-A", () -> scenario.authorized,
            new SnapshotTimings(System.nanoTime(), System.nanoTime())), StandardCharsets.UTF_8);
    }
    static JSONObject cancel(JSONObject input, String token) throws Exception {
        JSONObject.body = input;
        return InspectorReadControl.cancel(service, input.toString(), token, () -> scenario.authorized);
    }
    static Object inputCapture() throws Exception {
        java.lang.reflect.Field field = InspectorObservationDiagnosticsCheck.class.getDeclaredField("inputCapture");
        field.setAccessible(true); return field.get(null);
    }
    static void fresh() {
        reset().root.children.add(new AccessibilityNodeInfo());
        InspectorReadControl.READS.clear(); treeHook = pngHook = serializationHook = publicationHook = null;
    }
    static void await(CountDownLatch latch) {
        try { check(latch.await(3, TimeUnit.SECONDS), "checkpoint timeout"); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError(error); }
    }
    static void cancellation(String phase) throws Exception {
        fresh();
        // Clear any trusted legacy evidence before registering the controlled read.
        JSONObject request = input(); CountDownLatch reached = new CountDownLatch(1), release = new CountDownLatch(1);
        Runnable gate = () -> { reached.countDown(); await(release); };
        if (phase.equals("tree")) treeHook = gate;
        if (phase.equals("png")) pngHook = gate;
        if (phase.equals("json")) serializationHook = gate;
        if (phase.equals("publish")) publicationHook = gate;
        AtomicReference<String> result = new AtomicReference<>(); AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> { try { result.set(read(request)); } catch (Throwable error) { failure.set(error); } });
        worker.setDaemon(true); worker.start();
        try {
            await(reached);
            JSONObject wrong = input().put("requestId", request.getString("requestId"));
            wrong.put("sessionId", "44444444-4444-4444-8444-444444444444");
            check(!cancel(wrong, "token-A").getBoolean("success"), "foreign session cancelled read");
            check(!cancel(request, "token-B").getBoolean("success"), "foreign token cancelled read");
            check(cancel(request, "token-A").getString("state").equals("cancelled"), "cancel not accepted");
            check(cancel(request, "token-A").getString("state").equals("cancelled"), "cancel not idempotent");
            if (phase.equals("tree") || phase.equals("png")) {
                JSONObject busy = snapshot(service);
                check(!busy.getBoolean("success"), "canceller forcibly released worker lock");
            }
        } finally { release.countDown(); worker.join(3500); }
        check(!worker.isAlive() && failure.get() == null, "worker failed: " + failure.get());
        check(result.get().contains("errorCode=cancelled") && !result.get().contains("screenshot_base64"), "cancelled read published response");
        check(inputCapture() == null, "cancelled read registered input evidence");
        treeHook = pngHook = serializationHook = publicationHook = null;
        JSONObject next = input(); check(read(next).contains("snapshot="), "fresh read failed after cancellation");
        Object newer = inputCapture(); check(newer != null, "fresh complete read missing evidence");
        cancel(request, "token-A"); check(inputCapture() == newer, "late old cancel touched fresh read");
        check(scenario.actionCalls == 0, "unexpected input");
        System.out.println("checked controlled phase=" + phase + " cancelled=true lockOwnedByWorker=true freshRead=true inputs=0");
    }
    public static void main(String[] args) throws Exception {
        for (String phase : new String[]{"tree", "png", "json", "publish"}) cancellation(phase);
        fresh(); JSONObject before = input(); cancel(before, "token-A");
        check(read(before).contains("cancelled") && scenario.cacheCalls == 0, "cancel-before-start race lost");
        fresh(); JSONObject expired = input(); treeHook = () -> { SystemClock.tick += 1001; };
        check(read(expired).contains("timeout") && inputCapture() == null, "deadline published evidence");
        fresh(); treeHook = () -> { scenario.authorized = false; };
        check(read(input()).contains("authorization_changed") && inputCapture() == null, "revocation published evidence");
        fresh(); JSONObject complete = input(); check(read(complete).contains("snapshot="), "complete read failed");
        Object accepted = inputCapture();
        check(cancel(complete, "token-A").getString("state").equals("completed") && inputCapture() == accepted, "completed race changed result");
        check(read(complete).contains("duplicate_request") && inputCapture() == accepted, "duplicate request recaptured");
        fresh(); JSONObject queued = input(); JSONObject.body = queued; Object trusted = inputCapture();
        String queuedResult = new String(InspectorReadControl.snapshot(service, queued.toString(), "token-A", () -> true,
            new SnapshotTimings(System.nanoTime(), System.nanoTime()), 2000), StandardCharsets.UTF_8);
        check(queuedResult.contains("timeout") && scenario.cacheCalls == 0 && inputCapture() == trusted, "queue time escaped original budget");
        fresh(); JSONObject old = input(); CountDownLatch serialized = new CountDownLatch(1), resume = new CountDownLatch(1);
        serializationHook = () -> { if (Thread.currentThread().getName().equals("old")) { serialized.countDown(); await(resume); } };
        AtomicReference<String> late = new AtomicReference<>(); AtomicReference<Throwable> lateError = new AtomicReference<>();
        Thread older = new Thread(() -> { try { late.set(read(old)); } catch (Throwable e) { lateError.set(e); } }, "old");
        older.setDaemon(true); older.start();
        Object newer;
        try { await(serialized); check(snapshot(service).getJSONObject("helperObservation").getBoolean("complete"), "new legacy read failed"); newer = inputCapture(); }
        finally { resume.countDown(); older.join(3500); }
        check(!older.isAlive() && lateError.get() == null && late.get().contains("read_failed") && inputCapture() == newer,
            "late controlled publication replaced newer legacy capture");
        fresh(); JSONObject invalid = input().put("unknown", "private");
        check(read(invalid).contains("invalid_request"), "unknown field accepted");
        for (int i = 0; i < 32; i++) check(cancel(input(), "token-A").getBoolean("success"), "capacity unexpectedly exhausted");
        check(!cancel(input(), "token-A").getBoolean("success"), "registry unbounded");
        SystemClock.tick += 62000;
        check(cancel(input(), "token-A").getBoolean("success"), "expired tombstones not collected");
        System.out.println("checked identity, tombstone, deadline, revocation, completion race, replay and bounded registry");
    }
}

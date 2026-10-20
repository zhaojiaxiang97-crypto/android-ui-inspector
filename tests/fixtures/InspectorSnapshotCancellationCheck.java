import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.ReentrantLock;

/** Real loopback disconnects; production snapshot/serialization/send; fake Android adapters. */
public class InspectorSnapshotCancellationCheck extends InspectorObservationDiagnosticsCheck {
    static final CountDownLatch blocked = new CountDownLatch(1), release = new CountDownLatch(1);
    static final AtomicReference<Throwable> failure = new AtomicReference<>();
    static final List<Thread> workers = Collections.synchronizedList(new ArrayList<Thread>());
    static final Map<Integer, JSONObject> responses = new ConcurrentHashMap<>();
    static final Map<Integer, CountDownLatch> done = new ConcurrentHashMap<>();
    static volatile long blockedNs, cancelledNs, snapshotReturnedNs, finishedNs;
    static String phase;

    static void await(CountDownLatch latch) {
        try { check(latch.await(3, TimeUnit.SECONDS), "checkpoint deadline"); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AssertionError(e); }
    }
    static void checkpoint(String at) {
        if (!Thread.currentThread().getName().equals("request-1") || !phase.equals(at)) return;
        blockedNs = System.nanoTime(); blocked.countDown(); await(release);
    }
    static Object field(String name) throws Exception {
        java.lang.reflect.Field field = InspectorObservationDiagnosticsCheck.class.getDeclaredField(name);
        field.setAccessible(true); return field.get(null);
    }
    static boolean locked() throws Exception { return ((ReentrantLock) field("READS")).isLocked(); }
    static Socket connect(ServerSocket server) throws Exception {
        Socket client = new Socket(InetAddress.getLoopbackAddress(), server.getLocalPort());
        client.setSoTimeout(3000);
        client.getOutputStream().write("GET /inspector/snapshot HTTP/1.1\r\nHost: localhost\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        client.getOutputStream().flush(); return client;
    }
    static void handle(Socket socket, int id) {
        try (Socket owned = socket) {
            BufferedReader input = new BufferedReader(new InputStreamReader(owned.getInputStream(), StandardCharsets.US_ASCII));
            check("GET /inspector/snapshot HTTP/1.1".equals(input.readLine()), "unexpected test route");
            String line; while ((line = input.readLine()) != null && !line.isEmpty()) {}
            final OutputStream raw = owned.getOutputStream();
            OutputStream output = new OutputStream() {
                boolean first = true;
                public void write(int value) throws IOException { write(new byte[]{(byte)value}); }
                public void write(byte[] bytes) throws IOException {
                    if (first) { first = false; checkpoint("write"); }
                    raw.write(bytes);
                }
                public void flush() throws IOException { raw.flush(); }
            };
            AccessibilityService service = new AccessibilityService();
            long inspectorSubmittedNs = System.nanoTime(), inspectorWorkerStartedNs = inspectorSubmittedNs;
            /* PRODUCTION_SNAPSHOT_ROUTE */
        } catch (Throwable error) { failure.compareAndSet(null, error); }
        finally { if (id == 1) finishedNs = System.nanoTime(); done.get(id).countDown(); }
    }
    static String reason(int status) { return "OK"; }
    /* PRODUCTION_SEND */

    public static void main(String[] args) throws Exception {
        phase = args[0];
        check(Arrays.asList("tree", "png", "json", "write").contains(phase), "unknown phase");
        reset().root.children.add(new AccessibilityNodeInfo());
        treeHook = () -> checkpoint("tree"); pngHook = () -> checkpoint("png");
        final boolean expectedBusy = phase.equals("tree") || phase.equals("png");
        try (ServerSocket server = new ServerSocket(0, 8, InetAddress.getLoopbackAddress())) {
            for (int i = 1; i <= 3; i++) done.put(i, new CountDownLatch(1));
            Thread accept = new Thread(() -> {
                try {
                    for (int id = 1; id <= 3; id++) {
                        final Socket socket = server.accept(); final int request = id;
                        Thread worker = new Thread(() -> handle(socket, request), "request-" + id);
                        worker.setDaemon(true); workers.add(worker); worker.start();
                    }
                } catch (Throwable error) { failure.compareAndSet(null, error); }
            }, "accept");
            accept.setDaemon(true); accept.start();
            try {
                Socket abandoned = connect(server);
                await(blocked);
                check(locked() == expectedBusy, "wrong pre-disconnect lock phase");
                abandoned.setSoLinger(true, 0); abandoned.close(); cancelledNs = System.nanoTime();
                // Closing a client is deliberately not represented by interrupting the device worker.
                check(workers.get(0).isAlive() && locked() == expectedBusy, "disconnect unexpectedly ended work");
                try (Socket contender = connect(server)) { while (contender.getInputStream().read() != -1) {} }
                await(done.get(2));
                JSONObject next = responses.get(2); check(next != null, "missing contender response");
                check(next.getBoolean("success") != expectedBusy, "wrong busy/success response after disconnect");
                if (expectedBusy) {
                    check(!next.getBoolean("has_screenshot") && !next.getJSONObject("helperObservation").getBoolean("complete"), "busy response published evidence");
                    check(next.getJSONObject("helperObservation").getJSONObject("diagnostics").getJSONArray("reasons").length() == 0,
                        "busy baseline no longer has empty diagnostics");
                    check(field("inputCapture") == null, "busy read authorized input");
                }
                Object newerInput = field("inputCapture");
                release.countDown(); await(done.get(1));
                check(!locked() && snapshotReturnedNs > 0, "snapshot did not release lock");
                if (!expectedBusy) check(field("inputCapture") == newerInput, "late old response overwrote newer input identity");
                try (Socket fresh = connect(server)) { while (fresh.getInputStream().read() != -1) {} }
                await(done.get(3)); accept.join(3000);
                check(responses.get(3).getJSONObject("helperObservation").getBoolean("complete"), "fresh explicit read failed");
                check(!locked() && scenario.actionCalls == 0, "lock leak or unexpected input");
                check(failure.get() == null, "worker failed: " + failure.get());
                check(blockedNs <= cancelledNs && cancelledNs <= finishedNs, "event order invalid");
                System.out.println("checked phase=" + phase + " busyAfterDisconnect=" + expectedBusy
                    + " blockedNs=" + blockedNs + " clientClosedNs=" + cancelledNs
                    + " snapshotReturnedAfterUnlockNs=" + snapshotReturnedNs + " workerFinishedNs=" + finishedNs
                    + " inputs=0 freshRead=true");
            } finally {
                release.countDown(); server.close();
                for (Thread worker : workers) worker.join(3500);
            }
        }
    }
}

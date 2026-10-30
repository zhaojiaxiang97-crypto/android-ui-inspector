package com.androiduiinspector.sdk;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** Opt-in scalar diagnostics. Never reads Views, posts UI work or keeps a task history. */
public final class TreeQueueDiagnostics {
    public static final String PROTOCOL = "tree-queue-v1";
    public interface Clock { long now(); }
    public interface Sink { void write(String message); }
    private final Clock clock;
    private final Sink sink;
    private volatile Task latest;

    public TreeQueueDiagnostics(Clock clock, Sink sink) { this.clock = clock; this.sink = sink; }

    public synchronized Task begin(String request, String kind, int pid, String instance) {
        if (request == null || !(request.matches("[0-9a-f]{16}")
                || request.matches("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")))
            throw new IllegalArgumentException("Invalid tree diagnostic request");
        if (!("classic".equals(kind) || "merged".equals(kind)) || pid <= 0
                || instance == null || !instance.matches("[0-9a-fA-F-]{36}"))
            throw new IllegalArgumentException("Invalid tree diagnostic identity");
        if (latest != null && latest.snapshot().settledMs < 0)
            throw new IllegalStateException("Tree diagnostic already active");
        return latest = new Task(request, kind, pid, instance);
    }

    public Snapshot read(String request, String instance) {
        Task task = latest;
        if (task == null || !task.request.equals(request) || !task.instance.equals(instance)) return null;
        return task.snapshot();
    }

    public static final class Snapshot {
        public final String request, kind, instance;
        public final int pid;
        public final long postedMs, enteredMs, endedMs, settledMs, observedMs;
        Snapshot(Task task, long now) {
            request = task.request; kind = task.kind; instance = task.instance; pid = task.pid;
            postedMs = task.posted; enteredMs = task.entered; endedMs = task.ended;
            settledMs = task.settled; observedMs = now;
        }
        public String event(String phase) {
            return "{\"event\":\"tree-queue\",\"protocol\":\"" + PROTOCOL + "\",\"phase\":\"" + phase
                    + "\",\"requestId\":\"" + request + "\",\"kind\":\"" + kind + "\",\"pid\":" + pid
                    + ",\"processInstance\":\"" + instance + "\",\"postedMs\":" + postedMs
                    + ",\"enteredMs\":" + enteredMs + ",\"endedMs\":" + endedMs
                    + ",\"settledMs\":" + settledMs + ",\"observedMs\":" + observedMs + "}";
        }
    }

    public final class Task {
        final String request, kind, instance;
        final int pid;
        private long posted = -1, entered = -1, ended = -1, settled = -1;
        private ScheduledExecutorService timer;
        private ScheduledFuture<?> notice;
        Task(String request, String kind, int pid, String instance) {
            this.request = request; this.kind = kind; this.pid = pid; this.instance = instance;
        }
        public synchronized Snapshot snapshot() { return new Snapshot(this, clock.now()); }
        public synchronized void posted() {
            if (posted >= 0 || settled >= 0) return;
            posted = clock.now();
            timer = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread thread = new Thread(r, "inspector-tree-diagnostic"); thread.setDaemon(true); return thread;
            });
            notice = timer.schedule(() -> {
                Snapshot state = snapshot();
                if (state.enteredMs < 0 && state.settledMs < 0) emit(state, "queued");
            }, 500, TimeUnit.MILLISECONDS);
        }
        public void entered() {
            Snapshot state;
            synchronized (this) { if (settled >= 0) return; entered = clock.now(); cancelNotice(); state = snapshot(); }
            emit(state, "entered");
        }
        public synchronized void ended() { if (settled < 0) ended = clock.now(); }
        public void settle() {
            Snapshot state;
            synchronized (this) { if (settled >= 0) return; settled = clock.now(); cancelNotice(); state = snapshot(); }
            emit(state, "settled");
        }
        private void cancelNotice() {
            if (notice != null) notice.cancel(false);
            if (timer != null) timer.shutdown(); // Never interrupt the UI or a running notification.
        }
    }
    private void emit(Snapshot state, String phase) {
        try { sink.write(state.event(phase)); } catch (RuntimeException ignored) { /* diagnostics cannot fail capture */ }
    }
}

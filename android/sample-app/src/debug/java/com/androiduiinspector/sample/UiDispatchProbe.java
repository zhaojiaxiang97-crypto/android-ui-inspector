package com.androiduiinspector.sample;

import android.os.Handler;
import android.os.Looper;
import android.os.MessageQueue;
import org.json.JSONArray;
import org.json.JSONObject;
import org.lsposed.hiddenapibypass.HiddenApiBypass;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Controlled barriers only in the disposable Debug sample, never in the SDK. */
final class UiDispatchProbe {
    private static void waitFor(CountDownLatch latch) throws Exception {
        if (!latch.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Dispatch fixture timed out");
    }
    private static void onUi(Handler handler, Runnable action) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        if (!handler.post(() -> {
            try { action.run(); } catch (Throwable error) { failure.set(error); }
            finally { done.countDown(); }
        })) throw new IllegalStateException("Fixture UI unavailable");
        waitFor(done);
        if (failure.get() != null) throw new IllegalStateException("Fixture failed", failure.get());
    }
    private static final class Barrier {
        final MessageQueue queue = Looper.getMainLooper().getQueue();
        int token;
        boolean active;
        void install() {
            try {
                token = (int) HiddenApiBypass.invoke(MessageQueue.class, queue, "postSyncBarrier");
                active = true;
            } catch (Throwable error) { throw new IllegalStateException("Cannot install test barrier", error); }
        }
        void remove() {
            if (!active) return;
            try {
                HiddenApiBypass.invoke(MessageQueue.class, queue, "removeSyncBarrier", token);
                active = false;
            } catch (Throwable error) { throw new IllegalStateException("Cannot remove test barrier", error); }
        }
    }
    static JSONArray verify() throws Exception {
        if (android.os.Build.VERSION.SDK_INT < 28) throw new IllegalStateException("Fixture requires API 28");
        Handler asyncUi = Handler.createAsync(Looper.getMainLooper());
        JSONArray cases = new JSONArray();
        for (boolean async : new boolean[] { false, true }) {
            Barrier barrier = new Barrier();
            AtomicReference<Throwable> removalFailure = new AtomicReference<>();
            Runnable remove = () -> { try { barrier.remove(); } catch (Throwable error) { removalFailure.set(error); } };
            try {
                onUi(asyncUi, () -> {
                    // Queue the fail-safe BEFORE installing the barrier; it bypasses that barrier.
                    if (!asyncUi.postDelayed(remove, 200)) throw new IllegalStateException("No barrier fail-safe");
                    barrier.install();
                });
                AtomicBoolean activeAtCapture = new AtomicBoolean();
                UiTaskBatch.Result result = UiTaskBatch.capture(1, offset -> {
                    activeAtCapture.set(barrier.active); return new Object();
                }, frame -> { }, new AtomicBoolean(), async);
                if (activeAtCapture.get() != async) throw new IllegalStateException("Barrier order mismatch");
                cases.put(new JSONObject().put("case", "barrier").put("async", async)
                        .put("barrierActiveAtCapture", activeAtCapture.get()).put("queueNanos", result.queueNanos));
            } finally {
                onUi(asyncUi, barrier::remove);
                asyncUi.removeCallbacks(remove);
            }
            if (removalFailure.get() != null) throw new IllegalStateException("Fail-safe failed", removalFailure.get());
            if (barrier.active) throw new IllegalStateException("Barrier leaked");
        }
        for (boolean async : new boolean[] { false, true }) {
            CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), finished = new CountDownLatch(1);
            AtomicReference<Throwable> failure = new AtomicReference<>();
            asyncUi.post(() -> {
                entered.countDown();
                try { waitFor(release); } catch (Throwable error) { failure.set(error); }
                finally { finished.countDown(); }
            });
            waitFor(entered);
            Thread unblock = new Thread(() -> {
                try { Thread.sleep(120); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                finally { release.countDown(); }
            }, "dispatch-fixture-release");
            unblock.start();
            try {
                UiTaskBatch.Result result = UiTaskBatch.capture(1, offset -> {
                    if (finished.getCount() != 0) throw new IllegalStateException("UI work was preempted");
                    return new Object();
                }, frame -> { }, new AtomicBoolean(), async);
                cases.put(new JSONObject().put("case", "busy-ui").put("async", async)
                        .put("ranAfterBusyWork", true).put("queueNanos", result.queueNanos));
            } finally { release.countDown(); unblock.join(1000); waitFor(finished); }
            if (failure.get() != null) throw new IllegalStateException("Busy fixture failed", failure.get());
        }
        onUi(asyncUi, () -> { });
        return cases;
    }
}

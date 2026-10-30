package com.androiduiinspector.sample;

import android.os.Handler;
import android.os.Looper;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Debug experiment only: independent SDK captures share a post, never a canvas. */
final class UiTaskBatch {
    interface Capture { Object run(int offset) throws Exception; }
    interface Recycle { void run(Object frame) throws Exception; }
    static final class Result {
        final ArrayList<Object> frames;
        final long queueNanos, taskNanos;
        Result(ArrayList<Object> frames, long queueNanos, long taskNanos) {
            this.frames = frames; this.queueNanos = queueNanos; this.taskNanos = taskNanos;
        }
    }
    static Result capture(int limit, Capture capture, Recycle recycle, AtomicBoolean cancelled) throws Exception {
        return capture(limit, capture, recycle, cancelled, false);
    }
    static Result capture(int limit, Capture capture, Recycle recycle, AtomicBoolean cancelled, boolean async) throws Exception {
        if (async && android.os.Build.VERSION.SDK_INT < 28)
            throw new IllegalStateException("Async experiment requires API 28");
        Handler handler = async ? Handler.createAsync(Looper.getMainLooper()) : new Handler(Looper.getMainLooper());
        if (limit < 1 || limit > 2 || Looper.myLooper() == Looper.getMainLooper())
            throw new IllegalArgumentException("Batch requires worker caller and 1–2 frames");
        final Object lock = new Object();
        final boolean[] abandoned = { false };
        AtomicReference<Result> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        long posted = System.nanoTime();
        if (!handler.post(() -> {
            ArrayList<Object> frames = new ArrayList<>();
            long entered = System.nanoTime();
            try {
                for (int i = 0; i < limit; i++) {
                    synchronized (lock) { if (abandoned[0] || cancelled.get()) return; }
                    // Soft admission budget: cannot preempt a single SDK snapshot call.
                    if (i > 0 && System.nanoTime() - entered >= 8_000_000) break;
                    Object frame = capture.run(i);
                    if (frame == null) throw new IllegalStateException("Batch View changed");
                    frames.add(frame);
                }
                synchronized (lock) {
                    if (!abandoned[0] && !cancelled.get()) {
                        result.set(new Result(new ArrayList<>(frames), entered - posted, System.nanoTime() - entered));
                        frames.clear(); // Ownership transfers only for the entire completed task.
                    }
                }
            } catch (Throwable error) { failure.set(error); }
            finally {
                for (Object frame : frames) try { recycle.run(frame); } catch (Exception error) { failure.compareAndSet(null, error); }
                ready.countDown();
            }
        })) throw new IllegalStateException("Batch UI thread unavailable");
        try {
            while (!ready.await(50, TimeUnit.MILLISECONDS)) {
                if (cancelled.get()) throw new InterruptedException("Batch canceled");
                if (System.nanoTime() - posted >= 3_000_000_000L) throw new IllegalStateException("Batch UI task timed out");
            }
            if (cancelled.get()) throw new InterruptedException("Batch canceled");
            if (failure.get() != null) throw new IllegalStateException("Batch capture failed", failure.get());
            Result candidate = result.get();
            if (candidate != null && candidate.queueNanos + candidate.taskNanos >= 3_000_000_000L)
                throw new IllegalStateException("Batch UI task timed out");
            Result answer = result.getAndSet(null);
            if (answer == null || answer.frames.isEmpty()) throw new IllegalStateException("Batch returned no frames");
            return answer;
        } catch (Exception error) {
            synchronized (lock) {
                abandoned[0] = true;
                Result late = result.getAndSet(null);
                if (late != null) for (Object frame : late.frames) try { recycle.run(frame); }
                    catch (Exception cleanup) { error.addSuppressed(cleanup); }
            }
            // Cancellation does not interrupt the owning UI thread or recycle its active bitmap.
            throw error;
        }
    }
}

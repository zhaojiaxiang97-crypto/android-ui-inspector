package com.androiduiinspector.sample;

import android.graphics.Bitmap;
import android.view.View;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/** Faults run in their own sample process, never before a performance comparison. */
final class HardwareReuseSafety {
    static JSONObject verify(View target, View wrongSize, SnapshotPixelHash pixels, byte[] reference) throws Exception {
        JSONArray cases = new JSONArray();
        ReusableHardwareCapture renderer = new ReusableHardwareCapture();
        try {
            UiTaskBatch.Result basic = UiTaskBatch.capture(1, offset -> {
                Bitmap initial = renderer.capture(target); initial.recycle();
                reject(() -> renderer.capture(wrongSize));
                cases.put(new JSONObject().put("case", "wrong-size").put("rejected", true));
                AtomicBoolean hook = new AtomicBoolean();
                renderer.beforeReadback = () -> {
                    require(renderer.active && renderer.acquiredImages == 1, "Readback does not own image");
                    try { reject(() -> renderer.capture(target)); reject(() -> { renderer.close(); return null; }); }
                    catch (Exception failure) { throw new IllegalStateException(failure); }
                    hook.set(true); throw new IllegalStateException("injected-readback");
                };
                try { reject(() -> renderer.capture(target)); }
                finally { renderer.beforeReadback = null; }
                require(hook.get() && renderer.acquiredImages == 0 && !renderer.active && !renderer.closed, "Fault cleanup failed");
                cases.put(new JSONObject().put("case", "occupied-image-reentry-close").put("rejected", true).put("imageReleased", true));
                cases.put(new JSONObject().put("case", "readback-failure").put("rejected", true).put("imageReleased", true));
                return renderer.capture(target);
            }, item -> ((Bitmap) item).recycle(), new AtomicBoolean());
            Bitmap recovered = (Bitmap) basic.frames.get(0);
            try { require(Arrays.equals(pixels.digest(recovered), reference), "Fault recovery pixels differ"); }
            finally { recovered.recycle(); }
        } finally { close(renderer); }
        UiTaskBatch.capture(1, offset -> {
            reject(() -> renderer.capture(target)); renderer.close();
            return Boolean.TRUE;
        }, item -> {}, new AtomicBoolean());
        cases.put(new JSONObject().put("case", "closed-renderer").put("rejected", true));
        for (String mode : new String[]{"cancel-before", "cancel-active", "timeout-late"}) cases.put(late(target, mode));
        return new JSONObject().put("cases", cases).put("recoveredPixelsVerified", true).put("resourcesClosed", true)
                .put("productionSdkChanged", false).put("saturatedBufferQueueTested", false);
    }

    private static JSONObject late(View view, String mode) throws Exception {
        ReusableHardwareCapture renderer = new ReusableHardwareCapture();
        AtomicBoolean canceled = new AtomicBoolean(mode.equals("cancel-before"));
        AtomicReference<Bitmap> returned = new AtomicReference<>();
        AtomicInteger recycled = new AtomicInteger();
        CountDownLatch acquired = new CountDownLatch(1), release = new CountDownLatch(1);
        Thread canceler = mode.equals("cancel-active") ? new Thread(() -> {
            try { if (acquired.await(3, TimeUnit.SECONDS)) canceled.set(true); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }, "sample-reuse-cancel") : null;
        if (canceler != null) canceler.start();
        boolean stopped = false;
        try {
            UiTaskBatch.Result result = UiTaskBatch.capture(1, offset -> {
                Bitmap bitmap = renderer.capture(view); returned.set(bitmap); acquired.countDown();
                try {
                    if (mode.equals("timeout-late")) Thread.sleep(3200);
                    else if (mode.equals("cancel-active") && !release.await(5, TimeUnit.SECONDS))
                        throw new IllegalStateException("Cancel fixture release expired");
                    return bitmap;
                } catch (Throwable failure) { bitmap.recycle(); throw failure; }
            }, item -> { ((Bitmap) item).recycle(); recycled.incrementAndGet(); }, canceled);
            for (Object frame : result.frames) ((Bitmap) frame).recycle();
        } catch (Exception error) {
            if (mode.equals("timeout-late")) require(error.toString().contains("timed out"), "Expected actual UI timeout");
            else require(canceled.get(), "Expected actual cancellation");
            stopped = true;
        } finally {
            release.countDown();
            try {
                if (canceler != null) { canceler.join(1000); require(!canceler.isAlive(), "Cancel thread leaked"); }
            } finally { close(renderer); }
        }
        require(stopped && renderer.closed && renderer.acquiredImages == 0 && !renderer.active, "Late task not safely closed");
        int expected = mode.equals("cancel-before") ? 0 : 1;
        require(renderer.captures == expected && recycled.get() == expected, "Late result accepted or leaked");
        require(returned.get() == null || returned.get().isRecycled(), "Late bitmap remains owned");
        return new JSONObject().put("case", mode).put("rejected", true).put("callerStopped", true)
                .put("lateResultsRecycled", recycled.get()).put("resourcesClosed", renderer.closed);
    }
    private static void close(ReusableHardwareCapture renderer) throws Exception {
        UiTaskBatch.capture(1, offset -> { renderer.close(); return Boolean.TRUE; }, item -> {}, new AtomicBoolean());
    }
    interface Attempt { Object run() throws Exception; }
    private static void reject(Attempt attempt) throws Exception {
        boolean rejected = false;
        try { Object result = attempt.run(); if (result instanceof Bitmap) ((Bitmap) result).recycle(); }
        catch (Exception expected) { rejected = true; }
        require(rejected, "Unsafe operation accepted");
    }
    private static void require(boolean value, String message) {
        if (!value) throw new IllegalStateException(message);
    }
}

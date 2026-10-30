package com.androiduiinspector.sdk;

import android.app.Activity;
import android.app.Application;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.DataOutputStream;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLong;

/** Debug-source-set contract for sample experiments; absent from the release AAR.
 * Handles preserve the production bitmap/record ownership. No capture policy lives here. */
public final class DebugCaptureProbe {
    private DebugCaptureProbe() {}

    public static final class Timing {
        private final CaptureFrame.CaptureTiming value = new CaptureFrame.CaptureTiming();
        public AtomicLong counter(String name) {
            switch (name) {
                case "queue": return value.queue;
                case "context": return value.context;
                case "contextCpu": return value.contextCpu;
                case "draw": return value.draw;
                case "drawCpu": return value.drawCpu;
                case "verify": return value.verify;
                case "verifyCpu": return value.verifyCpu;
                case "uiTaskMax": return value.uiTaskMax;
                case "snapshotPrepare": return value.snapshotPrepare;
                case "snapshotInvoke": return value.snapshotInvoke;
                case "snapshotInvokeMax": return value.snapshotInvokeMax;
                default: throw new IllegalArgumentException("Unknown probe timing: " + name);
            }
        }
        public void reply(Bundle answer) { value.reply(answer); }
        public void cpuUnavailable() { value.cpuAvailable.set(false); }
    }

    public static final class Geometry {
        private final CaptureGeometrySnapshot value;
        private Geometry(CaptureGeometrySnapshot value) { this.value = value; }
        public JSONObject json(long started, long ended) throws Exception { return value.json(started, ended); }
        public boolean matches(View view, View root, IdentityHashMap<View, String> identities) throws Exception {
            return value.matches(view, root, identities);
        }
    }

    public static final class Frame {
        public final Bitmap bitmap;
        public final int x, y;
        public final JSONObject geometry;
        public final Geometry immutableGeometry;
        public final long started, ended;
        private Frame(CaptureFrame.CapturedFrame value) {
            bitmap = value.bitmap; x = value.x; y = value.y; geometry = value.geometry;
            immutableGeometry = value.immutableGeometry == null ? null : new Geometry(value.immutableGeometry);
            started = value.started; ended = value.ended;
        }
    }

    public static Frame capture(View view, View root, boolean evidence, Timing timing, boolean immutable) throws Exception {
        CaptureFrame.CapturedFrame frame = CaptureFrame.captureFrame(view, root, evidence, timing.value, immutable);
        return frame == null ? null : new Frame(frame);
    }
    public static Frame captureOnUi(View view, View root, boolean debugCanvas, boolean evidence, Timing timing, boolean immutable) throws Exception {
        CaptureFrame.CapturedFrame frame = CaptureFrame.captureFrameOnUiThread(view, root, debugCanvas, evidence, timing.value, immutable);
        return frame == null ? null : new Frame(frame);
    }
    public static Frame frame(Bitmap bitmap, int x, int y, Geometry geometry, long started, long ended) {
        return new Frame(new CaptureFrame.CapturedFrame(bitmap, x, y, null, geometry.value, started, ended));
    }
    public static Geometry readGeometry(View view, View root, IdentityHashMap<View, String> identities) throws Exception {
        return new Geometry(CaptureGeometrySnapshot.read(view, root, identities));
    }
    public static JSONArray legacyParentContext(View view, View root, JSONArray clips) throws Exception {
        return CaptureFrame.captureParentContext(view, root, clips);
    }
    public static boolean supportsRectangle(View view, View root) { return CaptureFrame.supportsRectangleContext(view, root); }
    public static Bitmap debugSnapshot(View view, long[] phases) throws Exception { return IsolatedCapture.debugSnapshot(view, phases); }

    public static final class EncodedLayer {
        private final CaptureOutput.VisibleRecord value;
        private EncodedLayer(CaptureOutput.VisibleRecord value) { this.value = value; }
        public byte[] bytes() { return value.image; }
        public EncodedLayer withGeometry(String json, int bytes) {
            return new EncodedLayer(new CaptureOutput.VisibleRecord(value.ref, value.x, value.y,
                    value.image, value.crc, value.webp, json, bytes));
        }
    }
    /** Transfers ownership: the production encoder recycles the supplied bitmap. */
    public static EncodedLayer encode(Bitmap bitmap, String ref, int x, int y, boolean webp, AtomicLong encodeMs) {
        return new EncodedLayer(CaptureOutput.encodeVisibleLayer(bitmap, ref, x, y, webp, encodeMs));
    }
    public static int writeRecord(DataOutputStream output, EncodedLayer layer) throws Exception {
        return CaptureOutput.writeVisibleRecord(output, CompletableFuture.completedFuture(layer.value));
    }
    public static final class GeometryRecords {
        private final CaptureOutput.GeometryRecords value = new CaptureOutput.GeometryRecords();
        public void add(EncodedLayer layer) { value.add(layer.value); }
        public String finish() { return value.finish(); }
    }
    public static void registerPending(HashSet<Bitmap> pending, Bitmap bitmap) { CaptureOutput.registerPendingBitmap(pending, bitmap); }
    public static boolean claimPending(HashSet<Bitmap> pending, Bitmap bitmap) { return CaptureOutput.claimPendingBitmap(pending, bitmap); }
    public static void recyclePending(HashSet<Bitmap> pending) { CaptureOutput.recyclePendingBitmaps(pending); }

    /** Same lifecycle-backed capture owner as the real Provider; caller supplies UI-thread resume. */
    public static final class Owner {
        private final HierarchyProvider provider = new HierarchyProvider();
        public void resumed(Activity activity) { provider.onActivityResumed(activity); }
        public String processInstance() { return provider.captureForProbe().probeProcessInstance(); }
        public void verifyRoot(View root) throws Exception { provider.captureForProbe().verifyCaptureRoot(root); }
        public void writeGeometry(Application app, String nonce, String rootRef, String records, Bundle answer) throws Exception {
            new CaptureOutput(processInstance()).writeGeometryFile(app, nonce, rootRef, records, answer);
        }
        public Bundle captureVisible(Application app, String nonce, Bundle extras) {
            return provider.captureForProbe().captureVisible(app, nonce, extras);
        }
        public Bundle captureRefs(Application app, String refs, Bundle extras) {
            return provider.captureForProbe().captureRefs(app, refs, extras);
        }
    }
}

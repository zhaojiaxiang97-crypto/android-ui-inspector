package com.androiduiinspector.sample;

import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.graphics.HardwareRenderer;
import android.graphics.Picture;
import android.graphics.PixelFormat;
import android.graphics.RecordingCanvas;
import android.graphics.RenderNode;
import android.hardware.HardwareBuffer;
import android.media.Image;
import android.media.ImageReader;
import android.os.Looper;
import android.view.View;
import java.lang.reflect.Proxy;
import org.lsposed.hiddenapibypass.HiddenApiBypass;

/** Debug-only pixel gate. One fixed-size offscreen renderer, not an atlas or a production pool. */
final class ReusableHardwareCapture {
    private ImageReader reader;
    private HardwareRenderer renderer;
    private RenderNode node;
    private Picture recording;
    private int width, height;
    int creations, captures;
    int acquiredImages;
    boolean active;
    Runnable beforeReadback; // Debug fault injection only, never set by performance/gate callers.
    boolean closed;

    Bitmap capture(View view) throws Exception {
        requireUi();
        if (closed || active || android.os.Build.VERSION.SDK_INT < 29 || !view.isHardwareAccelerated())
            throw new IllegalStateException("Reusable renderer unavailable");
        int w = view.getWidth(), h = view.getHeight();
        if ((long) w * h <= 0 || (long) w * h > 4_000_000)
            throw new IllegalStateException("Reusable capture exceeds SDK pixel budget");
        if (reader == null) initialize(w, h);
        if (w != width || h != height) throw new IllegalStateException("Fixed-size target changed");
        Class<?> type = Class.forName("android.view.ViewDebug$CanvasProvider");
        Object provider = Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (proxy, method, args) -> {
            if (method.getName().equals("getCanvas")) {
                if ((int) args[1] != width || (int) args[2] != height || recording != null)
                    throw new IllegalStateException("Unexpected recording dimensions/state");
                recording = new Picture();
                return recording.beginRecording(width, height); // Fresh independent canvas per View.
            }
            if (method.getName().equals("createBitmap")) return render();
            throw new UnsupportedOperationException(method.getName());
        });
        active = true;
        try {
            Bitmap result = (Bitmap) HiddenApiBypass.invoke(View.class, view, "createSnapshot", provider, true);
            if (result == null) throw new IllegalStateException("Reusable snapshot missing");
            captures++;
            return result; // Detached CPU copy; no returned bitmap aliases the reusable buffer.
        } finally {
            try { if (recording != null) { recording.endRecording(); recording = null; } }
            finally { active = false; }
        }
    }

    private void initialize(int w, int h) {
        width = w; height = h;
        try {
            reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2,
                    HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE | HardwareBuffer.USAGE_GPU_COLOR_OUTPUT);
            node = new RenderNode("InspectorSampleTemporary");
            node.setPosition(0, 0, w, h);
            node.setClipToBounds(false);
            node.setForceDarkAllowed(false);
            renderer = new HardwareRenderer();
            renderer.setOpaque(false); // Clear transparent each frame; never preserve previous View pixels.
            renderer.setLightSourceAlpha(0, 0);
            renderer.setLightSourceGeometry(0, 0, 0, 0);
            renderer.setContentRoot(node);
            renderer.setSurface(reader.getSurface());
            creations++;
        } catch (Throwable failure) { close(); throw failure; }
    }

    private Bitmap render() {
        if (recording == null) throw new IllegalStateException("Missing independent Picture");
        recording.endRecording();
        RecordingCanvas canvas = node.beginRecording(width, height);
        try { canvas.drawPicture(recording); } finally { node.endRecording(); }
        // No global vsync settings, retry, or background frame listener.
        int status = renderer.createRenderRequest().setVsyncTime(System.nanoTime()).setWaitForPresent(true).syncAndDraw();
        if (status != HardwareRenderer.SYNC_OK) throw new IllegalStateException("Offscreen frame not committed: " + status);
        try (Image image = reader.acquireNextImage()) {
            if (image == null || image.getWidth() != width || image.getHeight() != height)
                throw new IllegalStateException("Missing/wrong offscreen image");
            acquiredImages++;
            try (HardwareBuffer buffer = image.getHardwareBuffer()) {
                if (buffer == null) throw new IllegalStateException("Hardware buffer missing");
                Bitmap wrapped = Bitmap.wrapHardwareBuffer(buffer, ColorSpace.get(ColorSpace.Named.SRGB));
                if (wrapped == null) throw new IllegalStateException("Hardware bitmap missing");
                try {
                    if (beforeReadback != null) beforeReadback.run();
                    Bitmap result = wrapped.copy(Bitmap.Config.ARGB_8888, false);
                    if (result == null) throw new IllegalStateException("Hardware readback failed");
                    return result;
                } finally { wrapped.recycle(); }
            } finally { acquiredImages--; }
        }
    }

    void close() {
        requireUi();
        if (active || acquiredImages != 0) throw new IllegalStateException("Renderer/buffer still owned by active draw");
        try { if (renderer != null) renderer.destroy(); }
        finally {
            renderer = null;
            try { if (reader != null) reader.close(); }
            finally {
                reader = null;
                if (node != null) node.discardDisplayList();
                node = null; closed = true;
            }
        }
    }
    private static void requireUi() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Renderer requires UI owner");
    }
}

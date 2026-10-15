package com.androiduiinspector.sdk;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Outline;
import android.graphics.Rect;
import android.view.SurfaceView;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;

import org.lsposed.hiddenapibypass.HiddenApiBypass;
import java.util.ArrayDeque;

/** Debug-only own/group snapshots. Never substitutes a descendant-inclusive bitmap for an own bitmap. */
public final class IsolatedCapture {
    private static final int MAX_PIXELS = 4_000_000;

    private IsolatedCapture() {}

    public static Bitmap group(View view) {
        checkSize(view);
        // External Surface/Texture buffers are not part of View snapshots; never present an incomplete group as exact.
        ArrayDeque<View> pending = new ArrayDeque<>();
        pending.add(view);
        while (!pending.isEmpty()) {
            View child = pending.removeFirst();
            if (child instanceof SurfaceView || child instanceof TextureView)
                throw new UnsupportedOperationException("Group contains a separate Surface/Texture buffer");
            if (child.getClipToOutline()) {
                Outline outline = new Outline();
                if (child.getOutlineProvider() != null) child.getOutlineProvider().getOutline(child, outline);
                Rect rect = new Rect();
                if (!outline.canClip() || !outline.getRect(rect) || outline.getRadius() != 0
                        || rect.left != 0 || rect.top != 0 || rect.right != child.getWidth() || rect.bottom != child.getHeight())
                    throw new UnsupportedOperationException("Complex outline clipping is not validated for group snapshots");
            }
            if (child instanceof ViewGroup) {
                ViewGroup parent = (ViewGroup) child;
                for (int i = 0; i < parent.getChildCount(); i++) pending.addLast(parent.getChildAt(i));
            }
        }
        // Use the same backend as an own container snapshot, but include its children.
        // Failure propagates; a software redraw must not silently masquerade as an exact group.
        try { return snapshot(view, false); }
        catch (ReflectiveOperationException error) {
            throw new IllegalStateException("Matched-backend group snapshot is unavailable", error);
        }
    }

    private static Bitmap softwareOwn(View view) {
        Bitmap bitmap = Bitmap.createBitmap(view.getWidth(), view.getHeight(), Bitmap.Config.ARGB_8888);
        try {
            view.draw(new Canvas(bitmap));
            return bitmap;
        } catch (RuntimeException error) {
            bitmap.recycle();
            throw error;
        }
    }

    public static Bitmap own(View view) throws ReflectiveOperationException {
        if (view instanceof SurfaceView || view instanceof TextureView) {
            throw new UnsupportedOperationException("Separate surface/texture content needs a dedicated capture path");
        }
        checkSize(view);
        // Hardware leaves must use the same gradient/text rasterizer as their owning window.
        // Keep the direct draw path only for genuinely software-rendered, unclipped leaves.
        if (!view.isHardwareAccelerated() && !(view instanceof ViewGroup) && !view.getClipToOutline()) return softwareOwn(view);
        return snapshot(view, view instanceof ViewGroup);
    }

    /** Same canvas choice as ViewDebug.performViewCapture; caller must run on the UI thread. */
    static Bitmap debugSnapshot(View view) throws ReflectiveOperationException {
        return debugSnapshot(view, null);
    }

    static Bitmap debugSnapshot(View view, long[] phases) throws ReflectiveOperationException {
        return debugSnapshot(view, phases, null);
    }

    static Bitmap debugSnapshot(View view, long[] phases, java.util.concurrent.atomic.AtomicReference<CaptureFrame.CapturePhase> phase) throws ReflectiveOperationException {
        CaptureFrame.CapturePhase.enter(phase, "draw-prepare");
        checkSize(view);
        long prepared = System.nanoTime();
        String providerName = view.isHardwareAccelerated() ? "HardwareCanvasProvider" : "SoftwareCanvasProvider";
        Object provider = HiddenApiBypass.newInstance(Class.forName("android.view.ViewDebug$" + providerName));
        if (phases != null) phases[0] += System.nanoTime() - prepared;
        long invoked = System.nanoTime();
        CaptureFrame.CapturePhase.enter(phase, "draw-snapshot");
        try { return (Bitmap) HiddenApiBypass.invoke(View.class, view, "createSnapshot", provider, true); }
        finally {
            CaptureFrame.CapturePhase.snapshotReturned(phase);
            if (phases != null) phases[1] += System.nanoTime() - invoked;
        }
    }

    private static Bitmap snapshot(View view, boolean skipChildren) throws ReflectiveOperationException {
        // Debug-only: call the exact hidden snapshot API without changing device-wide policy.
        String providerName = view.isHardwareAccelerated() ? "HardwareCanvasProvider" : "SoftwareCanvasProvider";
        Object provider = HiddenApiBypass.newInstance(Class.forName("android.view.ViewDebug$" + providerName));
        Bitmap snapshot = (Bitmap) HiddenApiBypass.invoke(View.class, view, "createSnapshot", provider, skipChildren);
        if (snapshot == null) throw new IllegalStateException("View returned no snapshot bitmap");
        try {
            Bitmap pixels = snapshot.copy(Bitmap.Config.ARGB_8888, false);
            if (pixels == null) throw new IllegalStateException("Unable to read own bitmap pixels");
            return pixels;
        } finally {
            snapshot.recycle();
        }
    }

    private static void checkSize(View view) {
        long pixels = (long) view.getWidth() * view.getHeight();
        if (pixels <= 0 || pixels > MAX_PIXELS) throw new IllegalArgumentException("View size exceeds capture budget");
    }
}

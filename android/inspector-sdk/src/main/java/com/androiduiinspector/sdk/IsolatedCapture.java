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

/** Early capability probe. Never substitutes a descendant-inclusive bitmap for an own bitmap. */
public final class IsolatedCapture {
    private static final int MAX_PIXELS = 4_000_000;

    private IsolatedCapture() {}

    public static Bitmap group(View view) {
        checkSize(view);
        // External Surface/Texture buffers are not part of View.draw; never present an incomplete group as exact.
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
                    throw new UnsupportedOperationException("View.draw omits outline clipping in group captures");
            }
            if (child instanceof ViewGroup) {
                ViewGroup parent = (ViewGroup) child;
                for (int i = 0; i < parent.getChildCount(); i++) pending.addLast(parent.getChildAt(i));
            }
        }
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
        if (!(view instanceof ViewGroup) && !view.getClipToOutline()) return group(view);
        return snapshot(view, view instanceof ViewGroup);
    }

    private static Bitmap snapshot(View view, boolean skipChildren) throws ReflectiveOperationException {
        // Debug-only: call the exact hidden snapshot API without changing device-wide policy.
        Class<?> hardwareType = Class.forName("android.view.ViewDebug$HardwareCanvasProvider");
        Object provider = HiddenApiBypass.newInstance(hardwareType);
        Bitmap snapshot = (Bitmap) HiddenApiBypass.invoke(View.class, view, "createSnapshot", provider, skipChildren);
        if (snapshot == null) throw new IllegalStateException("View returned no own bitmap");
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

package com.androiduiinspector.sdk;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.SurfaceView;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;

import org.lsposed.hiddenapibypass.HiddenApiBypass;

/** Early capability probe. Never substitutes a descendant-inclusive bitmap for an own bitmap. */
public final class IsolatedCapture {
    private static final int MAX_PIXELS = 4_000_000;

    private IsolatedCapture() {}

    public static Bitmap group(View view) {
        checkSize(view);
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
        if (!(view instanceof ViewGroup)) return group(view);
        // Debug-only: call the exact hidden snapshot API without changing device-wide policy.
        Class<?> hardwareType = Class.forName("android.view.ViewDebug$HardwareCanvasProvider");
        Object provider = HiddenApiBypass.newInstance(hardwareType);
        Bitmap snapshot = (Bitmap) HiddenApiBypass.invoke(View.class, view, "createSnapshot", provider, true);
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

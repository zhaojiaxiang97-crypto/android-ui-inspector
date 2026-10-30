package com.artemis.helper;

import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

/** Fast path for proven opaque sRGB pixels; all other color/alpha formats use Android's encoder. */
public final class InspectorPngEncoder {
    private InspectorPngEncoder() {}
    private static final class NativeAlphaRequired extends IOException {}

    public static byte[] encode(final Bitmap bitmap) throws IOException {
        if (bitmap == null || bitmap.isRecycled()) throw new IOException("PNG bitmap unavailable");
        InspectorPngCodec.checkDimensions(bitmap.getWidth(), bitmap.getHeight());
        InspectorPngCodec.checkInterrupted();
        ByteArrayOutputStream output = new ByteArrayOutputStream(8192);
        if (canReadExactSrgb(bitmap)) {
            try {
                InspectorPngCodec.encode(bitmap.getWidth(), bitmap.getHeight(), new InspectorPngCodec.Rows() {
                    @Override public void read(int y, int[] pixels) throws IOException {
                        // Android documents getPixels as non-premultiplied sRGB ARGB.
                        // Stay opaque to avoid differences in native/getPixels unpremultiply rounding.
                        bitmap.getPixels(pixels, 0, pixels.length, 0, y, pixels.length, 1);
                        for (int color : pixels) if ((color >>> 24) != 255) throw new NativeAlphaRequired();
                    }
                }, output);
                return output.toByteArray();
            } catch (NativeAlphaRequired | InspectorPngCodec.SizeLimit fallback) {
                // Discard the entire partial PNG. Native compression may fit when level 1 does not.
                output.reset();
            }
        }
        InspectorPngCodec.checkInterrupted();
        // PNG quality is ignored by Android. Preserve the original bitmap/config/color space.
        if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, new InspectorPngCodec.LimitedOutput(output)))
            throw new IOException("Native PNG encoding failed");
        InspectorPngCodec.checkInterrupted();
        return output.toByteArray();
    }

    private static boolean canReadExactSrgb(Bitmap bitmap) {
        if (Build.VERSION.SDK_INT < 26 || bitmap.getConfig() != Bitmap.Config.ARGB_8888) return false;
        ColorSpace space = bitmap.getColorSpace();
        return space != null && space.isSrgb();
    }
}

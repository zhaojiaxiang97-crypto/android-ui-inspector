package com.androiduiinspector.sdk;

import java.util.ArrayList;
import static com.androiduiinspector.sdk.CaptureFrame.RefLayer;

/** Keeps prepared ref bitmaps until submitted, including partial or late UI results. */
final class RefCaptureSelection implements AutoCloseable {
    private ArrayList<RefLayer> layers;
    private boolean closed;

    synchronized void complete(ArrayList<RefLayer> result) {
        if (closed) recycle(result);
        else layers = result;
    }

    synchronized ArrayList<RefLayer> get() { return layers; }

    private static void recycle(ArrayList<RefLayer> layers) {
        if (layers == null) return;
        for (RefLayer layer : layers) {
            if (layer.bitmap == null) continue;
            if (!layer.bitmap.isRecycled()) layer.bitmap.recycle();
            layer.bitmap = null;
        }
    }

    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        recycle(layers);
        layers = null;
    }
}

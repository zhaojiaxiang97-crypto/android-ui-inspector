package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.SurfaceTexture;
import android.os.Bundle;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.TextureView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Standalone fixture: Android APIs only, so baseline and new SDKs use identical inputs. */
public final class PipelineContractActivity extends Activity {
    private final CountDownLatch buffers = new CountDownLatch(2);
    private final AtomicBoolean delayed = new AtomicBoolean();
    private String token;
    private boolean timeout;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        token = getIntent().getStringExtra("probeToken");
        if (token == null || !token.matches("[0-9a-f]{16}")) { finish(); return; }
        timeout = getIntent().getBooleanExtra("captureTimeout", false);
        LinearLayout page = new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(0xffeeeeee);
        LinearLayout row = new LinearLayout(this);
        SurfaceView surface = new SurfaceView(this);
        surface.getHolder().addCallback(new SurfaceHolder.Callback() {
            @Override public void surfaceCreated(SurfaceHolder holder) {
                Canvas canvas = holder.lockCanvas();
                if (canvas == null) return;
                try { canvas.drawColor(0xff00b428); }
                finally { holder.unlockCanvasAndPost(canvas); buffers.countDown(); }
            }
            @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}
            @Override public void surfaceDestroyed(SurfaceHolder holder) {}
        });
        TextureView texture = new TextureView(this);
        texture.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture value, int width, int height) {
                Canvas canvas = texture.lockCanvas();
                if (canvas == null) return;
                try { canvas.drawColor(0xff285adc); }
                finally { texture.unlockCanvasAndPost(canvas); buffers.countDown(); }
            }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture value, int width, int height) {}
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture value) { return true; }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture value) {}
        });
        row.addView(surface, new LinearLayout.LayoutParams(128, 64));
        row.addView(texture, new LinearLayout.LayoutParams(128, 64));
        page.addView(row);
        for (int i = 0; i < 12; i++) {
            TextView text = i == 11 ? new DelayedText() : new TextView(this);
            text.setText("Pipeline " + i); text.setTextColor(0xff164a92); text.setTextSize(12);
            page.addView(text, new LinearLayout.LayoutParams(220, 30));
        }
        setContentView(page);
        new Thread(() -> {
            try {
                if (!buffers.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Sample buffers did not become ready");
                runOnUiThread(() -> {
                    try { getWindow().getDecorView().setClipToOutline(false); report("ready", null); }
                    catch (Exception error) { report("failed", error); }
                });
            } catch (Exception error) { report("failed", error); }
        }, "pipeline-fixture-ready").start();
    }

    private final class DelayedText extends TextView {
        DelayedText() { super(PipelineContractActivity.this); }
        @Override protected void onDraw(Canvas canvas) {
            boolean sdkCapture = false;
            if (timeout) for (StackTraceElement frame : Thread.currentThread().getStackTrace())
                if (frame.getClassName().equals("com.androiduiinspector.sdk.CaptureFrame")) { sdkCapture = true; break; }
            if (sdkCapture && delayed.compareAndSet(false, true)) {
                report("capture-entered", null);
                try { Thread.sleep(4200); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                finally { report("capture-released", null); }
            }
            super.onDraw(canvas);
        }
    }

    private synchronized void report(String phase, Throwable error) {
        try {
            JSONObject result = new JSONObject().put("probeToken", token).put("phase", phase);
            if (error != null) result.put("error", error.toString());
            File pending = new File(getFilesDir(), "pipeline-contract.json.tmp");
            try (FileOutputStream output = new FileOutputStream(pending)) {
                output.write(result.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (!pending.renameTo(new File(getFilesDir(), "pipeline-contract.json"))) throw new IllegalStateException("Fixture report publication failed");
        } catch (Exception errorWriting) { android.util.Log.e("PipelineContract", "Fixture report failed", errorWriting); }
    }
}

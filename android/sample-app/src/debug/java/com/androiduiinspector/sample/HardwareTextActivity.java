package com.androiduiinspector.sample;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

/** Stable Debug-only admission fixture; a software layer is not a software window. */
public class HardwareTextActivity extends Activity {
    private FrameLayout page;
    private boolean probeStarted;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        page = new FrameLayout(this);
        page.setBackgroundColor(Color.WHITE);
        TextView target = text("Admission Text");
        page.addView(target, new FrameLayout.LayoutParams(dp(210), dp(80), Gravity.CENTER));
        TextView softwareLayer = text("Software layer");
        softwareLayer.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        page.addView(softwareLayer, new FrameLayout.LayoutParams(dp(210), dp(80), Gravity.TOP));
        setContentView(page);
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused && !probeStarted && getIntent().hasExtra("leafProbeToken")) {
            probeStarted = true;
            String token = getIntent().getStringExtra("leafProbeToken");
            if (getIntent().getBooleanExtra("leafReuse", false))
                new Thread(() -> TextReuseProbe.run(this, page, token), "sample-text-reuse").start();
            else page.post(() -> TextLeafProbe.run(this, page, token));
        }
    }
    private TextView text(String label) {
        TextView view = new TextView(this);
        view.setText(label); view.setTextColor(0xff222222); view.setTextSize(22);
        view.setGravity(Gravity.CENTER);
        return view;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}

package com.androiduiinspector.sdkfree;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

/** SDK-free counterpart of the stable text fixture; no inspector initialization. */
public class HardwareTextActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout page = new FrameLayout(this);
        page.setBackgroundColor(Color.WHITE);
        page.addView(text("Admission Text"), new FrameLayout.LayoutParams(dp(210), dp(80), Gravity.CENTER));
        TextView softwareLayer = text("Software layer");
        softwareLayer.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        page.addView(softwareLayer, new FrameLayout.LayoutParams(dp(210), dp(80), Gravity.TOP));
        setContentView(page);
    }
    private TextView text(String label) {
        TextView view = new TextView(this);
        view.setText(label); view.setTextColor(0xff222222); view.setTextSize(22);
        view.setGravity(Gravity.CENTER);
        return view;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}

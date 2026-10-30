package com.androiduiinspector.sdkfree;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Debug-only, SDK-free fixture for repeated absent-to-visible condition waits. */
public class DelayedConditionActivity extends Activity {
    public static final String ACTION_RUN_DELAY = "com.androiduiinspector.sdkfree.RUN_DELAY";
    public static final String EXTRA_DELAY_MS = "delay_ms";
    private static final String TAG = "InspectorWaitFixture";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView ready;
    private TextView count;
    private TextView description;
    private int runCount;
    private int delayMs;
    private long startedAtMs;
    private final Runnable showReady = () -> {
        ready.setVisibility(View.VISIBLE);
        long now = SystemClock.elapsedRealtime();
        Log.i(TAG, "ready elapsedRealtimeMs=" + now + " durationMs=" + (now - startedAtMs));
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        delayMs = Math.max(2000, Math.min(20000, getIntent().getIntExtra(EXTRA_DELAY_MS, 8000)));
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setGravity(Gravity.CENTER);
        page.setPadding(dp(24), dp(24), dp(24), dp(24));
        page.setBackgroundColor(0xffffffff);

        description = new TextView(this);
        description.setText("点击开始，" + delayMs / 1000.0 + " 秒后显示就绪标记");
        description.setTextColor(0xff333333);
        description.setTextSize(18);
        description.setGravity(Gravity.CENTER);
        page.addView(description);

        Button start = new Button(this);
        start.setId(R.id.delayed_condition_start);
        start.setText("开始等待");
        start.setOnClickListener(view -> startWait());
        page.addView(start);

        count = new TextView(this);
        count.setId(R.id.delayed_condition_run_count);
        count.setText("0");
        count.setTextColor(0xff333333);
        count.setTextSize(18);
        count.setGravity(Gravity.CENTER);
        page.addView(count);

        ready = new TextView(this);
        ready.setId(R.id.delayed_condition_ready);
        ready.setText("准备就绪");
        ready.setTextColor(0xff176b32);
        ready.setTextSize(24);
        ready.setGravity(Gravity.CENTER);
        ready.setVisibility(View.GONE);
        page.addView(ready);
        setContentView(page);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent == null || !ACTION_RUN_DELAY.equals(intent.getAction())) return;
        delayMs = Math.max(2000, Math.min(20000, intent.getIntExtra(EXTRA_DELAY_MS, 8000)));
        description.setText("点击开始，" + delayMs / 1000.0 + " 秒后显示就绪标记");
        startWait();
    }

    private void startWait() {
        handler.removeCallbacks(showReady);
        count.setText(Integer.toString(++runCount));
        ready.setVisibility(View.GONE);
        startedAtMs = SystemClock.elapsedRealtime();
        Log.i(TAG, "start elapsedRealtimeMs=" + startedAtMs + " delayMs=" + delayMs);
        handler.postDelayed(showReady, delayMs);
    }

    @Override protected void onDestroy() {
        handler.removeCallbacks(showReady);
        super.onDestroy();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}

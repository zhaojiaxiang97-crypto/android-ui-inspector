package com.androiduiinspector.sdkfree;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** Debug-only input evidence. Touch delivery, business clicks and actual scrolling have independent counters. */
public class InputDiagnosticsActivity extends Activity {
    private static final String TAG = "InspectorInputFixture";
    private static final String ENTRY_COUNT = "entry_count";
    private static final int LOG_LIMIT = 128;
    private final String instance = UUID.randomUUID().toString();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ArrayDeque<String> events = new ArrayDeque<>();
    private final Map<Integer, TextView> metrics = new HashMap<>();
    private TextView ready, scrollChanged, lastTouchView;
    private int clickCount, coordinateClickCount, navigationCount, downCount, upCount, cancelCount, scrollY, scrollChanges;
    private long sequence;
    private boolean gestureActive;
    private String lastTouch = "尚无触摸事件";
    private final Runnable publish = this::publishMetrics;
    private final Runnable showReady = () -> {
        ready.setVisibility(View.VISIBLE);
        record("ready clickCount=" + clickCount);
        publishMetrics();
    };

    protected boolean isChildPage() { return false; }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(12), dp(8), dp(12), dp(8));
        page.setBackgroundColor(0xffffffff);
        TextView title = text(isChildPage() ? "输入诊断 · 子页面" : "输入诊断 · 主页面", 18);
        title.setId(isChildPage() ? R.id.input_diagnostics_child_page : R.id.input_diagnostics_main_page);
        page.addView(title, new LinearLayout.LayoutParams(-1, dp(32)));
        if (isChildPage()) addChildControls(page); else addMainControls(page);

        addMetricRow(page, new String[]{"就绪点击", "坐标点击", "导航点击"}, new int[]{
                R.id.input_diagnostics_click_count, R.id.input_diagnostics_coordinate_click_count, R.id.input_diagnostics_navigation_count});
        addMetricRow(page, new String[]{"DOWN", "UP", "CANCEL"}, new int[]{
                R.id.input_diagnostics_touch_down_count, R.id.input_diagnostics_touch_up_count, R.id.input_diagnostics_touch_cancel_count});
        addMetricRow(page, new String[]{"scrollY px", "滚动变化", "日志 / 128"}, new int[]{
                R.id.input_diagnostics_scroll_y, R.id.input_diagnostics_scroll_change_count, R.id.input_diagnostics_log_count});
        lastTouchView = text(lastTouch, 11); lastTouchView.setSingleLine(true);
        lastTouchView.setId(R.id.input_diagnostics_last_touch);
        page.addView(lastTouchView, new LinearLayout.LayoutParams(-1, dp(22)));
        scrollChanged = text("已发生滚动", 13); scrollChanged.setTextColor(0xff176b32);
        scrollChanged.setId(R.id.input_diagnostics_scroll_changed); scrollChanged.setVisibility(View.GONE);
        addReservedSlot(page, scrollChanged, 22);
        if (!isChildPage()) addList(page);
        setContentView(page);
        record("created");
        publishMetrics();
    }

    private void addMainControls(LinearLayout page) {
        Button start = button("开始等待（1 秒）", R.id.input_diagnostics_start);
        start.setOnClickListener(view -> {
            handler.removeCallbacks(showReady);
            clickCount++;
            ready.setVisibility(View.GONE);
            record("start-click count=" + clickCount + " delayMs=1000");
            publishMetrics();
            handler.postDelayed(showReady, 1000);
        });
        page.addView(start, new LinearLayout.LayoutParams(-1, dp(48)));
        ready = text("准备就绪", 14); ready.setTextColor(0xff176b32);
        ready.setId(R.id.input_diagnostics_ready); ready.setVisibility(View.GONE);
        addReservedSlot(page, ready, 24);

        Button open = button("进入子页", R.id.input_diagnostics_open_child);
        open.setOnClickListener(view -> {
            navigationCount++;
            record("open-child count=" + navigationCount);
            publishMetrics();
            startActivity(new Intent(this, InputDiagnosticsChildActivity.class).putExtra(ENTRY_COUNT, navigationCount));
        });
        page.addView(open, new LinearLayout.LayoutParams(-1, dp(48)));
        Button coordinate = button("无 ID 坐标按钮", View.NO_ID);
        coordinate.setOnClickListener(view -> {
            coordinateClickCount++;
            record("coordinate-click count=" + coordinateClickCount);
            publishMetrics();
        });
        page.addView(coordinate, new LinearLayout.LayoutParams(-1, dp(48)));
    }

    private void addChildControls(LinearLayout page) {
        TextView entry = text(Integer.toString(getIntent().getIntExtra(ENTRY_COUNT, 0)), 18);
        entry.setId(R.id.input_diagnostics_child_entry_count);
        page.addView(entry, new LinearLayout.LayoutParams(-1, dp(32)));
        Button back = button("返回主页面", R.id.input_diagnostics_back);
        back.setOnClickListener(view -> {
            navigationCount++;
            record("back-click count=" + navigationCount);
            finish();
        });
        page.addView(back, new LinearLayout.LayoutParams(-1, dp(48)));
    }

    private final class DiagnosticScrollView extends ScrollView {
        DiagnosticScrollView() { super(InputDiagnosticsActivity.this); }

        @Override public boolean performAccessibilityAction(int action, Bundle arguments) {
            if (action != AccessibilityNodeInfo.ACTION_SCROLL_FORWARD && action != AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
                return super.performAccessibilityAction(action, arguments);
            int before = getScrollY();
            String accepted = "unknown";
            try {
                boolean result = super.performAccessibilityAction(action, arguments);
                accepted = Boolean.toString(result);
                return result;
            } finally {
                record("accessibility-scroll action=" + (action == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD ? "forward" : "backward")
                        + " accepted=" + accepted + " scrollYBefore=" + before + " scrollYAfter=" + getScrollY());
                schedulePublish();
            }
        }
    }

    private void addList(LinearLayout page) {
        ScrollView scroll = new DiagnosticScrollView();
        scroll.setId(R.id.input_diagnostics_scroll);
        LinearLayout rows = new LinearLayout(this); rows.setOrientation(LinearLayout.VERTICAL);
        rows.setPadding(0, 0, 0, dp(8));
        for (int number = 1; number <= 24; number++) {
            TextView row = text(number == 24 ? "末项 · 第24项" : "固定列表 · 第" + number + "项", 16);
            if (number == 1) row.setId(R.id.input_diagnostics_list_first);
            if (number == 24) row.setId(R.id.input_diagnostics_list_end);
            row.setBackgroundColor(number % 2 == 0 ? 0xffeef2f6 : 0xfff8fafc);
            rows.addView(row, new LinearLayout.LayoutParams(-1, dp(56)));
        }
        scroll.addView(rows);
        scroll.setOnScrollChangeListener((view, x, y, oldX, oldY) -> {
            if (y == scrollY) return;
            scrollY = y; scrollChanges++;
            record("scroll y=" + scrollY + " changes=" + scrollChanges);
            schedulePublish();
        });
        page.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        String name = action == MotionEvent.ACTION_DOWN ? "DOWN" : action == MotionEvent.ACTION_UP ? "UP"
                : action == MotionEvent.ACTION_CANCEL ? "CANCEL" : null;
        String sample = null;
        if (name != null) {
            if (action == MotionEvent.ACTION_DOWN) { downCount++; gestureActive = true; handler.removeCallbacks(publish); }
            else if (action == MotionEvent.ACTION_UP) upCount++;
            else cancelCount++;
            sample = name + " x=" + event.getX() + " y=" + event.getY() + " rawX=" + event.getRawX()
                    + " rawY=" + event.getRawY() + " eventTimeMs=" + event.getEventTime()
                    + " source=" + event.getSource() + " toolType0=" + event.getToolType(0) + " flags=" + event.getFlags()
                    + " displayId=" + getWindowManager().getDefaultDisplay().getDisplayId() + " displayIdSource=activity";
            lastTouch = sample;
            record("touch " + sample);
        }
        try {
            boolean handled = super.dispatchTouchEvent(event);
            if (sample != null) record("dispatch-result action=" + name + " handled=" + handled);
            return handled;
        } finally {
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                gestureActive = false;
                schedulePublish();
            }
        }
    }

    private void schedulePublish() {
        handler.removeCallbacks(publish);
        handler.postDelayed(publish, 200);
    }

    private void publishMetrics() {
        if (gestureActive) { schedulePublish(); return; }
        value(R.id.input_diagnostics_click_count, clickCount);
        value(R.id.input_diagnostics_coordinate_click_count, coordinateClickCount);
        value(R.id.input_diagnostics_navigation_count, navigationCount);
        value(R.id.input_diagnostics_touch_down_count, downCount);
        value(R.id.input_diagnostics_touch_up_count, upCount);
        value(R.id.input_diagnostics_touch_cancel_count, cancelCount);
        value(R.id.input_diagnostics_scroll_y, scrollY);
        value(R.id.input_diagnostics_scroll_change_count, scrollChanges);
        value(R.id.input_diagnostics_log_count, events.size());
        lastTouchView.setText(lastTouch);
        scrollChanged.setVisibility(scrollY > 0 ? View.VISIBLE : View.GONE);
    }

    private void record(String event) {
        String line = "seq=" + (++sequence) + " instance=" + instance + " page=" + (isChildPage() ? "child" : "main")
                + " elapsedRealtimeMs=" + SystemClock.elapsedRealtime() + " " + event;
        if (events.size() == LOG_LIMIT) events.removeFirst();
        events.addLast(line);
        Log.i(TAG, line);
    }

    @Override protected void onResume() {
        super.onResume();
        record("resume");
        publishMetrics();
    }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        record("destroy");
        super.onDestroy();
    }

    private void addMetricRow(LinearLayout page, String[] labels, int[] ids) {
        LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.HORIZONTAL);
        for (int i = 0; i < ids.length; i++) {
            LinearLayout cell = new LinearLayout(this); cell.setOrientation(LinearLayout.VERTICAL);
            TextView label = text(labels[i], 11); label.setSingleLine(true); cell.addView(label);
            TextView number = text("0", 15); number.setSingleLine(true); number.setId(ids[i]); cell.addView(number);
            metrics.put(ids[i], number);
            row.addView(cell, new LinearLayout.LayoutParams(0, -1, 1));
        }
        page.addView(row, new LinearLayout.LayoutParams(-1, dp(44)));
    }

    private void value(int id, int number) { metrics.get(id).setText(Integer.toString(number)); }
    private Button button(String label, int id) {
        Button button = new Button(this); button.setText(label); button.setAllCaps(false);
        if (id != View.NO_ID) button.setId(id);
        return button;
    }
    private TextView text(String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(0xff263238);
        view.setGravity(Gravity.CENTER_VERTICAL); return view;
    }
    private void addReservedSlot(LinearLayout page, View marker, int heightDp) {
        FrameLayout slot = new FrameLayout(this); slot.addView(marker, new FrameLayout.LayoutParams(-1, -1));
        page.addView(slot, new LinearLayout.LayoutParams(-1, dp(heightDp)));
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}

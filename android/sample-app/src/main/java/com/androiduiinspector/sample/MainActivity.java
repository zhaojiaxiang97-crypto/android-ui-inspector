package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private FrameLayout testParent;
    private TextView testText;
    private View testOpaqueChild;
    private FrameLayout visualStage;
    private boolean captured;
    private boolean changed;
    private boolean listAdded;
    private int branchStep;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout page = new FrameLayout(this);
        page.setBackgroundColor(Color.WHITE);
        testParent = new DecoratedParent(this);
        ProbeRunner.label(testParent, "蓝色示例卡片");
        testParent.setBackgroundColor(Color.rgb(12, 52, 104));
        testParent.setClipChildren(true);
        FrameLayout.LayoutParams box = new FrameLayout.LayoutParams(dp(260), dp(180));
        box.gravity = Gravity.CENTER;
        page.addView(testParent, box);

        testText = new TextView(this);
        testText.setText("RED CHILD");
        testText.setTextColor(Color.RED);
        testText.setTextSize(22);
        testText.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams label = new FrameLayout.LayoutParams(dp(210), dp(80));
        label.gravity = Gravity.CENTER;
        testParent.addView(testText, label);
        testOpaqueChild = new View(this);
        ProbeRunner.label(testOpaqueChild, "绿色装饰块");
        testOpaqueChild.setOnLongClickListener(view -> true);
        testOpaqueChild.setBackgroundColor(Color.rgb(0, 220, 60));
        FrameLayout.LayoutParams opaqueBox = new FrameLayout.LayoutParams(dp(100), dp(40), Gravity.BOTTOM | Gravity.RIGHT);
        opaqueBox.rightMargin = -dp(20);
        opaqueBox.bottomMargin = -dp(10);
        testParent.addView(testOpaqueChild, opaqueBox);
        String mode = getIntent().getStringExtra("mode");
        if ("stress".equals(mode) || "stress-large".equals(mode)) {
            int side = "stress-large".equals(mode) ? 20 : 10;
            int cellSize = 300 / side;
            LinearLayout grid = new LinearLayout(this);
            grid.setOrientation(LinearLayout.VERTICAL);
            for (int row = 0; row < side; row++) {
                LinearLayout line = new LinearLayout(this);
                for (int column = 0; column < side; column++) {
                    TextView cell = new TextView(this);
                    cell.setText(String.valueOf(row * side + column));
                    cell.setTextSize(10);
                    cell.setGravity(Gravity.CENTER);
                    line.addView(cell, new LinearLayout.LayoutParams(dp(cellSize), dp(cellSize), row == 0 && column == 0 ? 1f : 0f));
                }
                grid.addView(line);
            }
            page.addView(grid, new FrameLayout.LayoutParams(dp(300), dp(300), Gravity.TOP));
        } else if ("dynamic".equals(mode)) {
            testText.setOnClickListener(view -> {
                if (changed) return;
                changed = true;
                testText.setText("UPDATED CHILD");
                TextView added = new TextView(this);
                added.setText("NEW VIEW");
                FrameLayout.LayoutParams addedBox = new FrameLayout.LayoutParams(dp(120), dp(30), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
                testParent.addView(added, addedBox);
            });
        } else if ("branch".equals(mode)) {
            testText.setOnClickListener(view -> {
                if (branchStep++ == 0) {
                    TextView added = new TextView(this);
                    added.setText("NEW VIEW");
                    testParent.addView(added, new FrameLayout.LayoutParams(dp(120), dp(30), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL));
                } else if (branchStep == 2) {
                    testParent.removeView(testOpaqueChild);
                } else if (branchStep == 3) {
                    testParent.removeView(testText);
                    testParent.addView(testText);
                }
            });
        } else if ("list".equals(mode)) {
            // 列表级结构变化场景：24 个条目（每个条目含 4 个控件、共约 96 个可见控件 → 触发多批 ≤64 装箱）、
            // 条目大部分在视口外；点击「条目 0」在顶部插入 2 个新条目——供 scope="list" 可见项分批刷新端到端验证。
            testParent.setVisibility(View.GONE);
            ScrollView scroll = new ScrollView(this);
            LinearLayout list = new LinearLayout(this);
            list.setOrientation(LinearLayout.VERTICAL);
            ProbeRunner.label(list, "样例列表容器");
            for (int i = 0; i < 24; i++) {
                LinearLayout item = new LinearLayout(this);
                item.setOrientation(LinearLayout.VERTICAL);
                item.setBackgroundColor(i % 2 == 0 ? Color.rgb(235, 240, 250) : Color.rgb(250, 245, 235));
                item.addView(cell("条目 " + i, 16), new LinearLayout.LayoutParams(-1, dp(56)));
                item.addView(cell("说明 " + i, 12), new LinearLayout.LayoutParams(-1, dp(40)));
                item.addView(cell("#" + i, 10), new LinearLayout.LayoutParams(-1, dp(24)));
                list.addView(item, new LinearLayout.LayoutParams(-1, dp(120)));
                if (i == 5) item.setVisibility(View.INVISIBLE); // 进树但 visible=false：验证「非视口条目 → out-of-viewport 标注 + 保留旧图」分支
                if (i == 0) {
                    item.setOnClickListener(view -> {
                        if (listAdded) return; // 幂等：探针重复点击（事件被吞时重试）不重复插入
                        listAdded = true;
                        for (String name : new String[]{"新增条目 A", "新增条目 B"}) {
                            LinearLayout added = new LinearLayout(this);
                            added.setOrientation(LinearLayout.VERTICAL);
                            added.setBackgroundColor(Color.rgb(220, 255, 220));
                            added.addView(cell(name, 16), new LinearLayout.LayoutParams(-1, dp(56)));
                            added.addView(cell(name + " · 说明", 12), new LinearLayout.LayoutParams(-1, dp(40)));
                            added.addView(cell("#新", 10), new LinearLayout.LayoutParams(-1, dp(24)));
                            list.addView(added, 0, new LinearLayout.LayoutParams(-1, dp(120)));
                        }
                    });
                }
            }
            scroll.addView(list);
            page.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        } else if ("resize".equals(mode)) {
            testText.setOnClickListener(view -> {
                if (changed) return;
                changed = true;
                FrameLayout.LayoutParams parentBox = (FrameLayout.LayoutParams) testParent.getLayoutParams();
                parentBox.width = dp(290);
                parentBox.height = dp(210);
                testParent.setLayoutParams(parentBox);
                FrameLayout.LayoutParams textBox = (FrameLayout.LayoutParams) testText.getLayoutParams();
                textBox.width = dp(230);
                textBox.height = dp(90);
                testText.setLayoutParams(textBox);
                testText.setText("RESIZED CHILD");
            });
        } else if ("surface".equals(mode)) {
            SurfaceView surface = new SurfaceView(this);
            testParent.addView(surface, new FrameLayout.LayoutParams(dp(180), dp(90), Gravity.TOP | Gravity.CENTER_HORIZONTAL));
            surface.getHolder().addCallback(new SurfaceHolder.Callback() {
                @Override public void surfaceCreated(SurfaceHolder holder) {
                    Canvas canvas = holder.lockCanvas();
                    if (canvas == null) return;
                    try { canvas.drawColor(Color.rgb(0, 180, 40)); }
                    finally { holder.unlockCanvasAndPost(canvas); }
                }
                @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}
                @Override public void surfaceDestroyed(SurfaceHolder holder) {}
            });
        } else if ("partial-failure".equals(mode)) {
            View oversized = new View(this);
            ProbeRunner.label(oversized, "超出单图预算的测试层");
            oversized.setBackgroundColor(Color.TRANSPARENT);
            testParent.addView(oversized, 0, new FrameLayout.LayoutParams(dp(750), dp(750)));
        } else if ("visual".equals(mode)) {
            visualStage = new FrameLayout(this);
            GradientDrawable rounded = new GradientDrawable();
            rounded.setColor(Color.BLUE);
            rounded.setCornerRadius(dp(20));
            visualStage.setBackground(rounded);
            visualStage.setClipToOutline(true);
            visualStage.setAlpha(0.5f);
            FrameLayout.LayoutParams stageBox = new FrameLayout.LayoutParams(dp(100), dp(100));
            stageBox.leftMargin = dp(30);
            stageBox.topMargin = dp(50);
            page.addView(visualStage, stageBox);
            View red = new View(this);
            red.setBackgroundColor(Color.RED);
            visualStage.addView(red, new FrameLayout.LayoutParams(-1, -1));
            View green = new View(this);
            green.setBackgroundColor(Color.GREEN);
            green.setAlpha(0.5f);
            FrameLayout.LayoutParams greenBox = new FrameLayout.LayoutParams(dp(60), -1, Gravity.RIGHT);
            visualStage.addView(green, greenBox);
        }
        setContentView(page);
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        String mode = getIntent().getStringExtra("mode");
        if (hasFocus && !captured && (mode == null || "visual".equals(mode))) {
            captured = true;
            if ("visual".equals(mode)) visualStage.post(() -> ProbeRunner.runVisual(this, visualStage));
            else testParent.post(() -> ProbeRunner.run(this, testParent, testText, testOpaqueChild));
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private TextView cell(String text, int sizeSp) {
        TextView cell = new TextView(this);
        cell.setText(text);
        cell.setTextSize(sizeSp);
        cell.setGravity(Gravity.CENTER);
        return cell;
    }

    private static final class DecoratedParent extends FrameLayout {
        private final Paint marker = new Paint();

        DecoratedParent(Activity activity) {
            super(activity);
            marker.setColor(Color.YELLOW);
        }

        @Override protected void dispatchDraw(Canvas canvas) {
            super.dispatchDraw(canvas);
            canvas.drawRect(2, 2, 22, 22, marker);
        }
    }
}

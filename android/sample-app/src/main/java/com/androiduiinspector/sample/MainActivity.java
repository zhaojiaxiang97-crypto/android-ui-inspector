package com.androiduiinspector.sample;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.Bundle;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private FrameLayout testParent;
    private TextView testText;
    private View testOpaqueChild;
    private boolean captured;
    private boolean changed;

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
        }
        setContentView(page);
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && !captured && getIntent().getStringExtra("mode") == null) {
            captured = true;
            testParent.post(() -> ProbeRunner.run(this, testParent, testText, testOpaqueChild));
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
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

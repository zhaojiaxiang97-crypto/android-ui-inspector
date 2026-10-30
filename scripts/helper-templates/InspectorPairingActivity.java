package com.artemis.helper;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Explicit, on-device pairing; no token is accepted through the launch Intent. */
public final class InspectorPairingActivity extends Activity {
    private TextView status;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);

        int margin = Math.round(getResources().getDisplayMetrics().density * 20);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(margin, margin, margin, margin);
        ScrollView scrolling = new ScrollView(this);
        scrolling.addView(content);
        setContentView(scrolling);

        TextView title = new TextView(this);
        title.setText("Inspector 手动配对");
        title.setTextSize(22);
        content.addView(title);

        TextView instructions = new TextView(this);
        instructions.setText("在此输入电脑端的配对令牌（16–256 位字母、数字、- 或 _）。令牌仅保存于本次 Helper 进程内存中，服务重启后需重新配对。");
        content.addView(instructions);

        status = new TextView(this);
        content.addView(status);

        EditText tokenInput = new EditText(this);
        tokenInput.setHint("配对令牌");
        tokenInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        tokenInput.setSingleLine(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            tokenInput.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        }
        content.addView(tokenInput);

        Button pair = new Button(this);
        pair.setText("确认配对");
        pair.setOnClickListener(v -> {
            if (!InspectorPairingToken.setFromUser(tokenInput.getText().toString().trim())) {
                tokenInput.setError("令牌格式不正确，请检查长度和字符。");
                return;
            }
            tokenInput.setText("");
            showStatus();
        });
        content.addView(pair);

        Button clear = new Button(this);
        clear.setText("清除配对");
        clear.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setMessage("清除后电脑将无法继续通过当前令牌连接，确定清除吗？")
                .setNegativeButton("取消", null)
                .setPositiveButton("清除", (dialog, which) -> {
                    InspectorPairingToken.clearFromUser();
                    tokenInput.setText("");
                    showStatus();
                })
                .show());
        content.addView(clear);
        showStatus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (status != null) showStatus();
    }

    private void showStatus() {
        if (!TokenStore.isSet()) {
            status.setText("状态：尚未配对");
        } else if (ArtemisAccessibilityService.getInstance() == null) {
            status.setText("状态：令牌已设置，请在系统设置中启用 Helper 无障碍服务");
        } else {
            status.setText("状态：已设置令牌，可在电脑端测试连接");
        }
    }
}

package com.androiduiinspector.recognition;

import android.app.Activity;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.EditText;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        EditText input = findViewById(R.id.account_input);
        input.setShowSoftInputOnFocus(false);
        input.setError("Account is required");
        findViewById(R.id.capture_state).setStateDescription("Paused");
        View page = findViewById(R.id.page);
        page.requestFocus();
        page.post(this::writeFixtureEvidence);
    }

    private JSONObject describe(int id) throws Exception {
        View view = findViewById(id);
        AccessibilityNodeInfo node = view.createAccessibilityNodeInfo();
        try {
            Rect bounds = new Rect();
            boolean visible = view.getGlobalVisibleRect(bounds);
            return new JSONObject().put("resourceId", getResources().getResourceName(id))
                .put("hint", text(node.getHintText())).put("error", text(node.getError()))
                .put("state-description", text(node.getStateDescription()))
                .put("visible", visible).put("bounds", bounds.flattenToString());
        } finally { node.recycle(); }
    }

    private static String text(CharSequence value) { return value == null ? "" : value.toString(); }

    private void writeFixtureEvidence() {
        try {
            JSONObject input = describe(R.id.account_input);
            JSONObject state = describe(R.id.capture_state);
            boolean passed = "Account name".equals(input.getString("hint"))
                && "Account is required".equals(input.getString("error"))
                && "Paused".equals(state.getString("state-description"))
                && input.getBoolean("visible") && state.getBoolean("visible");
            JSONObject report = new JSONObject().put("passed", passed).put("input", input).put("state", state)
                .put("scope", "Sample framework properties; remote Helper capture is verified separately");
            try (FileOutputStream output = new FileOutputStream(new File(getFilesDir(), "recognition-fixture.json"))) {
                output.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception error) { throw new IllegalStateException("Recognition fixture evidence failed", error); }
    }
}

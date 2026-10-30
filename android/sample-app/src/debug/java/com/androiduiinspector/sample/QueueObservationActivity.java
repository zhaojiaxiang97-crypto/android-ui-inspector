package com.androiduiinspector.sample;

import android.app.Activity;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.TextView;
import com.androiduiinspector.sdk.DebugNames;

/** Static foreground used by the explicit host queue observer; no automatic capture/probe. */
public final class QueueObservationActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView text = new TextView(this);
        text.setText("Queue observation sample"); text.setTextSize(20);
        text.setGravity(Gravity.CENTER); text.setBackgroundColor(0xffedf3ff); text.setTextColor(0xff162039);
        DebugNames.set(text, "排队观察样例文字");
        setContentView(text);
    }
}

package com.androiduiinspector.sample;

import android.app.Activity;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

/** Debug fixture only. Changes one branch after a real tree read; never alters SDK responses. */
final class BranchRecoveryText extends TextView {
    private final FrameLayout parent;
    private final String mode;
    private boolean moved, blocked, reread, movedAgain;

    BranchRecoveryText(Activity activity, FrameLayout parent, String mode) {
        super(activity);
        this.parent = parent;
        this.mode = mode;
    }

    @Override public void getLocationOnScreen(int[] location) {
        super.getLocationOnScreen(location);
        boolean tree = false, branch = false, capture = false;
        for (StackTraceElement frame : Thread.currentThread().getStackTrace()) {
            tree |= frame.getClassName().equals("com.androiduiinspector.sdk.HierarchyTree")
                    && frame.getMethodName().equals("captureTree");
            branch |= frame.getClassName().equals("com.androiduiinspector.sdk.BranchGeometry$Row");
            capture |= frame.getClassName().equals("com.androiduiinspector.sdk.CaptureFrame")
                    && frame.getMethodName().equals("captureFrameOnUiThread");
        }
        if (tree && !moved) {
            moved = true;
            post(() -> {
                parent.offsetLeftAndRight(12);
                parent.offsetTopAndBottom(12);
                parent.invalidate();
                if (mode.endsWith("root-change")) {
                    // Real DecorView structure change, outside the selected branch.
                    View marker = new View(getContext());
                    marker.setAlpha(0f);
                    ((ViewGroup) getRootView()).addView(marker, new ViewGroup.LayoutParams(1, 1));
                }
            });
        }
        if (branch) reread = true;
        if (capture && reread && mode.endsWith("moving-again") && !movedAgain) {
            movedAgain = true;
            // Runs after the UI capture task, before its reply/verification. Pixel data isn't forged.
            post(() -> { offsetLeftAndRight(3); invalidate(); });
        }
        if (branch && mode.endsWith("timeout") && !blocked) {
            blocked = true;
            // Bounded, once-only sample stall exceeds the provider's three-second wait.
            SystemClock.sleep(3500);
        }
    }
}

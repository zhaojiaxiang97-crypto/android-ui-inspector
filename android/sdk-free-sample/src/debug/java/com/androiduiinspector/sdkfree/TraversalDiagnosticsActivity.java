package com.androiduiinspector.sdkfree;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.Debug;
import android.os.SystemClock;
import android.os.Trace;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeProvider;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.Arrays;

/** Static debug-only traversal fixture. No SDK, gestures, timers or business actions. */
public final class TraversalDiagnosticsActivity extends Activity {
    public static final String ACTION_DUMP_COUNTS = "com.androiduiinspector.sdkfree.DUMP_TRAVERSAL_COUNTS";
    public static final String ACTION_RESET_PROVIDER_AUDIT = "com.androiduiinspector.sdkfree.RESET_TRAVERSAL_PROVIDER_AUDIT";
    private static final String TAG = "InspectorTraversalFixture";
    private TraversalFixtureTree tree;
    private int epoch;
    private long providerCreates, hostCreates, invalidCreates;
    private boolean profileProvider, traceProvider;
    private long providerWallNs, providerCpuNs;
    private int[] auditVirtualIdCounts;
    private int uniqueVirtualIds, duplicateVirtualCreates, duplicatedVirtualIds, maxCreatesPerId;

    @Override public void onCreate(Bundle state) { super.onCreate(state); configure(getIntent()); }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && ACTION_DUMP_COUNTS.equals(intent.getAction())) { dumpCounts("requested"); return; }
        if (intent != null && ACTION_RESET_PROVIDER_AUDIT.equals(intent.getAction())) {
            resetAuditCounts(); dumpCounts("reset"); return;
        }
        dumpCounts("replace"); setIntent(intent); configure(intent);
    }
    private void configure(Intent intent) {
        String shape = intent == null ? null : intent.getStringExtra("shape");
        tree = TraversalFixtureTree.create(shape == null ? "deep300" : shape);
        epoch = intent == null ? 0 : intent.getIntExtra("epoch", 0);
        if (epoch < 0 || epoch > 1_000_000) throw new IllegalArgumentException("epoch must be 0..1000000");
        providerCreates = hostCreates = invalidCreates = 0;
        profileProvider = intent != null && intent.getBooleanExtra("profileProvider", false);
        traceProvider = intent != null && intent.getBooleanExtra("traceProvider", false);
        providerWallNs = providerCpuNs = 0;
        auditVirtualIdCounts = intent != null && intent.getBooleanExtra("auditProviderIds", false)
                ? new int[tree.nodes.size() + 1] : null;
        uniqueVirtualIds = duplicateVirtualCreates = duplicatedVirtualIds = maxCreatesPerId = 0;
        LinearLayout page = new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(0xffffffff); page.setId(R.id.traversal_diagnostics_page);
        page.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        TextView shapeLabel = label("shape=" + tree.shape + " nodes=" + tree.nodes.size() + " depth=" + tree.maxDepth() + " maxChildren=" + tree.maxChildren());
        shapeLabel.setId(R.id.traversal_diagnostics_shape);
        // Enable a single harmless target only for read-only full-tree input preflight diagnostics.
        if (intent != null && intent.getBooleanExtra("probeTarget", false)) shapeLabel.setClickable(true);
        TextView epochLabel = label(Integer.toString(epoch)); epochLabel.setId(R.id.traversal_diagnostics_epoch);
        page.addView(shapeLabel, new LinearLayout.LayoutParams(-1, dp(32)));
        page.addView(epochLabel, new LinearLayout.LayoutParams(-1, dp(24)));
        View root = tree.virtual ? new VirtualHost() : realNode(tree.root());
        page.addView(root, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(page);
        dumpCounts("configured");
    }
    private TextView label(String value) {
        TextView text = new TextView(this); text.setText(value); text.setTextSize(11); text.setTextColor(0xff263340);
        text.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES); return text;
    }
    private String nodeText(TraversalFixtureTree.Node node) { return "node-" + node.id + " epoch-" + epoch; }
    private int resourceId(int id) {
        int result = getResources().getIdentifier(TraversalFixtureTree.name(id), "id", getPackageName());
        if (result == 0) throw new IllegalStateException("fixed debug node resource missing"); return result;
    }
    private void identity(View view, TraversalFixtureTree.Node node) {
        view.setId(resourceId(node.id)); view.setContentDescription(nodeText(node));
        view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        view.setFocusable(false); view.setClickable(false);
    }
    private View realNode(TraversalFixtureTree.Node node) {
        if (node.children.isEmpty()) { TextView leaf = label(nodeText(node)); identity(leaf, node); return leaf; }
        NodeGroup group = new NodeGroup(); identity(group, node);
        for (TraversalFixtureTree.Node child : node.children) group.addView(realNode(child), new ViewGroup.LayoutParams(-1, -1)); return group;
    }
    private Rect childRect(int width, int height, int index, boolean group) {
        if (group) return new Rect(1, 1, Math.max(2, width - 1), Math.max(2, height - 1));
        int cell = Math.max(1, width / 4), row = Math.max(1, Math.min(dp(20), height / 24));
        int left = index % 4 * cell, top = index / 4 * row;
        return new Rect(left, top, Math.min(width, left + cell), Math.min(height, top + row));
    }
    private final class NodeGroup extends ViewGroup {
        NodeGroup() { super(TraversalDiagnosticsActivity.this); setClipChildren(true); }
        @Override protected void onMeasure(int widthSpec, int heightSpec) {
            int width = MeasureSpec.getSize(widthSpec), height = MeasureSpec.getSize(heightSpec);
            setMeasuredDimension(width, height);
            for (int i = 0; i < getChildCount(); i++) {
                View child = getChildAt(i); Rect rect = childRect(width, height, i, child instanceof NodeGroup);
                child.measure(MeasureSpec.makeMeasureSpec(rect.width(), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(rect.height(), MeasureSpec.EXACTLY));
            }
        }
        @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
            for (int i = 0; i < getChildCount(); i++) {
                View child = getChildAt(i); Rect rect = childRect(right - left, bottom - top, i, child instanceof NodeGroup);
                child.layout(rect.left, rect.top, rect.right, rect.bottom);
            }
        }
    }
    private final class VirtualHost extends View {
        private final Rect[] bounds = new Rect[tree.nodes.size()];
        private final Provider provider = new Provider();
        VirtualHost() { super(TraversalDiagnosticsActivity.this); identity(this, tree.root()); }
        @Override public AccessibilityNodeProvider getAccessibilityNodeProvider() { return provider; }
        @Override protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
            super.onSizeChanged(width, height, oldWidth, oldHeight);
            bounds[0] = new Rect(0, 0, width, height); layoutNodes(tree.root());
        }
        private void layoutNodes(TraversalFixtureTree.Node parent) {
            Rect rect = bounds[parent.id - 1];
            for (int i = 0; i < parent.children.size(); i++) {
                TraversalFixtureTree.Node child = parent.children.get(i);
                Rect local = childRect(rect.width(), rect.height(), i, !child.children.isEmpty()); local.offset(rect.left, rect.top);
                bounds[child.id - 1] = local; layoutNodes(child);
            }
        }
        private final class Provider extends AccessibilityNodeProvider {
            @Override public AccessibilityNodeInfo createAccessibilityNodeInfo(int virtualId) {
                if (traceProvider) Trace.beginSection("InspectorProviderNode");
                try {
                    AccessibilityNodeInfo info = profiledNodeInfo(virtualId);
                    if (info != null && auditVirtualIdCounts != null
                            && virtualId >= 2 && virtualId < auditVirtualIdCounts.length) {
                        int calls = ++auditVirtualIdCounts[virtualId];
                        if (calls == 1) uniqueVirtualIds++;
                        else {
                            duplicateVirtualCreates++;
                            if (calls == 2) duplicatedVirtualIds++;
                        }
                        maxCreatesPerId = Math.max(maxCreatesPerId, calls);
                    }
                    return info;
                } finally {
                    if (traceProvider) Trace.endSection();
                }
            }
            private AccessibilityNodeInfo profiledNodeInfo(int virtualId) {
                if (!profileProvider) return nodeInfo(virtualId);
                long startedWall = SystemClock.elapsedRealtimeNanos();
                long startedCpu = Debug.threadCpuTimeNanos();
                try { return nodeInfo(virtualId); }
                finally {
                    providerWallNs += Math.max(0, SystemClock.elapsedRealtimeNanos() - startedWall);
                    providerCpuNs += Math.max(0, Debug.threadCpuTimeNanos() - startedCpu);
                }
            }
            private AccessibilityNodeInfo nodeInfo(int virtualId) {
                providerCreates++;
                TraversalFixtureTree.Node node = virtualId == View.NO_ID ? tree.root() : virtualId >= 2 ? tree.find(virtualId) : null;
                if (node == null || bounds[node.id - 1] == null) { invalidCreates++; return null; }
                AccessibilityNodeInfo info;
                if (virtualId == View.NO_ID) {
                    hostCreates++; info = AccessibilityNodeInfo.obtain(VirtualHost.this);
                    VirtualHost.this.onInitializeAccessibilityNodeInfo(info);
                    ViewParent parent = VirtualHost.this.getParentForAccessibility(); if (parent instanceof View) info.setParent((View)parent);
                } else {
                    info = AccessibilityNodeInfo.obtain(); info.setSource(VirtualHost.this, node.id);
                    info.setParent(VirtualHost.this, node.parent == tree.root() ? View.NO_ID : node.parent.id);
                }
                info.setPackageName(getPackageName()); info.setClassName(node.children.isEmpty() ? "android.widget.TextView" : "android.view.ViewGroup");
                // IDs above the fixed resource table are synthetic and scoped to this debug-only virtual provider.
                info.setViewIdResourceName(node.id > 530 ? getPackageName() + ":id/" + TraversalFixtureTree.name(node.id)
                        : getResources().getResourceName(resourceId(node.id)));
                info.setText(nodeText(node)); info.setContentDescription(nodeText(node));
                info.setEnabled(true); info.setFocusable(false); info.setClickable(false); info.setScrollable(false);
                info.setImportantForAccessibility(true);
                Rect local = new Rect(bounds[node.id - 1]);
                if (node.parent != null) { Rect parent = bounds[node.parent.id - 1]; local.offset(-parent.left, -parent.top); }
                info.setBoundsInParent(local);
                int[] origin = new int[2]; VirtualHost.this.getLocationOnScreen(origin);
                Rect screen = new Rect(bounds[node.id - 1]); screen.offset(origin[0], origin[1]); info.setBoundsInScreen(screen);
                Rect visible = new Rect(); boolean shown = VirtualHost.this.getGlobalVisibleRect(visible) && visible.intersect(screen);
                info.setVisibleToUser(shown);
                for (TraversalFixtureTree.Node child : node.children) info.addChild(VirtualHost.this, child.id);
                return info;
            }
            @Override public boolean performAction(int virtualId, int action, Bundle arguments) { return false; }
        }
    }
    private void resetAuditCounts() {
        providerCreates = hostCreates = invalidCreates = 0;
        providerWallNs = providerCpuNs = 0;
        if (auditVirtualIdCounts != null) Arrays.fill(auditVirtualIdCounts, 0);
        uniqueVirtualIds = duplicateVirtualCreates = duplicatedVirtualIds = maxCreatesPerId = 0;
    }
    private void dumpCounts(String reason) {
        if (tree == null) return;
        Log.i(TAG, "reason=" + reason + " elapsedRealtimeMs=" + SystemClock.elapsedRealtime() + " shape=" + tree.shape + " epoch=" + epoch
            + " fixtureNodes=" + tree.nodes.size() + " providerCreates=" + providerCreates + " hostCreates=" + hostCreates + " invalidCreates=" + invalidCreates
            + " profileProvider=" + profileProvider + " traceProvider=" + traceProvider
            + " providerWallNs=" + providerWallNs + " providerCpuNs=" + providerCpuNs
            + " auditProviderIds=" + (auditVirtualIdCounts != null) + " uniqueVirtualIds=" + uniqueVirtualIds
            + " duplicateVirtualCreates=" + duplicateVirtualCreates + " duplicatedVirtualIds=" + duplicatedVirtualIds
            + " maxCreatesPerId=" + maxCreatesPerId);
    }
    @Override protected void onDestroy() { dumpCounts("destroy"); super.onDestroy(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}

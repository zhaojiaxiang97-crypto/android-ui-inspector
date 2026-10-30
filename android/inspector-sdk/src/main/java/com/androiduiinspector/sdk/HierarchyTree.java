package com.androiduiinspector.sdk;

import android.app.Application;
import android.graphics.Outline;
import android.graphics.Rect;
import android.os.Build;
import android.os.Process;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.RelativeLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.lang.reflect.Field;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.HashMap;

/** Main-thread View traversal and tree/property encoding; no transport or image capture. */
final class HierarchyTree {
    private HierarchyTree() {}

    static final int MAX_NODES = 5000;

    private static final int MAX_DEPTH = 150;

    private static final int[] RELATIVE_RULES = {
            RelativeLayout.LEFT_OF, RelativeLayout.RIGHT_OF, RelativeLayout.ABOVE, RelativeLayout.BELOW,
            RelativeLayout.ALIGN_BASELINE, RelativeLayout.ALIGN_LEFT, RelativeLayout.ALIGN_TOP,
            RelativeLayout.ALIGN_RIGHT, RelativeLayout.ALIGN_BOTTOM, RelativeLayout.ALIGN_PARENT_LEFT,
            RelativeLayout.ALIGN_PARENT_TOP, RelativeLayout.ALIGN_PARENT_RIGHT, RelativeLayout.ALIGN_PARENT_BOTTOM,
            RelativeLayout.CENTER_IN_PARENT, RelativeLayout.CENTER_HORIZONTAL, RelativeLayout.CENTER_VERTICAL,
            RelativeLayout.START_OF, RelativeLayout.END_OF, RelativeLayout.ALIGN_START, RelativeLayout.ALIGN_END,
            RelativeLayout.ALIGN_PARENT_START, RelativeLayout.ALIGN_PARENT_END
    };

    private static final String[] RELATIVE_RULE_NAMES = {
            "leftOf", "rightOf", "above", "below", "alignBaseline", "alignLeft", "alignTop",
            "alignRight", "alignBottom", "alignParentLeft", "alignParentTop", "alignParentRight",
            "alignParentBottom", "centerInParent", "centerHorizontal", "centerVertical", "startOf",
            "endOf", "alignStart", "alignEnd", "alignParentStart", "alignParentEnd"
    };

    private static final String[] CONSTRAINT_ANCHORS = {
            "leftToLeft", "leftToRight", "rightToLeft", "rightToRight", "startToStart", "startToEnd",
            "endToStart", "endToEnd", "topToTop", "topToBottom", "bottomToTop", "bottomToBottom",
            "baselineToBaseline", "baselineToTop", "baselineToBottom", "circleConstraint"
    };

    private static final HashMap<Class<?>, HashMap<String, Field>> CONSTRAINT_FIELDS = new HashMap<>();

    static View findUnique(View root, String wanted) {
        ArrayDeque<View> queue = new ArrayDeque<>();
        queue.add(root);
        View found = null;
        int count = 0;
        while (!queue.isEmpty()) {
            if (++count > MAX_NODES) throw new IllegalStateException("View tree exceeds node budget");
            View view = queue.removeFirst();
            if (wanted.equals(ref(view))) {
                if (found != null) throw new IllegalStateException("View identity collision");
                found = view;
            }
            if (view instanceof ViewGroup) {
                ViewGroup group = (ViewGroup) view;
                for (int i = 0; i < group.getChildCount(); i++) queue.addLast(group.getChildAt(i));
            }
        }
        return found;
    }

    static JSONObject captureTree(Application app, View root, String processInstance) throws JSONException {
        JSONObject report = new JSONObject();
        report.put("version", 1);
        report.put("packageName", app.getPackageName());
        report.put("visibleStreamVersion", Build.VERSION.SDK_INT >= 30 ? 2 : 1);
        report.put("styleVersion", 1);
        report.put("branchGeometryVersion", 1);
        report.put("refDebugCanvasVersion", 1);
        report.put("uiWakeVersion", 1);
        report.put("visibleTreeGuardVersion", 1);
        report.put("debugMetadataVersion", DebugMetadata.VERSION);
        report.put("pid", Process.myPid());
        report.put("processInstance", processInstance);
        report.put("capturedAtMillis", System.currentTimeMillis());
        DebugMetadata.Budget debugBudget = new DebugMetadata.Budget();
        JSONObject first = node(root, debugBudget);
        report.put("root", first);
        ArrayDeque<Frame> queue = new ArrayDeque<>();
        queue.add(new Frame(root, first, 0));
        HashSet<String> refs = new HashSet<>();
        JSONObject classHierarchy = new JSONObject();
        int count = 0;
        long started = SystemClock.uptimeMillis();
        while (!queue.isEmpty()) {
            Frame frame = queue.removeFirst();
            // ponytail: synchronous main-thread probe; split into frame-sized batches if large apps exceed this cap.
            if (++count > MAX_NODES) throw new IllegalStateException("View tree exceeds node budget");
            if (frame.depth > MAX_DEPTH) throw new IllegalStateException("View tree exceeds depth budget");
            if (SystemClock.uptimeMillis() - started > 1000) throw new IllegalStateException("View tree exceeds 1000 ms time budget");
            String ref = ref(frame.view);
            if (!refs.add(ref)) throw new IllegalStateException("View identity collision");
            Class<?> viewClass = frame.view.getClass();
            if (!classHierarchy.has(viewClass.getName())) {
                JSONArray ancestors = new JSONArray();
                for (Class<?> type = viewClass; type != null && View.class.isAssignableFrom(type); type = type.getSuperclass())
                    ancestors.put(type.getName());
                classHierarchy.put(viewClass.getName(), ancestors);
            }
            JSONArray children = new JSONArray();
            frame.json.put("children", children);
            if (!(frame.view instanceof ViewGroup)) continue;
            ViewGroup group = (ViewGroup) frame.view;
            for (int i = 0; i < group.getChildCount(); i++) {
                View child = group.getChildAt(i);
                JSONObject item = node(child, debugBudget);
                children.put(item);
                queue.addLast(new Frame(child, item, frame.depth + 1));
            }
        }
        report.put("nodeCount", count);
        report.put("classHierarchy", classHierarchy);
        return report;
    }

    private static JSONObject node(View view, DebugMetadata.Budget debugBudget) throws JSONException {
        JSONObject item = new JSONObject();
        item.put("ref", ref(view));
        item.put("className", view.getClass().getName());
        item.put("width", view.getWidth());
        item.put("height", view.getHeight());
        int[] location = new int[2];
        view.getLocationOnScreen(location);
        item.put("screenX", location[0]);
        item.put("screenY", location[1]);
        item.put("visible", view.getVisibility() == View.VISIBLE);
        item.put("clickable", view.isClickable());
        item.put("longClickable", view.isLongClickable());
        if (Build.VERSION.SDK_INT >= 23) item.put("contextClickable", view.isContextClickable());
        item.put("hasOnClickListeners", view.hasOnClickListeners());
        item.put("enabled", view.isEnabled());
        item.put("hardwareAccelerated", view.isHardwareAccelerated());
        item.put("focusable", view.isFocusable());
        item.put("focused", view.isFocused());
        item.put("selected", view.isSelected());
        item.put("pressed", view.isPressed());
        item.put("activated", view.isActivated());
        item.put("scrollable", view.isScrollContainer());
        item.put("alpha", view.getAlpha());
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            item.put("clipChildren", group.getClipChildren());
            item.put("clipToPadding", group.getClipToPadding());
        }
        if (view.getClipToOutline()) {
            item.put("clipToOutline", true);
            Outline outline = new Outline();
            try {
                if (view.getOutlineProvider() != null) view.getOutlineProvider().getOutline(view, outline);
            } catch (RuntimeException ignored) {
                // The tree remains available; the desktop must not synthesize an unknown outline.
            }
            Rect rect = new Rect();
            if (outline.canClip() && outline.getRect(rect)) {
                item.put("outlineLeft", rect.left);
                item.put("outlineTop", rect.top);
                item.put("outlineRight", rect.right);
                item.put("outlineBottom", rect.bottom);
                item.put("outlineRadius", outline.getRadius());
            }
        }
        item.put("elevation", view.getElevation());
        item.put("paddingLeft", view.getPaddingLeft());
        item.put("paddingTop", view.getPaddingTop());
        item.put("paddingRight", view.getPaddingRight());
        item.put("paddingBottom", view.getPaddingBottom());
        Object debugName = view.getTag(R.id.inspector_debug_name);
        if (debugName instanceof String) item.put("debugName", debugName);
        JSONObject debugMetadata = DebugMetadata.read(view, debugBudget);
        if (debugMetadata != null) item.put("debugMetadata", debugMetadata);
        ViewGroup.LayoutParams params = view.getLayoutParams();
        if (params != null) {
            item.put("layoutParamsClass", params.getClass().getName());
            item.put("layoutWidth", params.width);
            item.put("layoutHeight", params.height);
            if (params instanceof FrameLayout.LayoutParams) item.put("layoutGravity", ((FrameLayout.LayoutParams) params).gravity);
            if (params instanceof LinearLayout.LayoutParams) {
                LinearLayout.LayoutParams linear = (LinearLayout.LayoutParams) params;
                item.put("layoutGravity", linear.gravity);
                item.put("layoutWeight", linear.weight);
            }
            if (params instanceof ViewGroup.MarginLayoutParams) {
                ViewGroup.MarginLayoutParams margins = (ViewGroup.MarginLayoutParams) params;
                item.put("marginLeft", margins.leftMargin);
                item.put("marginTop", margins.topMargin);
                item.put("marginRight", margins.rightMargin);
                item.put("marginBottom", margins.bottomMargin);
            }
            JSONObject layoutRules = layoutRules(view, params);
            if (layoutRules != null) item.put("layoutRules", layoutRules);
        }
        if (view.getId() != View.NO_ID) {
            try { item.put("resourceId", view.getResources().getResourceName(view.getId())); }
            catch (android.content.res.Resources.NotFoundException ignored) { item.put("resourceId", Integer.toHexString(view.getId())); }
        }
        CharSequence desc = view.getContentDescription();
        if (desc != null) item.put("contentDesc", bounded(desc));
        if (view instanceof TextView) item.put("text", bounded(((TextView) view).getText()));
        return item;
    }

    private static String bounded(CharSequence value) {
        String text = value.toString();
        return text.length() <= 512 ? text : text.substring(0, 512);
    }

    private static JSONObject layoutRules(View view, ViewGroup.LayoutParams params) throws JSONException {
        JSONObject rules = new JSONObject();
        String type;
        if (params instanceof RelativeLayout.LayoutParams) {
            type = "RelativeLayout";
            RelativeLayout.LayoutParams relative = (RelativeLayout.LayoutParams) params;
            int[] values = relative.getRules();
            for (int i = 0; i < RELATIVE_RULES.length && i < values.length; i++) {
                int value = values[i];
                if (value == 0) continue;
                int rule = RELATIVE_RULES[i];
                boolean parentRule = rule == RelativeLayout.ALIGN_PARENT_LEFT || rule == RelativeLayout.ALIGN_PARENT_TOP
                        || rule == RelativeLayout.ALIGN_PARENT_RIGHT || rule == RelativeLayout.ALIGN_PARENT_BOTTOM
                        || rule == RelativeLayout.ALIGN_PARENT_START || rule == RelativeLayout.ALIGN_PARENT_END
                        || rule == RelativeLayout.CENTER_IN_PARENT || rule == RelativeLayout.CENTER_HORIZONTAL
                        || rule == RelativeLayout.CENTER_VERTICAL;
                if (parentRule) rules.put(RELATIVE_RULE_NAMES[i], value == RelativeLayout.TRUE);
                else rules.put(RELATIVE_RULE_NAMES[i], layoutTarget(view, value));
            }
        } else {
            Class<?> constraintParams = constraintLayoutParamsClass(params.getClass());
            if (constraintParams == null) return null;
            type = "ConstraintLayout";
            for (String name : CONSTRAINT_ANCHORS) {
                Object raw = constraintFieldValue(params, constraintParams, name);
                if (!(raw instanceof Integer) || (Integer) raw == -1) continue;
                rules.put(name, layoutTarget(view, (Integer) raw));
            }
            boolean horizontal = rules.has("leftToLeft") || rules.has("leftToRight") || rules.has("rightToLeft")
                    || rules.has("rightToRight") || rules.has("startToStart") || rules.has("startToEnd")
                    || rules.has("endToStart") || rules.has("endToEnd");
            boolean vertical = rules.has("topToTop") || rules.has("topToBottom") || rules.has("bottomToTop")
                    || rules.has("bottomToBottom") || rules.has("baselineToBaseline") || rules.has("baselineToTop")
                    || rules.has("baselineToBottom");
            if (horizontal) putConstraintNumber(params, constraintParams, rules, "horizontalBias");
            if (vertical) putConstraintNumber(params, constraintParams, rules, "verticalBias");
            if (rules.has("circleConstraint")) {
                putConstraintNumber(params, constraintParams, rules, "circleRadius");
                putConstraintNumber(params, constraintParams, rules, "circleAngle");
            }
            Object ratio = constraintFieldValue(params, constraintParams, "dimensionRatio");
            if (ratio instanceof String && !((String) ratio).isEmpty()) rules.put("dimensionRatio", ratio);
        }
        if (rules.length() == 0) return null;
        JSONObject result = new JSONObject();
        result.put("type", type);
        result.put("rules", rules);
        return result;
    }

    private static Class<?> constraintLayoutParamsClass(Class<?> type) {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            if ("androidx.constraintlayout.widget.ConstraintLayout$LayoutParams".equals(current.getName())) return current;
        }
        return null;
    }

    private static Object constraintFieldValue(ViewGroup.LayoutParams params, Class<?> type, String name) {
        HashMap<String, Field> fields = CONSTRAINT_FIELDS.get(type);
        if (fields == null) {
            fields = new HashMap<>();
            CONSTRAINT_FIELDS.put(type, fields);
        }
        if (!fields.containsKey(name)) {
            try { fields.put(name, type.getField(name)); }
            catch (NoSuchFieldException ignored) { fields.put(name, null); }
        }
        Field field = fields.get(name);
        if (field == null) return null;
        try { return field.get(params); }
        catch (IllegalAccessException ignored) { return null; }
    }

    private static void putConstraintNumber(ViewGroup.LayoutParams params, Class<?> type, JSONObject rules, String name) throws JSONException {
        Object value = constraintFieldValue(params, type, name);
        if (value instanceof Number) {
            float number = ((Number) value).floatValue();
            if (!Float.isNaN(number) && !Float.isInfinite(number)) rules.put(name, String.valueOf(value));
        }
    }

    private static String layoutTarget(View view, int id) {
        if (id == 0) return "parent";
        try { return view.getResources().getResourceName(id); }
        catch (RuntimeException ignored) { return "id/0x" + Integer.toHexString(id); }
    }

    static String ref(View view) {
        return view.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(view));
    }

    private static final class Frame {
        final View view;
        final JSONObject json;
        final int depth;
        Frame(View view, JSONObject json, int depth) { this.view = view; this.json = json; this.depth = depth; }
    }
}

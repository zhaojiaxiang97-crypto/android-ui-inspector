package com.androiduiinspector.sdk;

import android.view.View;
import org.json.JSONObject;

/** Runs the actual registration implementation against a tag/thread test double. */
public final class DebugMetadataCheck {
    interface Action { void run(); }
    static void check(boolean condition) { if (!condition) throw new AssertionError(); }
    static void rejects(Action action) {
        try { action.run(); throw new AssertionError("Invalid registration was accepted"); }
        catch (IllegalArgumentException expected) {}
    }
    static JSONObject read(View view) throws Exception { return DebugMetadata.read(view, new DebugMetadata.Budget()); }
    static String repeat(String text, int count) { StringBuilder result = new StringBuilder(); while (count-- > 0) result.append(text); return result.toString(); }

    public static void main(String[] args) throws Exception {
        View view = new View();
        check(read(view) == null);
        DebugMetadata.Field[] fields = {
            DebugMetadata.text("name", "组件名", "SampleCard"),
            DebugMetadata.text("owner", "归属", "Inspector 自有样例"),
            DebugMetadata.flag("loading", "加载中", false),
            DebugMetadata.number("retryCount", "重试次数", 0),
            DebugMetadata.text("error", "错误信息", ""),
            DebugMetadata.text("unicode", "特殊字符", "中😀\n\"\\</script>"),
            DebugMetadata.number("decimal", "小数", 0.125)
        };
        DebugMetadata.setGroup(view, "component", " 组件信息 ", fields);
        String original = read(view).toString();
        fields[0] = DebugMetadata.text("name", "组件名", "Mutated caller array");
        check(original.equals(read(view).toString()));
        JSONObject mutableRead = read(view); mutableRead.put("source", "changed");
        check(original.equals(read(view).toString()));
        check(read(new View()) == null);
        System.out.println(original);

        rejects(() -> DebugMetadata.text("bad/key", "Label", "text"));
        rejects(() -> DebugMetadata.text("a", "Label", null));
        rejects(() -> DebugMetadata.text("a", "Label", repeat("x", 513)));
        rejects(() -> DebugMetadata.text("a", "Label", "\ud800"));
        rejects(() -> DebugMetadata.text("a", "", "text"));
        rejects(() -> DebugMetadata.text("a", "Line\nfeed", "text"));
        rejects(() -> DebugMetadata.number("a", "Label", Double.NaN));
        rejects(() -> DebugMetadata.number("a", "Label", Double.POSITIVE_INFINITY));
        rejects(() -> DebugMetadata.number("a", "Label", 9007199254740992d));
        rejects(() -> DebugMetadata.clear(null));
        rejects(() -> DebugMetadata.setGroup(view, "empty", "Empty"));
        rejects(() -> DebugMetadata.setGroup(view, "duplicate", "Duplicate", fields[0], fields[0]));
        rejects(() -> DebugMetadata.setGroup(view, "bad", "Bad", (DebugMetadata.Field) null));
        DebugMetadata.Field[] many = new DebugMetadata.Field[17];
        for (int i = 0; i < many.length; i++) many[i] = DebugMetadata.text("f" + i, "Field", "v");
        rejects(() -> DebugMetadata.setGroup(view, "many", "Many", many));
        check(original.equals(read(view).toString()));

        DebugMetadata.setGroup(view, "component", "组件信息", DebugMetadata.text("name", "组件名", "Updated"));
        check(read(view).getJSONArray("groups").length() == 1);
        check(read(view).getJSONArray("groups").getJSONObject(0).getJSONArray("fields").getJSONObject(0).getString("value").equals("Updated"));
        for (int i = 0; i < 3; i++) DebugMetadata.setGroup(view, "g" + i, "Group", fields[0]);
        String full = read(view).toString();
        rejects(() -> DebugMetadata.setGroup(view, "g4", "Group", fields[0]));
        check(full.equals(read(view).toString()));
        DebugMetadata.removeGroup(view, "g1");
        check(read(view).getJSONArray("groups").length() == 3);
        DebugMetadata.removeGroup(view, "missing");
        check(read(view).getJSONArray("groups").length() == 3);
        DebugMetadata.clear(view); check(read(view) == null);
        DebugMetadata.setGroup(view, "component", "Next item", DebugMetadata.number("n", "Number", 9007199254740991d));
        check(read(view).getJSONArray("groups").length() == 1);

        final Throwable[] wrongThread = new Throwable[1];
        Thread worker = new Thread(() -> {
            try { DebugMetadata.clear(view); } catch (Throwable expected) { wrongThread[0] = expected; }
        });
        worker.start(); worker.join(); check(wrongThread[0] instanceof IllegalStateException);
        check(read(view) != null);

        View large = new View();
        DebugMetadata.Field[] text = new DebugMetadata.Field[8];
        for (int i = 0; i < text.length; i++) text[i] = DebugMetadata.text("f" + i, "Field", repeat("x", 512));
        for (int i = 0; i < 3; i++) DebugMetadata.setGroup(large, "g" + i, "Group", text);
        String previous = read(large).toString();
        rejects(() -> DebugMetadata.setGroup(large, "g3", "Too big", text));
        check(previous.equals(read(large).toString()));
        View multibyte = new View();
        for (int i = 0; i < text.length; i++) text[i] = DebugMetadata.text("f" + i, "Field", repeat("中", 512));
        DebugMetadata.setGroup(multibyte, "g0", "Group", text);
        rejects(() -> DebugMetadata.setGroup(multibyte, "g1", "Too big", text));

        DebugMetadata.Budget budget = new DebugMetadata.Budget(); int accepted = 0;
        while (DebugMetadata.read(large, budget).getString("status").equals("captured")) accepted++;
        check(accepted > 1 && accepted < 30 && budget.bytes <= 256 * 1024);
        JSONObject omitted = DebugMetadata.read(large, budget);
        check(omitted.getString("status").equals("omitted-budget") && omitted.getJSONArray("groups").length() == 0);
        check(DebugMetadata.read(large, new DebugMetadata.Budget()).getString("status").equals("captured"));
        View structured = new View();
        DebugMetadata.TreeNode[] children = {
            DebugMetadata.treeFlag("loading", "Loading", false),
            DebugMetadata.treeNumber("retries", "Retries", 0),
            DebugMetadata.treeText("error", "Error", ""),
            DebugMetadata.treeText("payload", "Payload", "  中😀\n\"\\</script>  "),
            DebugMetadata.treeNumber("decimal", "Decimal", 1e-7)
        };
        DebugMetadata.TreeNode request = DebugMetadata.treeNull("request", "Request", children);
        DebugMetadata.TreeNode[] roots = { request, DebugMetadata.treeText("cache", "Cache", "ok", DebugMetadata.treeFlag("loading", "Loading", true)) };
        DebugMetadata.Field detail = DebugMetadata.tree("detail", "Detail", roots);
        children[0] = DebugMetadata.treeFlag("mutated", "Mutated", true);
        roots[0] = DebugMetadata.treeNull("mutated", "Mutated");
        DebugMetadata.setGroup(structured, "state", "State", DebugMetadata.nullValue("absent", "Absent"), detail);
        String structuredOriginal = read(structured).toString();
        JSONObject captured = read(structured);
        check(captured.getInt("version") == 2);
        check(captured.getJSONArray("groups").getJSONObject(0).getJSONArray("fields").getJSONObject(0).isNull("value"));
        check(captured.getJSONArray("groups").getJSONObject(0).getJSONArray("fields").getJSONObject(1).getJSONArray("value").getJSONObject(0).getString("key").equals("request"));
        System.out.println(structuredOriginal);
        captured.getJSONArray("groups").getJSONObject(0).getJSONArray("fields").getJSONObject(1).getJSONArray("value").getJSONObject(0).getJSONArray("children").getJSONObject(0).put("value", true);
        check(structuredOriginal.equals(read(structured).toString()));
        rejects(() -> DebugMetadata.tree("empty", "Empty"));
        rejects(() -> DebugMetadata.tree("empty", "Empty", (DebugMetadata.TreeNode[]) null));
        rejects(() -> DebugMetadata.tree("bad", "Bad", (DebugMetadata.TreeNode) null));
        rejects(() -> DebugMetadata.tree("duplicate", "Duplicate", request, request));
        rejects(() -> DebugMetadata.treeNull("duplicate", "Duplicate", request, request));
        rejects(() -> DebugMetadata.treeText("bad", "Bad", "\ud800"));
        rejects(() -> DebugMetadata.treeText("bad", "Bad", repeat("x", 513)));
        rejects(() -> DebugMetadata.treeNumber("bad", "Bad", Double.NaN));
        rejects(() -> DebugMetadata.treeNumber("bad", "Bad", Double.POSITIVE_INFINITY));
        rejects(() -> DebugMetadata.treeNumber("bad", "Bad", 9007199254740992d));
        DebugMetadata.TreeNode deep = DebugMetadata.treeNull("leaf", "Leaf");
        for (int i = 0; i < 7; i++) deep = DebugMetadata.treeNull("level" + i, "Level", deep);
        DebugMetadata.tree("depth8", "Depth8", deep);
        final DebugMetadata.TreeNode depth9 = DebugMetadata.treeNull("overflow", "Overflow", deep);
        rejects(() -> DebugMetadata.tree("depth9", "Depth9", depth9));
        DebugMetadata.TreeNode[] wide = new DebugMetadata.TreeNode[128];
        for (int i = 0; i < wide.length; i++) wide[i] = DebugMetadata.treeNull("n" + i, "Node");
        DebugMetadata.setGroup(new View(), "wide", "Wide", DebugMetadata.tree("nodes", "Nodes", wide));
        rejects(() -> DebugMetadata.tree("nodes129", "Nodes129", DebugMetadata.treeNull("parent", "Parent", wide)));
        for (int i = 0; i < wide.length; i++) wide[i] = DebugMetadata.treeText("n" + i, "Node", repeat("中", 512));
        rejects(() -> DebugMetadata.setGroup(structured, "tooBig", "Too big", DebugMetadata.tree("nodes", "Nodes", wide)));
        check(structuredOriginal.equals(read(structured).toString()));
        DebugMetadata.Budget exhausted = new DebugMetadata.Budget(); exhausted.bytes = 256 * 1024;
        check(DebugMetadata.read(structured, exhausted).getInt("version") == 2);
        check(DebugMetadata.read(structured, exhausted).getString("status").equals("omitted-budget"));
        DebugMetadata.setGroup(structured, "state", "Scalar again", DebugMetadata.text("name", "Name", "old client compatible"));
        check(read(structured).getInt("version") == 1);
        System.out.println("structured copies, nullable values, sibling keys, depth and node limits passed");
        System.out.println("registration, atomic updates, thread guard, removal, Unicode and byte budgets passed");
    }
}

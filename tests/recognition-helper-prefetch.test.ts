import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("batched child reads preserve the full template traversal, hidden nodes, failures, limits and API32 fallback", { timeout: 30000 }, context => {
  const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  const compiler = spawnSync(java("javac"), ["-version"], { encoding: "utf8", timeout: 5000 });
  if (!process.env.JAVA_HOME && ((compiler.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    || /Unable to locate a Java Runtime|No Java runtime present/i.test(compiler.stderr ?? ""))) {
    context.skip("JDK unavailable; install JDK 17 to execute the Android template prefetch regression.");
    return;
  }
  assert.equal(compiler.status, 0, compiler.stderr || compiler.error?.message);
  const source = readFileSync(new URL("../scripts/helper-templates/InspectorObservation.java", import.meta.url), "utf8");
  const part = (start: string, end: string) => {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first > 0 && last > first); return source.slice(first, last);
  };
  const flags = source.match(/private static final int CHILD_PREFETCH_FLAGS =[\s\S]*?;/)?.[0];
  assert.ok(flags);
  const directory = mkdtempSync(join(tmpdir(), "helper-prefetch-"));
  try {
    const file = join(directory, "PrefetchCheck.java");
    writeFileSync(file, `import java.util.*;
public class PrefetchCheck {
  static final int MAX_NODES=5000,MAX_DEPTH=75;
  ${flags}
  static class Build { static class VERSION { static int SDK_INT=33; } }
  static class JSONArray {}
  static class JSONObject { String getString(String s){return "application";} int getInt(String s){return 1;} boolean getBoolean(String s){return true;} }
  static class Rect {
    int left,top,right,bottom;
    Rect(){} Rect(int l,int t,int r,int b){left=l;top=t;right=r;bottom=b;} Rect(Rect r){this(r.left,r.top,r.right,r.bottom);}
    boolean isEmpty(){return left>=right||top>=bottom;} void setEmpty(){left=top=right=bottom=0;}
    boolean intersect(Rect r){if(left<r.right&&r.left<right&&top<r.bottom&&r.top<bottom){left=Math.max(left,r.left);top=Math.max(top,r.top);right=Math.min(right,r.right);bottom=Math.min(bottom,r.bottom);return true;}return false;}
  }
  static class Source {
    final int id; final List<Source> children=new ArrayList<>();
    Source(int id){this.id=id;} Source add(Source child){children.add(child);return child;}
  }
  static final Set<Integer> cache=new HashSet<>();
  static int modern,legacy,ipc,created,recycled,nullId=-1,throwId=-1;
  static class AccessibilityNodeInfo {
    static final int FLAG_PREFETCH_DESCENDANTS_DEPTH_FIRST=8, FLAG_PREFETCH_UNINTERRUPTIBLE=32;
    final Source source; boolean dead;
    AccessibilityNodeInfo(Source source){this.source=source;created++;}
    int getChildCount(){check(!dead,"recycled parent");return source.children.size();}
    AccessibilityNodeInfo getChild(int i){legacy++;return fetch(source.children.get(i),0);}
    AccessibilityNodeInfo getChild(int i,int flags){modern++;check(flags==40,"wrong prefetch flags");return fetch(source.children.get(i),flags);}
    void getBoundsInScreen(Rect r){r.left=0;r.top=0;r.right=100;r.bottom=200;}
    boolean isVisibleToUser(){return source.id%10!=7;}
    boolean isEnabled(){return true;} boolean isClickable(){return false;} boolean isFocusable(){return false;}
    boolean isFocused(){return false;} boolean isScrollable(){return false;} boolean isSelected(){return false;}
    boolean isCheckable(){return false;} boolean isChecked(){return false;} boolean isLongClickable(){return false;}
    boolean isPassword(){return false;} boolean isEditable(){return false;} int getDrawingOrder(){return 0;}
    int getWindowId(){return 7;} String getClassName(){return "android.view.View";} String getPackageName(){return "com.example.helper";}
    String getText(){return "node-"+source.id;} String getViewIdResourceName(){return "id/"+source.id;} String getContentDescription(){return "";}
  }
  static AccessibilityNodeInfo fetch(Source node,int flags){
    if(node.id==throwId)throw new IllegalStateException("unavailable child");if(node.id==nullId)return null;
    if(!cache.contains(node.id)){ipc++;if((flags&32)!=0)batch(node,new int[]{50});else cache.add(node.id);}
    return new AccessibilityNodeInfo(node);
  }
  // A controlled cache model exercises traversal across batch boundaries. It is
  // not a device benchmark or a claim about OEM scheduling/IPC counts.
  static void batch(Source node,int[] left){if(left[0]--<=0)return;cache.add(node.id);for(Source child:node.children){if(left[0]<=0)break;batch(child,left);}}
  static class HierarchyDumper { static void safeRecycle(AccessibilityNodeInfo node){if(node!=null){check(!node.dead,"double recycle");node.dead=true;recycled++;}} }
  static class XmlUtils {
    static void appendAttribute(StringBuilder b,String k,String v){b.append(' ').append(k).append("=\\\"").append(v).append("\\\"");}
    static void appendIntAttribute(StringBuilder b,String k,int v){appendAttribute(b,k,Integer.toString(v));}
    static void appendBooleanAttribute(StringBuilder b,String k,boolean v){appendAttribute(b,k,Boolean.toString(v));}
  }
${part("    private static final class Capture {", "    /** Serializes concurrent clients.")}
${part("    private static String node(", "    private static final class Screenshot {")}
${part("    private static Rect intersection(", "    private static JSONObject rectJson(")}
${part("    private static String bounds(", "    private static String windowType(")}
  static void check(boolean ok,String label){if(!ok)throw new AssertionError(label);}
  static String run(Source root,int sdk,Capture capture){
    Build.VERSION.SDK_INT=sdk;cache.clear();modern=legacy=ipc=created=recycled=0;
    AccessibilityNodeInfo first=new AccessibilityNodeInfo(root);
    String xml=node(first,0,0,"7",null,new Rect(0,0,100,200),true,capture);
    check(recycled==created-1,"every child handle must be recycled");check(!first.dead,"caller still owns root");
    HierarchyDumper.safeRecycle(first);return xml;
  }
  public static void main(String[] args){
    Source root=new Source(0);int next=1;
    for(int group=0;group<4;group++){Source branch=root.add(new Source(next++));for(int leaf=0;leaf<80;leaf++)branch.add(new Source(next++));}
    Capture modernCapture=new Capture();String modernXml=run(root,33,modernCapture);int batchedIpc=ipc;
    check(modernCapture.complete&&!modernCapture.truncated&&modernCapture.nodes==325,"modern full tree");
    check(modern==324&&legacy==0,"API33 must use flags for every requested child");
    check(modernXml.contains("node-324")&&modernXml.contains("visible-to-user=\\\"false\\\""),"last and hidden nodes preserved");
    Capture legacyCapture=new Capture();String legacyXml=run(root,32,legacyCapture);
    check(legacyCapture.complete&&legacyCapture.nodes==325&&modern==0&&legacy==324,"API32 fallback");
    check(modernXml.equals(legacyXml),"prefetch must not alter XML or order");check(batchedIpc<ipc,"cache batches should cover later requests in model");
    nullId=4;Capture missing=new Capture();run(root,33,missing);check(!missing.complete,"missing child fails completeness");nullId=-1;
    throwId=5;Capture failed=new Capture();run(root,33,failed);check(!failed.complete,"exception fails completeness without fallback");throwId=-1;
    Source wide=new Source(0);for(int i=1;i<=5001;i++)wide.add(new Source(i));Capture limited=new Capture();run(wide,33,limited);
    check(limited.truncated&&limited.nodes==MAX_NODES,"node limit retained");
    Source deep=new Source(0),tail=deep;for(int i=1;i<=77;i++)tail=tail.add(new Source(i));Capture depth=new Capture();run(deep,33,depth);
    check(depth.truncated&&depth.nodes==MAX_DEPTH+1,"depth limit retained");
    System.out.println("prefetch traversal and compatibility checks passed");
  }
}`);
    const compiled = spawnSync(java("javac"), ["--release", "8", "-d", directory, file], { encoding: "utf8", timeout: 10000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(java("java"), ["-cp", directory, "PrefetchCheck"], { encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /prefetch traversal and compatibility checks passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

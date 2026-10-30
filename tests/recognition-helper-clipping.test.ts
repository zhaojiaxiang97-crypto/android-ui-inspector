import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseUiHierarchy } from "../electron/capture/xml-tree";
import { hasCompleteHelperTree } from "../shared/helper-observation";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

test("Inspector clipping canonicalizes empty inputs without changing raw geometry or valid intersections", { timeout: 20000 }, () => {
  const source = readFileSync(new URL("../scripts/helper-templates/InspectorObservation.java", import.meta.url), "utf8");
  const start = source.indexOf("    private static Rect intersection("), end = source.indexOf("    private static JSONObject rectJson(", start);
  assert.ok(start > 0 && end > start);
  const directory = mkdtempSync(join(tmpdir(), "helper-clipping-"));
  try {
    const file = join(directory, "ClippingCheck.java");
    writeFileSync(file, `public class ClippingCheck {
  static class Rect {
    int left,top,right,bottom;
    Rect(){} Rect(int l,int t,int r,int b){left=l;top=t;right=r;bottom=b;}
    Rect(Rect r){this(r.left,r.top,r.right,r.bottom);}
    boolean isEmpty(){return left>=right||top>=bottom;}
    void setEmpty(){left=top=right=bottom=0;}
    // Deliberately matches Android's documented lack of an empty-input check.
    boolean intersect(Rect r){
      if(left<r.right && r.left<right && top<r.bottom && r.top<bottom){
        left=Math.max(left,r.left);top=Math.max(top,r.top);right=Math.min(right,r.right);bottom=Math.min(bottom,r.bottom);return true;
      }
      return false;
    }
    String value(){return left+","+top+","+right+","+bottom;}
  }
${source.slice(start, end)}
  static void check(Rect a,Rect b,String expected){
    String beforeA=a.value(),beforeB=b.value();Rect actual=intersection(a,b);
    if(!actual.value().equals(expected))throw new AssertionError(actual.value()+" != "+expected);
    if(!a.value().equals(beforeA)||!b.value().equals(beforeB))throw new AssertionError("diagnostic input mutated");
  }
  public static void main(String[] args){
    Rect screen=new Rect(0,0,1080,2355);
    // Real observed failure: inverted x still passes Rect.intersect's overlap test.
    Rect trap=new Rect(53,0,34,74);
    if(!trap.intersect(screen)||!trap.isEmpty())throw new AssertionError("stub must retain Android empty-input behavior");
    for(Rect empty:new Rect[]{new Rect(53,0,34,74),new Rect(10,90,50,20),new Rect(15,20,15,74),new Rect(15,20,80,20),new Rect()}){
      check(empty,screen,"0,0,0,0");check(screen,empty,"0,0,0,0");
    }
    check(new Rect(1200,50,1300,100),screen,"0,0,0,0");
    check(new Rect(-10,20,100,2500),screen,"0,20,100,2355");
    check(new Rect(53,20,90,74),screen,"53,20,90,74");
    System.out.println("empty clipping and raw preservation passed");
  }
}`);
    const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
    const compiled = spawnSync(java("javac"), ["--release", "8", "-d", directory, file], { encoding: "utf8", timeout: 10000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(java("java"), ["-cp", directory, "ClippingCheck"], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /empty clipping and raw preservation passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("host accepts hidden inverted raw geometry only with an empty visible rectangle", () => {
  for (const raw of ["[53,0][34,74]", "[10,90][50,20]"]) {
    const snapshot = helperEvidenceSnapshot();
    const xml = snapshot.rawXml!.replace('bounds="[0,0][100,200]"', 'bounds="[0,0][0,0]"')
      .replace('visible-bounds="[0,0][100,200]"', 'visible-bounds="[0,0][0,0]"')
      .replace('bounds-screen="[0,0][100,200]"', `bounds-screen="${raw}"`)
      .replace('visible-to-user="true"', 'visible-to-user="false"');
    snapshot.root = parseUiHierarchy(xml).root;
    assert.equal(snapshot.root.attributes!["bounds-screen"], raw, "raw diagnostics must stay unchanged");
    assert.equal(hasCompleteHelperTree(snapshot), true);
    for (const visible of [false, true]) {
      const broken = xml.replace('bounds="[0,0][0,0]"', `bounds="${raw}"`)
        .replace('visible-bounds="[0,0][0,0]"', `visible-bounds="${raw}"`)
        .replace('visible-to-user="false"', `visible-to-user="${visible}"`);
      snapshot.root = parseUiHierarchy(broken).root;
      assert.equal(hasCompleteHelperTree(snapshot), false, "inverted visible rectangles remain forbidden, even on hidden nodes");
    }
    snapshot.root = parseUiHierarchy(xml.replace('visible-to-user="false"', 'visible-to-user="true"')).root;
    assert.equal(hasCompleteHelperTree(snapshot), false, "empty hit areas cannot claim visibility");
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("SDK alpha scan never guesses large or unreadable bitmaps are nonempty", { timeout: 20000 }, () => {
  const source = readFileSync(join(import.meta.dirname, "../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/CaptureOutput.java"), "utf8");
  const start = source.indexOf("    static boolean isEmptyBitmap(");
  const end = source.indexOf("    static VisibleRecord encodeFrame(", start);
  assert.ok(start > 0 && end > start);
  const directory = mkdtempSync(join(tmpdir(), "sdk-bitmap-alpha-"));
  try {
    const path = join(directory, "AlphaCheck.java");
    writeFileSync(path, `import java.util.Arrays;
public class AlphaCheck {
  static class Bitmap {
    enum Config { HARDWARE, ARGB_8888 }
    int width,height,lastAlpha,reads; boolean broken,nullCopy,recycled; Config config=Config.ARGB_8888; Bitmap copied;
    Bitmap(int w,int h){width=w;height=h;}
    int getWidth(){return width;} int getHeight(){return height;} Config getConfig(){return config;}
    Bitmap copy(Config c,boolean mutable){if(nullCopy)return null; copied=new Bitmap(width,height);copied.lastAlpha=lastAlpha;copied.broken=broken;return copied;}
    void getPixels(int[] row,int offset,int stride,int x,int y,int w,int h){
      if(broken||config==Config.HARDWARE||recycled)throw new IllegalStateException("unreadable");
      reads++; Arrays.fill(row,0); if(y==height-1)row[width-1]=lastAlpha<<24;
    }
    void recycle(){recycled=true;}
  }
${source.slice(start, end)}
  static void check(boolean b){if(!b)throw new AssertionError();}
  static void rejects(Bitmap b){try{isEmptyBitmap(b);throw new AssertionError("guessed empty state");}catch(IllegalStateException expected){}}
  public static void main(String[] args){
    Bitmap big=new Bitmap(1080,2400); check(isEmptyBitmap(big));check(big.reads==2400);check(!big.recycled);
    big.lastAlpha=1;check(!isEmptyBitmap(big));
    Bitmap limit=new Bitmap(2000,2000);check(isEmptyBitmap(limit));rejects(new Bitmap(2001,2000));
    Bitmap gpu=new Bitmap(10,10);gpu.config=Bitmap.Config.HARDWARE;check(isEmptyBitmap(gpu));check(gpu.copied.recycled&&!gpu.recycled);
    gpu.lastAlpha=255;check(!isEmptyBitmap(gpu));check(gpu.copied.recycled);
    gpu.broken=true;rejects(gpu);check(gpu.copied.recycled&&!gpu.recycled);
    gpu.nullCopy=true;rejects(gpu);
    Bitmap bad=new Bitmap(10,10);bad.broken=true;rejects(bad);check(!bad.recycled);
    bad=new Bitmap(10,10);bad.recycle();rejects(bad);
    System.out.println("alpha boundary and cleanup checks passed");
  }
}`);
    const compile = spawnSync("javac", ["--release", "8", "-d", directory, path], { encoding: "utf8", timeout: 10000 });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync("java", ["-cp", directory, "AlphaCheck"], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /alpha boundary and cleanup checks passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

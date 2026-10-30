import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("actual SDK output preserves bytes, budgets, error propagation and bitmap ownership", () => {
  const source = readFileSync(new URL("../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/CaptureOutput.java", import.meta.url), "utf8");
  const directory = mkdtempSync(join(tmpdir(), "sdk-capture-output-"));
  try {
    // Real implementation against deterministic platform substitutes; not an Android codec test.
    writeFileSync(join(directory, "CaptureOutput.java"), source.replace(/^import (?:android\.|org\.json\.).*;\n/gm, ""));
    writeFileSync(join(directory, "OutputCheck.java"), `package com.androiduiinspector.sdk;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.CRC32;

public class OutputCheck {
  static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
  interface Work { void run() throws Exception; }
  static Throwable fails(Work work) {
    try { work.run(); } catch (Throwable error) { return error; }
    throw new AssertionError("expected failure");
  }
  static String hash(byte[] bytes) throws Exception {
    StringBuilder text = new StringBuilder();
    for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) text.append(String.format("%02x", value & 255));
    return text.toString();
  }
  static Bitmap image(byte[] data) { return new Bitmap(data); }
  public static void main(String[] args) throws Exception {
    byte[] pixels = {10, 20, 30, -1};
    AtomicLong encodeMs = new AtomicLong();
    Bitmap png = image(pixels);
    CaptureOutput.VisibleRecord first = CaptureOutput.encodeVisibleLayer(png, "example.View@a", 7, -2, false, encodeMs);
    check(png.recycles == 1 && png.format == Bitmap.CompressFormat.PNG && png.quality == 100, "PNG ownership/format");
    check(Arrays.equals(first.image, pixels) && first.crc == 0 && !first.webp, "PNG record");
    Bitmap webp = image(pixels);
    CaptureOutput.VisibleRecord second = CaptureOutput.encodeVisibleLayer(webp, "example.View@b", 9, 10, true, encodeMs);
    CRC32 crc = new CRC32(); crc.update(pixels);
    check(webp.recycles == 1 && webp.format == Bitmap.CompressFormat.WEBP_LOSSLESS && webp.quality == 0, "WEBP ownership/format");
    check(second.crc == (int) crc.getValue() && second.webp, "WEBP CRC");
    check(encodeMs.get() >= 0, "timing populated");

    for (int fault = 0; fault < 3; fault++) {
      Bitmap bad = image(fault == 2 ? new byte[10_000_001] : pixels);
      bad.success = fault != 0; bad.broken = fault == 1;
      fails(() -> CaptureOutput.encodeVisibleLayer(bad, "example.View@c", 0, 0, false, encodeMs));
      check(bad.recycles == 1, "failed encoder recycles exactly once");
    }

    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    DataOutputStream output = new DataOutputStream(buffer);
    CaptureOutput.GeometryRecords geometry = new CaptureOutput.GeometryRecords();
    CaptureOutput.VisibleRecord withGeometry = new CaptureOutput.VisibleRecord(second.ref, second.x, second.y,
        second.image, second.crc, second.webp, "{\\\"ref\\\":\\\"b\\\"}", 12);
    output.writeLong(123);
    check(CaptureOutput.writeVisibleRecord(output, CompletableFuture.completedFuture(first), geometry) == 1, "PNG write count");
    check(CaptureOutput.writeVisibleRecord(output, CompletableFuture.completedFuture(withGeometry), geometry) == 1, "WEBP write count");
    output.writeByte(2); output.close();
    DataInputStream input = new DataInputStream(new ByteArrayInputStream(buffer.toByteArray()));
    check(input.readLong() == 123, "request header");
    for (CaptureOutput.VisibleRecord expected : new CaptureOutput.VisibleRecord[]{first, second}) {
      check(input.readByte() == 1 && input.readUTF().equals(expected.ref) && input.readByte() == 1, "record tags and order");
      check(input.readInt() == expected.x && input.readInt() == expected.y, "record position");
      byte[] actual = new byte[input.readInt()]; input.readFully(actual);
      check(Arrays.equals(actual, expected.image), "image bytes");
      if (expected.webp) check(input.readInt() == expected.crc, "CRC bytes");
    }
    check(input.readByte() == 2 && input.read() == -1, "terminator and exact wire length");
    check(geometry.finish().equals("[{\\\"ref\\\":\\\"b\\\"}]"), "geometry order");
    geometry.bytes = 3_900_000;
    geometry.add(withGeometry); check(geometry.finish().equals("[{\\\"ref\\\":\\\"b\\\"}]"), "geometry byte cap");
    IOException underlying = new IOException("encoder failure");
    CompletableFuture<CaptureOutput.VisibleRecord> failed = new CompletableFuture<>(); failed.completeExceptionally(underlying);
    check(fails(() -> CaptureOutput.writeVisibleRecord(output, failed)) == underlying, "future exception unwrapped");
    AssertionError fatal = new AssertionError("encoder fatal");
    final CompletableFuture<CaptureOutput.VisibleRecord> fatalFuture = new CompletableFuture<>(); fatalFuture.completeExceptionally(fatal);
    check(fails(() -> CaptureOutput.writeVisibleRecord(output, fatalFuture)) == fatal, "future error unwrapped");
    DataOutputStream broken = new DataOutputStream(new OutputStream() { public void write(int value) throws IOException { throw underlying; } });
    check(fails(() -> CaptureOutput.writeVisibleRecord(broken, CompletableFuture.completedFuture(first))) == underlying, "writer failure preserved");

    HashSet<Bitmap> pending = new HashSet<>(); Bitmap queued = image(pixels), claimed = image(pixels);
    CaptureOutput.registerPendingBitmap(pending, queued); CaptureOutput.registerPendingBitmap(pending, claimed);
    check(CaptureOutput.claimPendingBitmap(pending, claimed), "encoder claims ownership");
    check(!CaptureOutput.claimPendingBitmap(pending, claimed), "one claim only");
    CaptureOutput.recyclePendingBitmaps(pending);
    check(queued.recycles == 1 && claimed.recycles == 0 && pending.isEmpty(), "cancel preserves active encoder bitmap");
    CaptureOutput.recyclePendingBitmaps(pending); check(queued.recycles == 1, "repeat cleanup harmless");

    CaptureFrame.CaptureTiming timing = new CaptureFrame.CaptureTiming();
    AtomicLong geometryNanos = new AtomicLong();
    Bitmap raw = image(pixels);
    CaptureFrame.CapturedFrame frame = new CaptureFrame.CapturedFrame(raw, new JSONObject());
    CaptureOutput.VisibleRecord record = CaptureOutput.encodeFrame(frame, "example.View@d", false, encodeMs, timing, geometryNanos);
    check(record.geometry.equals("{}") && record.geometryBytes == 3 && raw.recycles == 1, "frame geometry serialized once");
    check(geometryNanos.get() > 0 && timing.geometryJson.get() > 0, "worker timing retained");
    for (boolean diagnostic : new boolean[]{false, true}) {
      Bitmap bitmap = image(pixels);
      CaptureFrame.CapturedFrame invalid = new CaptureFrame.CapturedFrame(bitmap, null);
      invalid.immutableGeometry = new ImmutableGeometry(diagnostic, true);
      if (diagnostic) check(CaptureOutput.encodeFrame(invalid, "example.View@e", false, encodeMs, timing, geometryNanos).geometry == null,
          "optional diagnostic cannot reject image");
      else check(fails(() -> CaptureOutput.encodeFrame(invalid, "example.View@e", false, encodeMs, timing, geometryNanos)) instanceof IOException,
          "required geometry failure rejects result");
      check(bitmap.recycles == 1, "geometry failure bitmap already recycled");
    }

    Application app = new Application(new File(args[0]));
    Bitmap standalone = image(pixels);
    check(CaptureOutput.writePng(app, "image.png", standalone, pixels.length).equals(hash(pixels)), "PNG published hash");
    check(Arrays.equals(Files.readAllBytes(new File(app.dir, "image.png").toPath()), pixels), "PNG published bytes");
    check(standalone.recycles == 0 && !new File(app.dir, "image.png.tmp").exists(), "single image recycling stays with caller");
    check(fails(() -> CaptureOutput.writePng(app, "image.png", standalone, pixels.length - 1)) instanceof IllegalStateException, "PNG cap");
    check(Arrays.equals(Files.readAllBytes(new File(app.dir, "image.png").toPath()), pixels), "failed publish preserves earlier file");
    Bitmap bad = image(pixels); bad.success = false;
    fails(() -> CaptureOutput.writePng(app, "bad.png", bad, 100));
    check(!new File(app.dir, "bad.png").exists() && !new File(app.dir, "bad.png.tmp").exists(), "encode failure no publication");
    File target = new File(app.dir, "blocked.png"); target.mkdir(); new File(target, "child").createNewFile();
    fails(() -> CaptureOutput.writePng(app, "blocked.png", standalone, 100));
    check(target.isDirectory() && !new File(app.dir, "blocked.png.tmp").exists(), "rename failure cleanup");

    CaptureOutput publisher = new CaptureOutput("instance"); Bundle reply = new Bundle();
    publisher.writeGeometryFile(app, "1234567890abcdef", "example.Root@f", "[]", reply, timing);
    byte[] json = Files.readAllBytes(new File(app.dir, "inspector-geometry-1234567890abcdef.json").toPath());
    String document = new String(json, StandardCharsets.UTF_8);
    check(document.equals("{\\\"version\\\":1,\\\"nonce\\\":\\\"1234567890abcdef\\\",\\\"rootRef\\\":\\\"example.Root@f\\\",\\\"processInstance\\\":\\\"instance\\\",\\\"records\\\":[]}"), "geometry envelope bytes");
    check(reply.values.get("geometryBytes").equals((long) json.length) && reply.values.get("geometrySha256").equals(hash(json)), "geometry reply");
    fails(() -> publisher.writeGeometryFile(app, "bad", "root", "[]", new Bundle()));
    char[] large = new char[4_000_001]; Arrays.fill(large, ' ');
    fails(() -> publisher.writeGeometryFile(app, "abcdef1234567890", "root", new String(large), new Bundle()));
    check(!new File(app.dir, "inspector-geometry-abcdef1234567890.json").exists(), "geometry cap before publication");
    System.out.println("output protocol, failures, budgets and ownership checks passed");
  }
}
class Application { final File dir; Application(File dir){this.dir=dir;} File getNoBackupFilesDir(){return dir;} }
class Bundle { final Map<String,Object> values=new HashMap<>(); void putLong(String k,long v){values.put(k,v);} void putString(String k,String v){values.put(k,v);} }
class Debug { static long threadCpuTimeNanos(){return System.nanoTime();} }
class SystemClock { static long uptimeMillis(){return System.nanoTime()/1_000_000;} }
class JSONObject {
  final Map<String,Object> values = new LinkedHashMap<>();
  JSONObject put(String key,Object value){values.put(key,value);return this;}
  public String toString(){StringBuilder s=new StringBuilder("{");for(Map.Entry<String,Object> e:values.entrySet()){
    if(s.length()>1)s.append(',');s.append('"').append(e.getKey()).append("\\\":");
    if(e.getValue() instanceof String)s.append('"').append(e.getValue()).append('"');else s.append(e.getValue());
  }return s.append('}').toString();}
}
class Bitmap {
  enum CompressFormat {PNG, WEBP_LOSSLESS} enum Config {ARGB_8888,HARDWARE}
  final byte[] bytes; boolean success=true,broken; int recycles,quality; CompressFormat format;
  Bitmap(byte[] bytes){this.bytes=bytes;} int getWidth(){return 1;} int getHeight(){return 1;}
  Config getConfig(){return Config.ARGB_8888;} Bitmap copy(Config c,boolean mutable){return new Bitmap(bytes);}
  void getPixels(int[] row,int offset,int stride,int x,int y,int w,int h){row[0]=0;}
  boolean compress(CompressFormat f,int q,OutputStream output){format=f;quality=q;if(broken)throw new IllegalStateException("broken");
    try{output.write(bytes);}catch(IOException e){throw new IllegalStateException(e);}return success;}
  void recycle(){recycles++;} boolean isRecycled(){return recycles>0;}
}
class ImmutableGeometry {
  final boolean diagnostic,broken; ImmutableGeometry(boolean d,boolean b){diagnostic=d;broken=b;}
  boolean isDiagnosticOnly(){return diagnostic;} JSONObject json(long start,long end)throws Exception{if(broken)throw new IOException("geometry");return new JSONObject();}
}
class CaptureFrame {
  static class CapturedFrame { final Bitmap bitmap; final int x=1,y=2; final JSONObject geometry; ImmutableGeometry immutableGeometry; final long started=1,ended=2;
    CapturedFrame(Bitmap b,JSONObject j){bitmap=b;geometry=j;} }
  static class CaptureTiming {
    final AtomicLong encodeCpu=new AtomicLong(),geometryUtf8Cpu=new AtomicLong(),geometryUtf8=new AtomicLong(),geometryDiskCpu=new AtomicLong(),
      geometryDisk=new AtomicLong(),geometryJsonCpu=new AtomicLong(),geometryJson=new AtomicLong(),geometryWriteCpu=new AtomicLong();
    void addCpu(AtomicLong counter,long start){counter.addAndGet(Math.max(0,System.nanoTime()-start));}
  }
}
`);
    const compile = spawnSync("javac", ["--release", "8", "-d", directory, join(directory, "CaptureOutput.java"), join(directory, "OutputCheck.java")], { encoding: "utf8", timeout: 20000 });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync("java", ["-cp", directory, "com.androiduiinspector.sdk.OutputCheck", directory], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /output protocol, failures, budgets and ownership checks passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

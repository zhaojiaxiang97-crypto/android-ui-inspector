// Platform substitutes only: the host test compiles unchanged production Java helpers.
export const sdkPipelinePlatform: Record<string, string> = {
  "android/app/Application.java": `package android.app; public class Application { private final java.io.File directory; public Application(java.io.File directory){this.directory=directory;} public java.io.File getNoBackupFilesDir(){return directory;} }`,
  "android/os/Bundle.java": `package android.os; public class Bundle { public final java.util.Map<String,Object> values=new java.util.HashMap<>(); public void putLong(String key,long value){values.put(key,value);} public void putString(String key,String value){values.put(key,value);} }`,
  "android/os/Debug.java": `package android.os; public class Debug { public static long threadCpuTimeNanos(){return System.nanoTime();} }`,
  "android/os/SystemClock.java": `package android.os; public class SystemClock { public static long uptimeMillis(){return System.nanoTime()/1000000;} }`,
  "android/graphics/Bitmap.java": `package android.graphics;
import java.io.*; import java.util.concurrent.atomic.AtomicInteger;
public class Bitmap {
  public enum CompressFormat { PNG,WEBP_LOSSLESS } public enum Config { ARGB_8888,HARDWARE }
  public final byte[] bytes; public final AtomicInteger recycles=new AtomicInteger();
  public volatile CompressFormat format; public volatile int quality;
  public Bitmap(byte[] bytes){this.bytes=bytes;}
  public int getWidth(){return 1;} public int getHeight(){return 1;} public Config getConfig(){return Config.ARGB_8888;}
  public Bitmap copy(Config config,boolean mutable){return new Bitmap(bytes);}
  public void getPixels(int[] row,int offset,int stride,int x,int y,int width,int height){row[offset]=0;}
  public boolean compress(CompressFormat format,int quality,OutputStream output){
    if(isRecycled())throw new AssertionError("compressing recycled bitmap");this.format=format;this.quality=quality;
    try{output.write(bytes);return true;}catch(IOException error){throw new IllegalStateException(error);}
  }
  public void recycle(){if(recycles.incrementAndGet()!=1)throw new AssertionError("bitmap recycled twice");}
  public boolean isRecycled(){return recycles.get()!=0;}
}`,
  "org/json/JSONObject.java": `package org.json; public class JSONObject {
  final java.util.Map<String,Object> values=new java.util.LinkedHashMap<>();
  public JSONObject put(String key,Object value){values.put(key,value);return this;}
  public String toString(){return "{}";}
}`,
  "com/androiduiinspector/sdk/CaptureFrame.java": `package com.androiduiinspector.sdk;
import android.graphics.Bitmap; import java.util.concurrent.atomic.AtomicLong; import org.json.JSONObject;
final class CaptureFrame {
  static final class RefLayer { Bitmap bitmap; RefLayer(Bitmap bitmap){this.bitmap=bitmap;} }
  static final class CapturedFrame { final Bitmap bitmap; final int x=0,y=0; final JSONObject geometry=null; ImmutableGeometry immutableGeometry; final long started=1,ended=2; CapturedFrame(Bitmap bitmap){this.bitmap=bitmap;} }
  static final class ImmutableGeometry { JSONObject json(long start,long end){return new JSONObject();} boolean isDiagnosticOnly(){return false;} }
  static final class CaptureTiming {
    final AtomicLong encodeCpu=new AtomicLong(),geometryUtf8Cpu=new AtomicLong(),geometryUtf8=new AtomicLong(),geometryDiskCpu=new AtomicLong(),geometryDisk=new AtomicLong(),geometryJsonCpu=new AtomicLong(),geometryJson=new AtomicLong(),geometryWriteCpu=new AtomicLong();
    void addCpu(AtomicLong counter,long start){counter.addAndGet(Math.max(0,System.nanoTime()-start));}
  }
}`,
};

export const sdkEntryCompileSupport: Record<string, string> = {
  "org/lsposed/hiddenapibypass/HiddenApiBypass.java": `package org.lsposed.hiddenapibypass;
public class HiddenApiBypass {
  public static java.util.List<java.lang.reflect.Field> getInstanceFields(Class<?> type){return java.util.Arrays.asList(type.getDeclaredFields());}
  public static Object newInstance(Class<?> type,Object... args)throws ReflectiveOperationException{throw new UnsupportedOperationException("unused hidden constructor");}
  public static Object invoke(Class<?> type,Object receiver,String method,Object... args)throws ReflectiveOperationException{throw new UnsupportedOperationException("unused hidden invocation");}
}`,
  "com/androiduiinspector/sdk/R.java": `package com.androiduiinspector.sdk; public class R { public static class id {public static final int inspector_debug_metadata=1,inspector_debug_name=2;} }`,
  "com/androiduiinspector/sdk/BuildConfig.java": `package com.androiduiinspector.sdk; public class BuildConfig {public static final String SDK_SOURCE_SHA256="host-fixture";}`,
};

// Runtime-only Android boundary classes. Product compilation uses the real Android API jar.
export const sdkEntryPlatform: Record<string, string> = {
  ...Object.fromEntries(Object.entries(sdkPipelinePlatform).filter(([path]) => path.startsWith("android/") && path !== "android/os/Bundle.java")),
  "android/os/Bundle.java": `package android.os; public class Bundle {
    public final java.util.Map<String,Object> values=new java.util.HashMap<>();
    public String getString(String key){return (String)values.get(key);} public boolean getBoolean(String key,boolean fallback){return values.containsKey(key)?(Boolean)values.get(key):fallback;}
    public void putLong(String key,long value){values.put(key,value);} public void putString(String key,String value){values.put(key,value);} public void putInt(String key,int value){values.put(key,value);} public void putBoolean(String key,boolean value){values.put(key,value);}
  }`,
  "android/os/Looper.java": `package android.os; public class Looper {private static final Looper MAIN=new Looper();public static Looper getMainLooper(){return MAIN;}public static Looper myLooper(){return MAIN;}}`,
  "android/os/Handler.java": `package android.os; public class Handler {public static boolean hold;public static Runnable deferred;public Handler(Looper looper){} public boolean post(Runnable task){if(hold)deferred=task;else task.run();return true;}public void removeCallbacks(Runnable task){} }`,
  "android/view/View.java": `package android.view; public class View {
    public int mPrivateFlags=0; public Object mOverlay;
    public boolean isAttachedToWindow(){return true;}public boolean isShown(){return true;}public int getWidth(){return 1;}public int getHeight(){return 1;}
    public void getLocationOnScreen(int[] position){position[0]=0;position[1]=0;}public boolean isHardwareAccelerated(){return true;}
  }`,
  "android/view/ViewGroup.java": `package android.view; public class ViewGroup extends View {
    private final View[] children; public ViewGroup(View... children){this.children=children;}public int getChildCount(){return children.length;}public View getChildAt(int index){return children[index];}
  }`,
  "android/view/TextureView.java": `package android.view; public class TextureView extends View {
    public final android.graphics.Bitmap image;public boolean fail;public TextureView(android.graphics.Bitmap image){this.image=image;}
    public android.graphics.Bitmap getBitmap(int width,int height){if(fail)throw new IllegalStateException("selection injected failure");return image;}
  }`,
  "android/view/Window.java": `package android.view; public class Window {private final View root;public Window(View root){this.root=root;}public View getDecorView(){return root;}}`,
  "android/app/Activity.java": `package android.app; public class Activity {private final android.view.Window window;public Activity(android.view.View root){window=new android.view.Window(root);}public android.view.Window getWindow(){return window;}}`,
};

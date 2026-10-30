package com.artemis.helper;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ColorSpace;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;

/** Standalone app_process harness. Never included in service generation or HTTP routing. */
public final class InspectorPngAndroidBenchmark {
    private static byte[] nativePng(Bitmap bitmap) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, new InspectorPngCodec.LimitedOutput(out)))
            throw new IllegalStateException("native PNG failed");
        return out.toByteArray();
    }
    private static Bitmap decode(byte[] png) {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inScaled = false; options.inPremultiplied = false;
        Bitmap result = BitmapFactory.decodeByteArray(png, 0, png.length, options);
        if(result == null)throw new IllegalStateException("PNG decode failed");
        return result;
    }
    private static void sameDecodedPixels(byte[] nativeBytes, byte[] candidateBytes, boolean fallback) throws Exception {
        // Fallback must retain native color profiles, bit depth and transparent data byte-for-byte.
        if(fallback && !Arrays.equals(nativeBytes,candidateBytes))throw new AssertionError("native fallback PNG changed");
        Bitmap expected=null,actual=null;
        try {
            expected=decode(nativeBytes);actual=decode(candidateBytes);
            if(expected.getWidth()!=actual.getWidth()||expected.getHeight()!=actual.getHeight())throw new AssertionError("size changed");
            if(Build.VERSION.SDK_INT>=26 && !expected.getColorSpace().equals(actual.getColorSpace()))throw new AssertionError("color space changed");
            int[] first=new int[expected.getWidth()],second=new int[actual.getWidth()];
            for(int y=0;y<expected.getHeight();y++){
                expected.getPixels(first,0,first.length,0,y,first.length,1);
                actual.getPixels(second,0,second.length,0,y,second.length,1);
                if(!Arrays.equals(first,second))throw new AssertionError("decoded RGBA changed on row "+y);
            }
        } finally {if(expected!=null)expected.recycle();if(actual!=null)actual.recycle();}
    }
    private static void measure(String label, Bitmap bitmap, boolean fallback, int repetitions) throws Exception {
        try {
            InspectorPngCodec.checkDimensions(bitmap.getWidth(),bitmap.getHeight());
            sameDecodedPixels(nativePng(bitmap),InspectorPngEncoder.encode(bitmap),fallback);
            JSONArray nativeMs=new JSONArray(),candidateMs=new JSONArray();int nativeBytes=0,candidateBytes=0;
            for(int i=0;i<repetitions;i++){
                byte[] normal=null,candidate=null;double normalTime=0,candidateTime=0;
                // Alternate order on the same immutable test image, never compare different screen frames.
                for(int j=0;j<2;j++){
                    boolean fast=((i+j)&1)==0;long start=System.nanoTime();
                    byte[] bytes=fast?InspectorPngEncoder.encode(bitmap):nativePng(bitmap);
                    double elapsed=(System.nanoTime()-start)/1e6;
                    if(fast){candidate=bytes;candidateTime=elapsed;}else{normal=bytes;normalTime=elapsed;}
                }
                sameDecodedPixels(normal,candidate,fallback);
                nativeMs.put(normalTime);candidateMs.put(candidateTime);nativeBytes=normal.length;candidateBytes=candidate.length;
            }
            JSONObject record=new JSONObject().put("fixture",label).put("width",bitmap.getWidth()).put("height",bitmap.getHeight())
                .put("config",String.valueOf(bitmap.getConfig())).put("colorSpace",String.valueOf(bitmap.getColorSpace()))
                .put("expectedNativeFallback",fallback).put("samples",repetitions).put("nativeMs",nativeMs).put("candidateMs",candidateMs)
                .put("nativeBytes",nativeBytes).put("candidateBytes",candidateBytes).put("decodedPixelsEqual",true);
            System.out.println(record.toString());
        } finally { bitmap.recycle(); }
    }
    private static Bitmap pixels(boolean alpha, boolean premultiplied) {
        int width=alpha?257:1080,height=alpha?65:2400;
        Bitmap bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);
        bitmap.setPremultiplied(premultiplied);
        int[] row=new int[width];
        for(int y=0;y<height;y++){
            for(int x=0;x<width;x++)row[x]=((alpha?(x+y)&255:255)<<24)|((x&255)<<16)|((y&255)<<8)|((x^y)&255);
            bitmap.setPixels(row,0,width,0,y,width,1);
        }
        return bitmap;
    }
    public static void main(String[] args) throws Exception {
        if(Build.VERSION.SDK_INT<26)throw new IllegalStateException("Android API 26+ required");
        if(args.length>2)throw new IllegalArgumentException("[PNG_PATH|-] [REPETITIONS 1..10]");
        int repetitions=args.length>1?Integer.parseInt(args[1]):3;
        if(repetitions<1||repetitions>10)throw new IllegalArgumentException("repetitions must be 1..10");
        measure("opaque-srgb",pixels(false,true),false,repetitions);
        measure("premultiplied-alpha-srgb",pixels(true,true),true,repetitions);
        measure("straight-alpha-srgb",pixels(true,false),true,repetitions);
        Bitmap p3=Bitmap.createBitmap(127,63,Bitmap.Config.ARGB_8888,true,ColorSpace.get(ColorSpace.Named.DISPLAY_P3));
        p3.eraseColor(0xffe05020);measure("display-p3",p3,true,repetitions);
        Bitmap hdr=Bitmap.createBitmap(127,63,Bitmap.Config.RGBA_F16,true,ColorSpace.get(ColorSpace.Named.EXTENDED_SRGB));
        hdr.eraseColor(0x80905f20);measure("rgba-f16",hdr,true,repetitions);
        if(args.length>0 && !args[0].equals("-")){
            BitmapFactory.Options options=new BitmapFactory.Options();options.inScaled=false;
            Bitmap saved=BitmapFactory.decodeFile(args[0],options);
            if(saved==null)throw new IllegalArgumentException("saved PNG could not be decoded");
            boolean fallback=saved.getConfig()!=Bitmap.Config.ARGB_8888||!saved.getColorSpace().isSrgb();
            if(!fallback){int[] row=new int[saved.getWidth()];for(int y=0;y<saved.getHeight()&&!fallback;y++){
                saved.getPixels(row,0,row.length,0,y,row.length,1);for(int c:row)if((c>>>24)!=255){fallback=true;break;}
            }}
            measure("saved-png",saved,fallback,repetitions);
        }
    }
}

package com.androiduiinspector.sdk;
import android.app.*;
import android.graphics.Bitmap;
import android.os.*;
import android.view.*;
import java.io.File;

/** Full production captureRefs entry; only Android platform behavior is substituted. */
public final class CaptureRefsEntryCheck {
    static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
    static Bitmap image(){return new Bitmap(new byte[]{1,2,3,4});}
    static HierarchyCapture capture(View root){return new HierarchyCapture("host",()->new Activity(root),new ThreadLocal<>(),nonce->{});}
    static void noFile(File directory){check(!new File(directory,"inspector-ref-layers.bin").exists()&&!new File(directory,"inspector-ref-layers.bin.tmp").exists(),"failed entry may not publish");}
    public static void main(String[] args)throws Exception{
        File directory=new File(args[0]);Application app=new Application(directory);
        Bitmap first=image();TextureView one=new TextureView(first),two=new TextureView(image());two.fail=true;ViewGroup root=new ViewGroup(one,two);
        Bundle rejected=capture(root).captureRefs(app,HierarchyTree.ref(one)+";"+HierarchyTree.ref(two),null);
        check(rejected.getString("error").contains("selection injected failure"),"selection failure is returned");
        check(first.recycles.get()==1,"partial selection bitmap reclaimed by actual entry");check(two.image.recycles.get()==0,"failed source never transferred its bitmap");noFile(directory);
        System.out.println("PASS entry-partial-selection-cleanup created=1 recycled=1");
        Bitmap late=image();TextureView delayed=new TextureView(late);Handler.hold=true;
        Bundle timeout=capture(new ViewGroup(delayed)).captureRefs(app,HierarchyTree.ref(delayed),null);
        check(timeout.getString("error").contains("selection timed out"),"actual wait budget retained");
        check(late.recycles.get()==0&&Handler.deferred!=null,"UI not completed when request times out");
        Handler.hold=false;Handler.deferred.run();
        check(late.recycles.get()==1,"late UI result reclaimed by closed actual entry");noFile(directory);
        check(timeout.getString("result")==null,"late UI completion does not mutate returned failure");
        System.out.println("PASS entry-late-selection-cleanup created=1 recycled=1 published=false");
    }
}

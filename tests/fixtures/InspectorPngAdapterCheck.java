import com.artemis.helper.InspectorPngEncoder;
import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.os.Build;
import java.awt.image.BufferedImage;
import java.io.*;
import java.util.Arrays;
import javax.imageio.ImageIO;

public final class InspectorPngAdapterCheck {
    interface Attempt {void run()throws Exception;}
    static void rejects(Attempt attempt)throws Exception{
        try{attempt.run();}catch(IOException|IllegalStateException expected){return;}
        throw new AssertionError("expected rejection");
    }
    static void fallback(Bitmap bitmap)throws Exception{
        byte[] result=InspectorPngEncoder.encode(bitmap);
        if(!Arrays.equals(result,Bitmap.NATIVE_BYTES)||bitmap.nativeCalls!=1||bitmap.recycleCalls!=0)
            throw new AssertionError("native fallback modified output, retried or recycled caller bitmap");
    }
    public static void main(String[] args)throws Exception{
        Bitmap opaque=new Bitmap();BufferedImage decoded=ImageIO.read(new ByteArrayInputStream(InspectorPngEncoder.encode(opaque)));
        for(int y=0;y<2;y++)for(int x=0;x<3;x++)if(decoded.getRGB(x,y)!=opaque.colors[y*3+x])throw new AssertionError("opaque pixel changed");
        if(opaque.nativeCalls!=0||opaque.readCalls!=2||opaque.recycleCalls!=0)throw new AssertionError("opaque routing wrong");
        Bitmap alpha=new Bitmap();alpha.colors[5]=0x80102030;fallback(alpha);
        if(alpha.readCalls!=2)throw new AssertionError("test must hit fallback after partial PNG output");
        Bitmap transparent=new Bitmap();transparent.colors[0]=0x00123456;fallback(transparent);
        for(Bitmap.Config config:new Bitmap.Config[]{Bitmap.Config.RGBA_F16,Bitmap.Config.HARDWARE,Bitmap.Config.RGB_565}){
            Bitmap b=new Bitmap();b.config=config;fallback(b);if(b.readCalls!=0)throw new AssertionError("unsupported config read");
        }
        Bitmap wide=new Bitmap();wide.space=new ColorSpace(false);fallback(wide);if(wide.readCalls!=0)throw new AssertionError("wide gamut converted");
        Bitmap unknown=new Bitmap();unknown.space=null;fallback(unknown);
        Build.VERSION.SDK_INT=24;fallback(new Bitmap());Build.VERSION.SDK_INT=34;
        rejects(()->InspectorPngEncoder.encode(null));
        Bitmap recycled=new Bitmap();recycled.recycled=true;rejects(()->InspectorPngEncoder.encode(recycled));
        Bitmap invalid=new Bitmap();invalid.width=16385;rejects(()->InspectorPngEncoder.encode(invalid));
        if(invalid.nativeCalls!=0||invalid.readCalls!=0)throw new AssertionError("invalid size accessed pixels");
        Bitmap failed=new Bitmap();failed.space=null;failed.compressFailure=true;rejects(()->InspectorPngEncoder.encode(failed));
        Bitmap huge=new Bitmap();huge.space=null;huge.oversize=true;rejects(()->InspectorPngEncoder.encode(huge));
        Bitmap unavailable=new Bitmap();unavailable.readFailure=true;rejects(()->InspectorPngEncoder.encode(unavailable));
        if(unavailable.nativeCalls!=0)throw new AssertionError("read error hidden by fallback");
        Thread.currentThread().interrupt();
        try{rejects(()->InspectorPngEncoder.encode(new Bitmap()));}finally{if(!Thread.interrupted())throw new AssertionError("interrupt cleared");}
        System.out.println("Android adapter routing, alpha fallback, size limits, errors and ownership passed");
    }
}

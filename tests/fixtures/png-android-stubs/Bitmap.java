package android.graphics;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;

/** Routing/error fake only. Actual Android color/alpha parity uses the standalone DEX harness. */
public class Bitmap {
    public enum Config { ARGB_8888, RGBA_F16, HARDWARE, RGB_565 }
    public enum CompressFormat { PNG }
    public static final byte[] NATIVE_BYTES = {9,8,7,6,5};
    public int width=3,height=2,nativeCalls,readCalls,recycleCalls;
    public int[] colors={0xff123456,0xffabcdef,0xff998877,0xff102030,0xff102040,0xff102050};
    public Config config=Config.ARGB_8888;
    public ColorSpace space=new ColorSpace(true);
    public boolean recycled,compressFailure,oversize,readFailure;
    public int getWidth(){return width;}
    public int getHeight(){return height;}
    public boolean isRecycled(){return recycled;}
    public Config getConfig(){return config;}
    public ColorSpace getColorSpace(){return space;}
    public void recycle(){recycleCalls++;}
    public void getPixels(int[] pixels,int offset,int stride,int x,int y,int width,int height){
        readCalls++;
        if(readFailure)throw new IllegalStateException("bitmap became unavailable");
        System.arraycopy(colors,y*this.width,pixels,offset,width);
    }
    public boolean compress(CompressFormat format,int quality,OutputStream out){
        nativeCalls++;
        if(format!=CompressFormat.PNG)throw new AssertionError("lossy format");
        if(compressFailure)return false;
        try{
            if(oversize){byte[] block=new byte[65536];for(int i=0;i<257;i++)out.write(block);}
            else out.write(NATIVE_BYTES);
            return true;
        }catch(IOException failure){return false;}
    }
}

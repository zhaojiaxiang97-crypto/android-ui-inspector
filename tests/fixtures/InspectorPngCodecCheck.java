import com.artemis.helper.InspectorPngCodec;
import java.awt.image.BufferedImage;
import java.io.*;
import java.util.*;
import javax.imageio.ImageIO;

/** JVM-only fixture: ImageIO is an independent decoder, never part of the Android artifact. */
public final class InspectorPngCodecCheck {
    interface Attempt { void run() throws Exception; }
    static void fails(Attempt attempt) throws Exception {
        try { attempt.run(); } catch (IOException | IllegalArgumentException expected) { return; }
        throw new AssertionError("expected rejection");
    }
    static byte[] encode(BufferedImage image) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        InspectorPngCodec.encode(image.getWidth(), image.getHeight(),
            (y, row) -> image.getRGB(0, y, image.getWidth(), 1, row, 0, image.getWidth()), out);
        return out.toByteArray();
    }
    static void equal(BufferedImage expected, byte[] png) throws Exception {
        BufferedImage decoded = ImageIO.read(new ByteArrayInputStream(png));
        if (decoded == null || decoded.getWidth() != expected.getWidth() || decoded.getHeight() != expected.getHeight())
            throw new AssertionError("dimensions changed");
        for (int y = 0; y < expected.getHeight(); y++) for (int x = 0; x < expected.getWidth(); x++)
            if (decoded.getRGB(x,y) != expected.getRGB(x,y)) throw new AssertionError("pixel/alpha changed at " + x + "," + y);
    }
    static BufferedImage pattern(int width, int height, boolean noise) {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        Random random = new Random(17031);
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
            int argb = noise ? random.nextInt() : (((x + y) & 255) << 24) | ((x & 255) << 16) | ((y & 255) << 8) | (x ^ y) & 255;
            image.setRGB(x, y, argb);
        }
        return image;
    }
    static void selfTest() throws Exception {
        for (int[] size : new int[][]{{1,1},{1,256},{256,1},{257,127},{513,73}}) {
            BufferedImage image = pattern(size[0],size[1],true); equal(image,encode(image));
            image = pattern(size[0],size[1],false); equal(image,encode(image));
        }
        for (int[] size : new int[][]{{0,1},{1,-1},{16385,1},{4097,4096},{Integer.MAX_VALUE,Integer.MAX_VALUE}})
            fails(() -> InspectorPngCodec.encode(size[0],size[1],(y,row)-> {throw new AssertionError("read before validation");},new ByteArrayOutputStream()));
        final int[] reads = {0};
        fails(() -> InspectorPngCodec.encode(1,100,(y,row)-> {reads[0]++; throw new IOException("reader failure");},new ByteArrayOutputStream()));
        if(reads[0] != 1)throw new AssertionError("continued after row failure");
        fails(() -> InspectorPngCodec.encode(1,1,(y,row)-> {},new OutputStream(){public void write(int v)throws IOException{throw new IOException("sink failure");}}));
        final long[] written={0};
        OutputStream sink = new OutputStream(){public void write(int v){written[0]++;}public void write(byte[] b,int o,int n){written[0]+=n;}};
        InspectorPngCodec.LimitedOutput limit=new InspectorPngCodec.LimitedOutput(sink);
        byte[] block=new byte[65536];
        for(int n=0;n<InspectorPngCodec.MAX_BYTES/block.length;n++)limit.write(block);
        fails(()->limit.write(0));
        if(written[0]!=InspectorPngCodec.MAX_BYTES)throw new AssertionError("limit wrote excess bytes");
        Thread.currentThread().interrupt();
        try { fails(() -> InspectorPngCodec.encode(1,1,(y,row)-> {throw new AssertionError("read after cancellation");},new ByteArrayOutputStream())); }
        finally { if(!Thread.interrupted())throw new AssertionError("interrupt cleared"); }
        // A failed write must not poison subsequent independent Deflaters.
        equal(pattern(31,17,true),encode(pattern(31,17,true)));
        System.out.println("PNG pixels, alpha, dimensions, limits, cancellation and errors passed");
    }
    static void benchmark(String name, BufferedImage image) throws Exception {
        equal(image,encode(image));
        long[] fast=new long[5], nativeTimes=new long[5];int fastBytes=0,nativeBytes=0;
        for(int i=-1;i<5;i++) {
            long start=System.nanoTime();byte[] png=encode(image);long elapsed=System.nanoTime()-start;
            ByteArrayOutputStream baseline=new ByteArrayOutputStream();long normalStart=System.nanoTime();
            if(!ImageIO.write(image,"png",baseline))throw new AssertionError("no PNG writer");
            long normalElapsed=System.nanoTime()-normalStart;
            if(i>=0){fast[i]=elapsed;nativeTimes[i]=normalElapsed;fastBytes=png.length;nativeBytes=baseline.size();}
        }
        Arrays.sort(fast);Arrays.sort(nativeTimes);
        System.out.printf(Locale.ROOT,"{\"fixture\":\"%s\",\"width\":%d,\"height\":%d,\"samples\":5,\"fastMedianMs\":%.3f,\"imageIoMedianMs\":%.3f,\"fastBytes\":%d,\"imageIoBytes\":%d,\"pixelsEqual\":true}%n",
            name,image.getWidth(),image.getHeight(),fast[2]/1e6,nativeTimes[2]/1e6,fastBytes,nativeBytes);
    }
    public static void main(String[] args) throws Exception {
        if(args.length==1 && args[0].equals("self-test"))selfTest();
        else if(args.length==5 && args[0].equals("encode-argb")){
            int width=Integer.parseInt(args[2]),height=Integer.parseInt(args[3]);
            InspectorPngCodec.checkDimensions(width,height);
            if(new File(args[1]).length()!=(long)width*height*4)throw new IOException("raw length mismatch");
            try(DataInputStream raw=new DataInputStream(new FileInputStream(args[1]));OutputStream out=new FileOutputStream(args[4])){
                InspectorPngCodec.encode(width,height,(y,row)->{for(int x=0;x<row.length;x++)row[x]=raw.readInt();},out);
            }
        } else if(args.length>=1 && args[0].equals("benchmark")) {
            benchmark("synthetic-rgba",pattern(1080,2400,false));benchmark("synthetic-noise-rgba",pattern(1080,2400,true));
            for(int i=1;i<args.length;i++){File file=new File(args[i]);BufferedImage image=ImageIO.read(file);if(image==null)throw new IOException("invalid PNG");benchmark(file.getName(),image);}
        } else throw new IllegalArgumentException("self-test | encode-argb INPUT WIDTH HEIGHT OUTPUT | benchmark [PNG...]");
    }
}

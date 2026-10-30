package com.androiduiinspector.sdk;

import android.graphics.Bitmap;
import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Runs the unchanged production queue/output/selection helpers with deterministic platform boundaries. */
public final class CapturePipelineCheck {
    interface Work { void run() throws Exception; }
    static void check(boolean ok, String reason) { if (!ok) throw new AssertionError(reason); }
    static Throwable fails(Work work) { try { work.run(); } catch (Throwable error) { return error; } throw new AssertionError("expected failure"); }
    static void await(CountDownLatch latch, String reason) throws Exception { check(latch.await(3, TimeUnit.SECONDS), reason); }
    static void unblockable(CountDownLatch latch) { boolean interrupted=false; for (;;) { try { latch.await(); break; } catch (InterruptedException error) { interrupted=true; } } if(interrupted)Thread.currentThread().interrupt(); }
    static Bitmap image(int id) { return new Bitmap(new byte[]{(byte)id, 0, -1, 1}); }
    static CaptureOutput.VisibleRecord encode(Bitmap bitmap, int id) {
        CaptureOutput.VisibleRecord raw=CaptureOutput.encodeVisibleLayer(bitmap,"Example@"+Integer.toHexString(id),id,-id,id%2==1,new AtomicLong());
        return new CaptureOutput.VisibleRecord(raw.ref,raw.x,raw.y,raw.image,raw.crc,raw.webp,"{\"id\":"+id+"}",10);
    }
    static File file(File directory, String name) { return new File(directory,name); }
    static void recycled(Bitmap bitmap, int count, String reason) { check(bitmap.recycles.get()==count,reason+" actual="+bitmap.recycles.get()); }
    static String sha(byte[] bytes) throws Exception { StringBuilder text=new StringBuilder();for(byte value:MessageDigest.getInstance("SHA-256").digest(bytes))text.append(String.format("%02x",value&255));return text.toString(); }
    static class ManualExecutor extends AbstractExecutorService {
        final List<Runnable> jobs=new ArrayList<>(); boolean shutdown,reject;
        public void execute(Runnable job) { if(shutdown||reject)throw new RejectedExecutionException("injected rejection");jobs.add(job); }
        public void shutdown(){shutdown=true;}
        public List<Runnable> shutdownNow(){shutdown=true;return new ArrayList<>(jobs);}
        public boolean isShutdown(){return shutdown;}
        public boolean isTerminated(){return shutdown;}
        public boolean awaitTermination(long time,TimeUnit unit){return shutdown;}
        void run(int index){jobs.get(index).run();}
    }
    static void orderedOutputAndBounds(File directory) throws Exception {
        File target=file(directory,"ordered.bin"),pending=file(directory,"ordered.bin.tmp");
        CaptureOutput.GeometryRecords geometry=new CaptureOutput.GeometryRecords();
        CapturePipeline pipeline=new CapturePipeline(target,pending,"fedcba9876543210",geometry);
        CountDownLatch firstGate=new CountDownLatch(1),secondGate=new CountDownLatch(1),started=new CountDownLatch(2),laterDone=new CountDownLatch(2);
        AtomicInteger active=new AtomicInteger(),peak=new AtomicInteger();
        List<Integer> completion=Collections.synchronizedList(new ArrayList<>()); List<Bitmap> images=new ArrayList<>();
        Thread fifth=null; CountDownLatch fifthEntered=new CountDownLatch(1),fifthReturned=new CountDownLatch(1); AtomicReference<Throwable> failure=new AtomicReference<>();
        try {
            for(int index=0;index<4;index++) {
                final int id=index; Bitmap bitmap=image(id);images.add(bitmap);
                pipeline.submit(bitmap,()->{
                    int concurrency=active.incrementAndGet();peak.accumulateAndGet(concurrency,Math::max);
                    try { if(id<2){started.countDown();unblockable(id==0?firstGate:secondGate);} CaptureOutput.VisibleRecord result=encode(bitmap,id);completion.add(id);if(id>=2)laterDone.countDown();return result; }
                    finally {active.decrementAndGet();}
                });
            }
            await(started,"two encoder workers start"); check(peak.get()==2,"default encoder count must remain two");
            Bitmap fifthImage=image(4);images.add(fifthImage);
            fifth=new Thread(()->{fifthEntered.countDown();try{pipeline.submit(fifthImage,()->encode(fifthImage,4));}catch(Throwable error){failure.set(error);}finally{fifthReturned.countDown();}},"test-producer");fifth.start();
            await(fifthEntered,"fifth submission entered");
            check(!fifthReturned.await(80,TimeUnit.MILLISECONDS),"depth four must backpressure the fifth submission");
            secondGate.countDown();await(laterDone,"later encodes finish before first");
            check(!fifthReturned.await(80,TimeUnit.MILLISECONDS),"completed later results do not bypass ordered head");
            check(completion.equals(Arrays.asList(1,2,3)),"deliberate out-of-order encoder completion");
            firstGate.countDown();await(fifthReturned,"head releases queue capacity");check(failure.get()==null,"fifth submission succeeds");
            pipeline.finish();check(pipeline.count()==5,"one write per input");check(!target.exists(),"finish alone does not publish");
            byte[] wire=Files.readAllBytes(pending.toPath());
            try(DataInputStream input=new DataInputStream(new ByteArrayInputStream(wire))){
                check(input.readLong()==Long.parseUnsignedLong("fedcba9876543210",16),"unsigned nonce survives exact header");
                for(int id=0;id<5;id++){
                    check(input.readByte()==1&&input.readUTF().equals("Example@"+id)&&input.readByte()==1,"serialized request order");
                    check(input.readInt()==id&&input.readInt()==-id,"coordinates remain attached to record");
                    byte[] bytes=new byte[input.readInt()];input.readFully(bytes);check(Arrays.equals(bytes,images.get(id).bytes),"correct image payload");
                    if(id%2==1){java.util.zip.CRC32 crc=new java.util.zip.CRC32();crc.update(bytes);check(input.readInt()==(int)crc.getValue(),"webp CRC");}
                }
                check(input.readByte()==2&&input.read()==-1,"one terminator, no late extra records");
            }
            check(geometry.finish().equals("[{\"id\":0},{\"id\":1},{\"id\":2},{\"id\":3},{\"id\":4}]"),"geometry follows file order");
            pipeline.publish("injected publication message");check(!pending.exists(),"rename consumes pending file");
            check(pipeline.bytes()==wire.length&&pipeline.sha256().equals(sha(wire)),"reported byte count and digest describe exact published bytes");
            check(Arrays.equals(Files.readAllBytes(target.toPath()),wire),"publish is exact rename");
            for(Bitmap bitmap:images)recycled(bitmap,1,"successful bitmap reclaimed once");check(peak.get()==2,"bounded concurrency throughout");
        } finally {firstGate.countDown();secondGate.countDown();pipeline.close();if(fifth!=null)fifth.join(3000);}
        check(target.exists(),"normal close keeps published file");System.out.println("PASS ordered-output-and-bounds");
    }
    static void cancelAndLateOwnership(File directory) throws Exception {
        ManualExecutor executor=new ManualExecutor();File target=file(directory,"cancel.bin"),pending=file(directory,"cancel.bin.tmp");
        CapturePipeline pipeline=new CapturePipeline(target,pending,null,null,executor);
        CountDownLatch running=new CountDownLatch(2),release=new CountDownLatch(1);AtomicInteger calls=new AtomicInteger();Bitmap[] images={image(0),image(1),image(2),image(3)};
        for(int i=0;i<4;i++){final int id=i;pipeline.submit(images[i],()->{calls.incrementAndGet();running.countDown();unblockable(release);return encode(images[id],id);});}
        Thread first=new Thread(()->executor.run(0)),second=new Thread(()->executor.run(1));first.start();second.start();
        try {
            await(running,"claimed encoders running");pipeline.close();pipeline.close();
            recycled(images[0],0,"close must not recycle active native encoder input");recycled(images[1],0,"second active input retained");
            recycled(images[2],1,"never-started input reclaimed");recycled(images[3],1,"second queued input reclaimed");
            executor.run(2);executor.run(3);check(calls.get()==2,"stale queued runnable never calls encoder");
            check(!target.exists()&&!pending.exists(),"cancel has no visible or pending output");
            release.countDown();first.join(3000);second.join(3000);check(!first.isAlive()&&!second.isAlive(),"late workers settle");
            for(Bitmap bitmap:images)recycled(bitmap,1,"late completion still exactly once");
            check(!target.exists()&&!pending.exists(),"late completion cannot republish");
            Bitmap rejected=image(9);fails(()->pipeline.submit(rejected,()->encode(rejected,9)));recycled(rejected,1,"closed submit still consumes transferred ownership");
        } finally {release.countDown();pipeline.close();first.join(3000);second.join(3000);}
        System.out.println("PASS cancel-and-late-ownership");
    }
    static void failureAndRejectedSubmit(File directory) throws Exception {
        ManualExecutor rejected=new ManualExecutor();rejected.reject=true;
        try(CapturePipeline pipeline=new CapturePipeline(file(directory,"reject.bin"),file(directory,"reject.tmp"),null,null,rejected)){
            Bitmap bitmap=image(0);check(fails(()->pipeline.submit(bitmap,()->encode(bitmap,0))) instanceof RejectedExecutionException,"executor rejection preserved");recycled(bitmap,1,"rejected submission owns cleanup");
        }
        ManualExecutor executor=new ManualExecutor();IOException reason=new IOException("encoder failed");Bitmap[] images={image(0),image(1),image(2),image(3),image(4)};
        try(CapturePipeline pipeline=new CapturePipeline(file(directory,"failure.bin"),file(directory,"failure.tmp"),null,null,executor)){
            pipeline.submit(images[0],()->{try{throw reason;}finally{images[0].recycle();}});
            for(int i=1;i<4;i++){final int id=i;pipeline.submit(images[i],()->encode(images[id],id));}
            executor.run(0);
            check(fails(()->pipeline.submit(images[4],()->encode(images[4],4)))==reason,"backpressure failure retains original exception identity");
            recycled(images[4],1,"new bitmap reclaimed when previous head fails before enqueue");
            check(pipeline.count()==0,"failed encoder is not a completed output");
        }
        for(Bitmap bitmap:images)recycled(bitmap,1,"failed queue reclaims every owned input");
        for(int i=1;i<4;i++)executor.run(i);
        check(!file(directory,"failure.bin").exists()&&!file(directory,"failure.tmp").exists(),"failed queue output discarded");
        ManualExecutor fatalExecutor=new ManualExecutor();AssertionError fatal=new AssertionError("fatal encode");Bitmap bitmap=image(7);
        try(CapturePipeline pipeline=new CapturePipeline(file(directory,"fatal.bin"),file(directory,"fatal.tmp"),null,null,fatalExecutor)){
            pipeline.submit(bitmap,()->{try{throw fatal;}finally{bitmap.recycle();}});fatalExecutor.run(0);
            check(fails(pipeline::finish)==fatal,"Error preserved across future boundary");
        }
        recycled(bitmap,1,"fatal encoder input reclaimed");
        ManualExecutor completedExecutor=new ManualExecutor();Bitmap success=image(5),broken=image(6);
        try(CapturePipeline pipeline=new CapturePipeline(file(directory,"partial.bin"),file(directory,"partial.tmp"),null,null,completedExecutor)){
            pipeline.submit(success,()->encode(success,5));pipeline.submit(broken,()->{try{throw reason;}finally{broken.recycle();}});
            completedExecutor.run(1);completedExecutor.run(0);check(fails(pipeline::finish)==reason,"finish failure retains cause");
            check(pipeline.count()==1,"failure count includes only already serialized records");
        }
        check(!file(directory,"partial.bin").exists()&&!file(directory,"partial.tmp").exists(),"partial completed records are not published");
        RuntimeException shutdownFailure=new IllegalStateException("shutdown injected failure");
        ManualExecutor unsafe=new ManualExecutor(){public List<Runnable> shutdownNow(){throw shutdownFailure;}};
        CapturePipeline cleanup=new CapturePipeline(file(directory,"shutdown.bin"),file(directory,"shutdown.tmp"),null,null,unsafe);Bitmap orphan=image(8);
        cleanup.submit(orphan,()->encode(orphan,8));check(fails(cleanup::close)==shutdownFailure,"shutdown failure is visible");
        recycled(orphan,1,"shutdown failure still reclaims queued bitmap");check(!file(directory,"shutdown.tmp").exists(),"shutdown failure still closes pending output");
        cleanup.close();System.out.println("PASS failure-and-rejected-submit");
    }
    static void writerAndPublishFailures(File directory) throws Exception {
        File target=file(directory,"atomic.bin"),pending=file(directory,"atomic.tmp");Files.write(target.toPath(),new byte[]{42});
        try(CapturePipeline pipeline=new CapturePipeline(target,pending,null,null)){
            Bitmap bitmap=image(0);pipeline.submit(bitmap,()->encode(bitmap,0));pipeline.finish();
            check(Arrays.equals(Files.readAllBytes(target.toPath()),new byte[]{42}),"unpublished completed output cannot replace prior target");
            // Simulates the caller's root verification failing before publish.
        }
        check(Arrays.equals(Files.readAllBytes(target.toPath()),new byte[]{42})&&!pending.exists(),"abandoning publication preserves prior target and removes temp");
        File blocked=file(directory,"blocked.bin");check(blocked.mkdir(),"make blocked target");Files.write(new File(blocked,"child").toPath(),new byte[]{1});
        try(CapturePipeline pipeline=new CapturePipeline(blocked,file(directory,"blocked.tmp"),null,null)){
            pipeline.finish();Throwable failure=fails(()->pipeline.publish("rename failed sentinel"));check(failure.getMessage().contains("rename failed sentinel"),"publication message preserved");
        }
        check(blocked.isDirectory()&&!file(directory,"blocked.tmp").exists(),"failed rename leaves no pending file");
        try(CapturePipeline pipeline=new CapturePipeline(file(directory,"budget.bin"),file(directory,"budget.tmp"),null,null)){
            pipeline.finish();try(RandomAccessFile grow=new RandomAccessFile(file(directory,"budget.tmp"),"rw")){grow.setLength(64_000_001);}
            fails(()->pipeline.publish("budget failure"));
        }
        check(!file(directory,"budget.bin").exists()&&!file(directory,"budget.tmp").exists(),"over-budget pending file never published");
        ManualExecutor executor=new ManualExecutor();Bitmap bitmap=image(3);
        try(CapturePipeline pipeline=new CapturePipeline(file(directory,"write.bin"),file(directory,"write.tmp"),null,null,executor)){
            pipeline.submit(bitmap,()->{CaptureOutput.VisibleRecord raw=encode(bitmap,3);char[] longRef=new char[70000];Arrays.fill(longRef,'x');return new CaptureOutput.VisibleRecord(new String(longRef),0,0,raw.image,raw.crc,raw.webp);});executor.run(0);
            check(fails(pipeline::finish) instanceof UTFDataFormatException,"writer failure remains visible");
        }
        recycled(bitmap,1,"writer failure does not retake encoder ownership");check(!file(directory,"write.bin").exists()&&!file(directory,"write.tmp").exists(),"writer failure unpublishes partial stream");
        System.out.println("PASS writer-and-publish-failures");
    }
    static void layerFileLifecycle(File directory) throws Exception {
        File target=file(directory,"lifecycle.bin"),pending=file(directory,"lifecycle.tmp");
        CaptureOutput.LayerFile output=new CaptureOutput.LayerFile(target,pending,"0000000000000001");
        check(fails(()->output.publish("premature")) instanceof IllegalStateException,"incomplete output cannot publish");
        check(!target.exists(),"premature publish creates no final output");
        output.finish();output.finish();output.publish("failed");output.publish("failed");
        byte[] wire=Files.readAllBytes(target.toPath());check(wire.length==9&&wire[8]==2,"finish and publish are idempotent");
        check(output.sha256().equals(sha(wire))&&output.sha256().equals(sha(wire)),"digest is stable across repeat reads");
        output.close();Files.write(pending.toPath(),new byte[]{7});output.close();
        check(Arrays.equals(Files.readAllBytes(pending.toPath()),new byte[]{7}),"repeated close cannot delete a later request's temporary file");
        check(Arrays.equals(Files.readAllBytes(target.toPath()),wire),"repeated close preserves completed published output");
        pending.delete();
        File invalid=file(directory,"bad-nonce.tmp");
        fails(()->new CaptureOutput.LayerFile(file(directory,"bad-nonce.bin"),invalid,"not-hex"));
        check(!invalid.exists(),"header failure cleans its opened output");
        System.out.println("PASS layer-file-lifecycle");
    }
    static void selectionLateCleanup() throws Exception {
        RefCaptureSelection selection=new RefCaptureSelection();Bitmap retained=image(1),transferred=image(2);
        ArrayList<CaptureFrame.RefLayer> layers=new ArrayList<>();layers.add(new CaptureFrame.RefLayer(retained));layers.add(new CaptureFrame.RefLayer(transferred));
        selection.complete(layers);check(selection.get()==layers,"same selection list returned");
        layers.get(1).bitmap=null;selection.close();selection.close();recycled(retained,1,"unsubmitted selected input reclaimed");recycled(transferred,0,"transferred input belongs to pipeline");transferred.recycle();
        RefCaptureSelection abandoned=new RefCaptureSelection();abandoned.close();Bitmap late=image(3);ArrayList<CaptureFrame.RefLayer> lateLayers=new ArrayList<>();lateLayers.add(new CaptureFrame.RefLayer(late));
        abandoned.complete(lateLayers);abandoned.close();recycled(late,1,"late selection after timeout is reclaimed");
        check(abandoned.get()==null,"late selection never escapes closed owner");
        RefCaptureSelection partial=new RefCaptureSelection();Bitmap first=image(4);ArrayList<CaptureFrame.RefLayer> partialLayers=new ArrayList<>();partialLayers.add(new CaptureFrame.RefLayer(first));
        partial.complete(partialLayers);partial.close();recycled(first,1,"partial list can be handed to failure cleanup");
        System.out.println("PASS selection-late-cleanup");
    }
    public static void main(String[] args) throws Exception {
        File directory=new File(args[0]);orderedOutputAndBounds(directory);cancelAndLateOwnership(directory);failureAndRejectedSubmit(directory);writerAndPublishFailures(directory);layerFileLifecycle(directory);selectionLateCleanup();
    }
}

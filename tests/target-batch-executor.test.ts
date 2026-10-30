import assert from 'node:assert/strict';
import {chmodSync,existsSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {trackSignalDeadline} from '../electron/device/signal-deadline';
import {createTargetBatchBoundary,createTargetBatchRequest,TARGET_BATCH_LIMIT} from '../scripts/diagnostics/boundary/target-batch-candidate';
import {runBoundedTargetBatch,TARGET_BATCH_STDERR_LIMIT,TargetBatchExecutionError} from '../scripts/diagnostics/boundary/target-batch-executor';

const quote=(s:string)=>`'${s.replace(/'/g,"'\\''")}'`,pkg='com.example.boundary';
function fixture(config:Record<string,unknown>={}){
  const directory=mkdtempSync(join(tmpdir(),'bounded-batch-')),adbPath=join(directory,'fake-adb'),run=join(directory,'run');
  writeFileSync(join(directory,'config.json'),JSON.stringify(config));
  const fixture=fileURLToPath(new URL('./fixtures/target-batch-executor.mjs',import.meta.url));
  writeFileSync(adbPath,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${quote(directory)} "$@"\n`);chmodSync(adbPath,0o700);
  const request=createTargetBatchRequest(pkg),controller=new AbortController();trackSignalDeadline(controller.signal,performance.now()+4000);
  const options={directory:run,adbPath,serial:'offline-executor',packageName:pkg,request,signal:controller.signal};
  const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+3000;while(!predicate()){assert(Date.now()<deadline,'Local fixture barrier not reached');await delay(3);}};
  return {directory,run,options,controller,invoke:(patch:Partial<typeof options>={})=>runBoundedTargetBatch({...options,...patch}),
    record:()=>JSON.parse(readFileSync(join(run,'execution.json'),'utf8')),
    until,release:(name='release')=>writeFileSync(join(directory,name),''),
    dispose:()=>{controller.abort();if(existsSync(join(directory,'orphan.pid'))){const pid=Number(readFileSync(join(directory,'orphan.pid'),'utf8'));try{process.kill(-pid,'SIGKILL');}catch{}}
      rmSync(directory,{recursive:true,force:true});}};
}
const outcome=async(operation:ReturnType<typeof runBoundedTargetBatch>)=>{try{return {value:await operation};}catch(error){assert(error instanceof TargetBatchExecutionError);return {error};}};

test('complete packet requires process close, then archives transport completion without accepting a target',async()=>{
  const h=fixture({mode:'packet-hold'});let finished=false;const op=outcome(h.invoke()).finally(()=>{finished=true;});
  try{await h.until(()=>existsSync(join(h.directory,'packet-written')));assert(!finished);assert.equal(h.record().status,'running');
    h.release('close-release');const result=await op;assert(result.value);const r=h.record();assert.equal(r.status,'completed');
    assert(r.exit.confirmed&&r.exit.closeConfirmed&&r.packetValidated);assert.equal(r.targetVerified,false);assert.equal(r.remoteCleanup,'script-reported');
    assert(existsSync(join(h.directory,'cleanup-done')));assert.equal(statSync(join(h.run,'execution.json')).mode&0o777,0o600);
  }finally{h.release('close-release');await op;h.dispose();}
});
for(const debugCode of [0,1])test(`bounded executor composes with original target acceptance: Debug exit ${debugCode}`,async()=>{
  const h=fixture({debugCode});let focusCalls=0;
  const boundary=createTargetBatchBoundary({batch:(adbPath,serial,request,signal)=>h.invoke({adbPath,serial,request,signal}),
    command:async()=>{focusCalls++;return {code:0,stdout:Buffer.from(`mTopFocusedDisplayId=0\nmCurrentFocus=Window{de45 u0 ${pkg}/.Main}`),stderr:''};},
    frame:async()=>({width:1080,height:2400,rotation:0})});
  try{if(debugCode===0)assert((await boundary(h.options.adbPath,h.options.serial,pkg,h.options.signal)).frame);
    else await assert.rejects(boundary(h.options.adbPath,h.options.serial,pkg,h.options.signal),/不可调试/);
    assert.equal(focusCalls,debugCode===0?1:0);assert.equal(h.record().queryExitCodes.debug,debugCode);assert.equal(h.record().targetVerified,false);
  }finally{h.dispose();}
});
for(const [mode,code] of [['flood-stdout','stdout_limit'],['flood-stderr','stderr_limit'],['partial','protocol_invalid'],['outer-stderr','protocol_invalid']] as const)
  test(`bounded stream rejects ${mode} and archives only capped prefixes`,async()=>{
    const h=fixture({mode});try{const result=await outcome(h.invoke());assert.equal(result.error?.code,code);const r=h.record();
      assert(r.exit.closeConfirmed);assert(r.stdout.retainedBytes<=TARGET_BATCH_LIMIT&&r.stderr.retainedBytes<=TARGET_BATCH_STDERR_LIMIT);
      if(mode.startsWith('flood-')){const bucket=mode==='flood-stdout'?r.stdout:r.stderr;assert(bucket.receivedBytes>bucket.retainedBytes);assert(r.termination.requested);}
    }finally{h.dispose();}
  });
test('exactly-at-cap output reaches protocol validation rather than falsely failing the stream limit',async()=>{
  const h=fixture({mode:'exact-limit',limit:TARGET_BATCH_LIMIT});try{
    const r=await outcome(h.invoke());assert.equal(r.error?.code,'protocol_invalid');assert.equal(h.record().stdout.retainedBytes,TARGET_BATCH_LIMIT);
  }finally{h.dispose();}
});
for(const exitCode of [17,124])test(`valid packet with outer exit ${exitCode} never completes`,async()=>{
  const h=fixture({exitCode});try{const r=await outcome(h.invoke());assert.equal(r.error?.code,'process_exit');assert(h.record().exit.closeConfirmed);
    assert.equal(h.record().packetValidated,false);if(exitCode===124)assert.equal(h.record().remoteCleanup,'reported-failed');
  }finally{h.dispose();}
});
test('ADB disconnect retains a closed failed record without parsing a partial response',async()=>{
  const h=fixture({mode:'disconnect'});try{
    const r=await outcome(h.invoke());assert.equal(r.error?.code,'process_exit');const record=h.record();
    assert(record.exit.confirmed&&record.exit.closeConfirmed);assert.equal(record.exit.code,1);assert.equal(record.packetValidated,false);
    assert.equal(record.stdout.receivedBytes,0);assert(record.stderr.receivedBytes>0);assert.equal(record.remoteCleanup,'not-verified');
  }finally{h.dispose();}
});
for(const kind of ['pre-cancel','expired-budget','forged-script','relative-adb','bad-serial'] as const)test(`${kind} is archived before any process can start`,async()=>{
  const h=fixture();try{
    if(kind==='pre-cancel')h.controller.abort();if(kind==='expired-budget')trackSignalDeadline(h.controller.signal,performance.now()-1);
    const patch=kind==='forged-script'?{request:{...h.options.request,script:h.options.request.script+'\necho forbidden'}}:kind==='relative-adb'?{adbPath:'relative'}:kind==='bad-serial'?{serial:'bad;input'}:{};
    const r=await outcome(h.invoke(patch));assert(r.error);assert(!existsSync(join(h.directory,'entered')));assert.equal(h.record().pid,null);
  }finally{h.dispose();}
});
test('spawn error has its own closed failure record',async()=>{
  const h=fixture();try{const r=await outcome(h.invoke({adbPath:join(h.directory,'missing-adb')}));assert.equal(r.error?.code,'spawn_error');
    assert.equal(h.record().processError,'ENOENT');assert(h.record().exit.closeConfirmed);
  }finally{h.dispose();}
});
test('parent cancellation waits for cooperative cleanup and process close before returning',async()=>{
  const h=fixture({mode:'cancel-cleanup'});let finished=false;const op=outcome(h.invoke()).finally(()=>{finished=true;});
  try{await h.until(()=>existsSync(join(h.directory,'entered')));h.controller.abort();await h.until(()=>existsSync(join(h.directory,'cleanup-started')));
    assert(!finished);h.release('cleanup-release');const r=await op;assert.equal(r.error?.code,'cancelled');assert(existsSync(join(h.directory,'cleanup-done')));
    assert(h.record().exit.closeConfirmed);assert.equal(h.record().remoteCleanup,'not-verified');
  }finally{h.release('cleanup-release');await op;h.dispose();}
});
test('ignored TERM escalates only the owned process group and still confirms close',async()=>{
  const h=fixture({mode:'ignore-term'});const op=outcome(h.invoke());try{await h.until(()=>existsSync(join(h.directory,'entered')));h.controller.abort();
    const r=await op;assert.equal(r.error?.code,'cancelled');assert(h.record().termination.escalated&&h.record().exit.closeConfirmed);
    assert.throws(()=>process.kill(Number(readFileSync(join(h.directory,'entered'),'utf8')),0));
  }finally{await op;h.dispose();}
});
test('tracked parent deadline is enforced even if its signal has not yet been aborted',async()=>{
  const h=fixture({mode:'gate'});trackSignalDeadline(h.controller.signal,performance.now()+200);
  try{const r=await outcome(h.invoke());assert.equal(r.error?.code,'deadline_exceeded');assert(!h.controller.signal.aborted);
    assert(h.record().budgetMs<=200);assert(h.record().exit.closeConfirmed);
  }finally{h.dispose();}
});
test('missing pipe-close acknowledgement fails explicitly instead of returning the valid packet',async()=>{
  const h=fixture({mode:'orphan-pipe'});try{const r=await outcome(h.invoke());assert.equal(r.error?.code,'close_unconfirmed');
    assert(existsSync(join(h.directory,'orphan.pid')));
    assert(h.record().exit.confirmed&&!h.record().exit.closeConfirmed&&h.record().termination.forcedStreamClose);assert.equal(h.record().packetValidated,false);
  }finally{h.dispose();}
});
test('replaced main record remains untouched and failure is archived independently after close',async()=>{
  const h=fixture({mode:'gate'});const op=outcome(h.invoke());try{await h.until(()=>existsSync(join(h.directory,'entered')));
    writeFileSync(join(h.run,'execution.json'),'foreign bytes');h.release();const r=await op;assert.equal(r.error?.code,'archive_failed');
    assert.equal(readFileSync(join(h.run,'execution.json'),'utf8'),'foreign bytes');assert(r.error?.record.exit.closeConfirmed);
    assert.equal(readdirSync(h.run).filter(n=>n.startsWith('failure-')).length,1);
  }finally{h.release();await op;h.dispose();}
});
test('total archive loss returns the original closed record explicitly to the caller',async()=>{
  const h=fixture({mode:'gate'});const op=outcome(h.invoke());try{await h.until(()=>existsSync(join(h.directory,'entered')));
    renameSync(h.run,join(h.directory,'retained-record'));writeFileSync(h.run,'foreign path');h.release();const r=await op;
    assert.equal(r.error?.code,'archive_unavailable');assert.equal(r.error?.reportPath,null);assert(r.error?.record.exit.closeConfirmed);
    assert.equal(readFileSync(h.run,'utf8'),'foreign path');
  }finally{h.release();await op;h.dispose();}
});
test('existing run directory is rejected without overwriting the first report',async()=>{
  const h=fixture();try{await h.invoke();const before=readFileSync(join(h.run,'execution.json'));await assert.rejects(h.invoke(),/EEXIST/);
    assert.deepEqual(readFileSync(join(h.run,'execution.json')),before);
  }finally{h.dispose();}
});

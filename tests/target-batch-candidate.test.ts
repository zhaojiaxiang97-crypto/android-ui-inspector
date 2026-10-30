import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {checkedDebugTarget} from '../electron/device/target';
import {readDisplayFrame} from '../electron/device/screen';
import {runDeviceAdb,type CommandResult} from '../electron/device/runtime';
import {withCommandSignal} from '../electron/device/command-context';
import {createTargetBatchBoundary,createTargetBatchRequest,decodeTargetBatch,TARGET_BATCH_STREAM_LIMIT} from '../scripts/diagnostics/boundary/target-batch-candidate';

const pkg='com.example.boundary';
const quote=(s:string)=>`'${s.replace(/'/g,"'\\''")}'`;
function fixture(config:Record<string,unknown>={}){
  const directory=mkdtempSync(join(tmpdir(),'target-batch-offline-')),bin=join(directory,'bin'),scratch=join(directory,'scratch');
  mkdirSync(bin);mkdirSync(scratch);writeFileSync(join(directory,'config.json'),JSON.stringify(config));
  const command=fileURLToPath(new URL('./fixtures/target-batch-command.mjs',import.meta.url));
  for(const name of ['adb','dumpsys','run-as']){
    const path=join(bin,name);writeFileSync(path,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(command)} ${quote(directory)} ${quote(name)} "$@"\n`);chmodSync(path,0o700);
  }
  let batches=0,batchClosed=false;
  const batch=(adbPath:string,selected:string,request:ReturnType<typeof createTargetBatchRequest>,signal:AbortSignal):Promise<CommandResult>=>{
    assert.equal(adbPath,adb);assert.equal(selected,serial,'Batch and separate checks must address the same device');
    signal.throwIfAborted();batches++;
    return new Promise((resolve,reject)=>{
      const child=spawn('/bin/sh',['-c',request.script],{env:{...process.env,PATH:bin+':'+process.env.PATH,TMPDIR:scratch},stdio:['ignore','pipe','pipe']});
      const out:Buffer[]=[],err:Buffer[]=[];
      const abort=()=>{child.kill('SIGTERM');};signal.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));
      child.once('error',reject);
      child.once('close',code=>{signal.removeEventListener('abort',abort);batchClosed=true;
        if(signal.aborted)reject(signal.reason);else resolve({code,stdout:Buffer.concat(out),stderr:Buffer.concat(err).toString('utf8')});});
    });
  };
  const events=()=>existsSync(join(directory,'events.jsonl'))?readFileSync(join(directory,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
  const until=async(predicate:()=>boolean)=>{const end=Date.now()+6000;while(!predicate()){assert(Date.now()<end,'Offline fixture barrier not reached');await delay(3);}};
  const adb=join(bin,'adb'),serial='offline-'+directory.split('/').at(-1);
  const candidate=createTargetBatchBoundary({batch,command:runDeviceAdb,frame:readDisplayFrame});
  const original=(signal:AbortSignal)=>withCommandSignal(signal,async()=>{
    const [target,frame]=await Promise.allSettled([checkedDebugTarget(adb,serial,pkg,{parallelBoundary:true}),readDisplayFrame(adb,serial)]);
    signal.throwIfAborted();if(target.status==='rejected')throw target.reason;if(frame.status==='rejected')throw frame.reason;
    return {target:target.value,frame:frame.value};
  });
  return {directory,scratch,adb,serial,batch,events,until,original,candidate,batchClosed:()=>batchClosed,
    invoke:(mode:'original'|'candidate',signal=new AbortController().signal)=>mode==='original'?original(signal):candidate(adb,serial,pkg,signal),
    release:(kind:string)=>writeFileSync(join(directory,kind+'.release'),''),
    calls:()=>batches+events().filter(x=>x.tool==='adb'&&x.event==='start').length,
    configure:(next:Record<string,unknown>)=>writeFileSync(join(directory,'config.json'),JSON.stringify(next)),
    dispose:()=>{assert.deepEqual(readdirSync(scratch),[],'Batch scratch must be removed');rmSync(directory,{recursive:true,force:true});}};
}
const outcome=async(operation:Promise<unknown>)=>{try{return {value:await operation};}catch(e){const x=e as Error&{foregroundReason?:string;focusReason?:string};return {error:{name:x.name,message:x.message,foregroundReason:x.foregroundReason,focusReason:x.focusReason}};}};
const focus=`mTopFocusedDisplayId=0\nmCurrentFocus=Window{de45 u0 ${pkg}/.Main}\n`;
const scenarios:[string,Record<string,unknown>][]=[
  ['success',{}],['fallback',{focus:{stdout:'mTopFocusedDisplayId=0\n'}}],
  ['foreground-null',{activity:{stdout:'mResumedActivity: null\n'}}],['foreground-missing',{activity:{stdout:'no activity'}}],
  ['foreground-malformed',{activity:{stdout:'mResumedActivity: unknown'}}],['foreground-other-app',{activity:{stdout:'mResumedActivity: ActivityRecord{abc123 u0 com.other.app/.Main t12}'}}],
  ['foreground-exit',{activity:{code:1}}],['foreground-permission',{activity:{stdout:'Permission Denial'}}],
  ['foreground-stderr',{activity:{stderr:'java.lang.SecurityException: denied'}}],['foreground-timeout',{activity:{stdout:'*** DUMP TIMEOUT ***'}}],
  ['not-debug',{debug:{code:1,stderr:'not debuggable'}}],['both-initial-fail',{activity:{code:1},debug:{code:1}}],
  ['focus-null',{focus:{stdout:'mCurrentFocus=null'}}],['focus-duplicate',{focus:{stdout:focus+focus}}],
  ['focus-secondary',{focus:{stdout:focus.replace('DisplayId=0','DisplayId=2')}}],['focus-other-app',{focus:{stdout:focus.replace(pkg,'com.other.app')}}],
  ['focus-malformed',{focus:{stdout:'mCurrentFocus=Window{bad}'}}],['focus-exit',{focus:{code:1}}],
  ['focus-permission',{focus:{stderr:'Permission Denial'}}],['focus-full-missing-display',{focus:{stdout:'missing'},focusAll:{stdout:'mCurrentFocus=Window{de45 u0 '+pkg+'/.Main}'}}],
  ['frame-exit',{frame:{code:1}}],['frame-missing',{frame:{stdout:'missing'}}],
  ['frame-conflict',{frame:{stdout:'Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, 1080, 2400]\nViewport INTERNAL: displayId=0, orientation=1, logicalFrame=[0, 0, 2400, 1080]'}}],
  ['target-and-frame-fail',{activity:{code:1},frame:{code:1}}],
];
for(const [name,config] of scenarios)test(`batched boundary matches original queries and outcome: ${name}`,async()=>{
  const a=fixture(config),b=fixture(config);try{
    const [before,after]=await Promise.all([outcome(a.invoke('original')),outcome(b.invoke('candidate'))]);assert.deepEqual(after,before);
    if(name==='success'||name==='fallback'){
      assert(!after.error);assert.deepEqual((after.value as {frame:unknown}).frame,{width:1080,height:2400,rotation:0});
    }else if(name.startsWith('frame-')){
      assert(!after.error);assert.equal((after.value as {frame:unknown}).frame,null,'Caller must still reject missing geometry');
    }else assert(after.error,'Fault fixture must not pass both implementations');
    const queries=(h:ReturnType<typeof fixture>)=>h.events().filter(x=>x.event==='start').map(x=>x.key).sort();
    assert.deepEqual(queries(b),queries(a));assert.equal(b.calls(),a.calls()-1);
  }finally{a.dispose();b.dispose();}
});
for(const mode of ['original','candidate'] as const)test(`${mode} keeps display independent and does not postpone focus behind slow display`,async()=>{
  const h=fixture({barriers:['frame']});let settled=false;const op=h.invoke(mode).finally(()=>{settled=true;});
  try{await h.until(()=>existsSync(join(h.directory,'focus.done')));assert(!settled);assert(!existsSync(join(h.directory,'frame.done')));
    h.release('frame');assert((await op).frame);
  }finally{h.release('frame');await op.catch(()=>{});h.dispose();}
});
for(const mode of ['original','candidate'] as const)test(`${mode} joins both initial reads before focus`,async()=>{
  const h=fixture({barriers:['activity','debug']});const op=h.invoke(mode);
  try{await h.until(()=>existsSync(join(h.directory,'activity.entered'))&&existsSync(join(h.directory,'debug.entered')));
    assert(!existsSync(join(h.directory,'focus.entered')));h.release('activity');await h.until(()=>existsSync(join(h.directory,'activity.done')));
    assert(!existsSync(join(h.directory,'focus.entered')));h.release('debug');assert((await op).frame);
  }finally{h.release('activity');h.release('debug');await op.catch(()=>{});h.dispose();}
});

test('successful reads never reuse previous Activity or focus identities',async()=>{
  const h=fixture();try{const first=await h.invoke('candidate');h.configure({activity:{stdout:`mResumedActivity: ActivityRecord{bbb u0 ${pkg}/.Main t12}`},focus:{stdout:focus.replace('de45','f00d')}});
    const second=await h.invoke('candidate');assert.equal(first.target.activityRecordId,'abc123');assert.equal(second.target.activityRecordId,'bbb');assert.equal(second.target.windowId,'f00d');assert.equal(h.calls(),6);
  }finally{h.dispose();}
});

for(const name of ['cancelled','deadline'] as const)test(`batch ${name} kills/reaps both initial children, removes scratch and still joins display`,async()=>{
  const h=fixture({barriers:['activity','debug']}),controller=new AbortController();let release!:()=>void,finished=false;
  const frame=new Promise<null>(resolve=>{release=()=>resolve(null);});
  const candidate=createTargetBatchBoundary({batch:h.batch,command:runDeviceAdb,frame:()=>frame});
  const op=outcome(candidate(h.adb,h.serial,pkg,controller.signal)).finally(()=>{finished=true;});
  try{await h.until(()=>existsSync(join(h.directory,'activity.entered'))&&existsSync(join(h.directory,'debug.entered')));
    const dirs=readdirSync(h.scratch);assert.equal(dirs.length,1);assert.equal(statSync(join(h.scratch,dirs[0])).mode&0o777,0o700);
    const pids=['activity','debug'].map(k=>Number(readFileSync(join(h.directory,k+'.entered'),'utf8')));
    controller.abort(new DOMException(name,name==='deadline'?'TimeoutError':'AbortError'));await h.until(h.batchClosed);
    assert(!finished,'Must join display even after cancellation');assert.deepEqual(readdirSync(h.scratch),[]);
    for(const pid of pids)assert.throws(()=>process.kill(pid,0));assert(!existsSync(join(h.directory,'focus.entered')));
    release();const result=await op;assert.equal(result.error?.name,name==='deadline'?'TimeoutError':'AbortError');
  }finally{controller.abort();release();await op;h.dispose();}
});
test('pre-cancelled boundary dispatches neither batch nor focus',async()=>{
  const h=fixture(),controller=new AbortController();controller.abort();try{
    await assert.rejects(h.invoke('candidate',controller.signal));assert.equal(h.calls(),0);
  }finally{h.dispose();}
});
for(const mode of ['original','candidate'] as const)test(`${mode} target failure still joins a slow display`,async()=>{
  const h=fixture({activity:{code:1},barriers:['frame']});let finished=false;
  const op=outcome(h.invoke(mode)).finally(()=>{finished=true;});
  try{await h.until(()=>existsSync(join(h.directory,'activity.done'))&&existsSync(join(h.directory,'debug.done'))&&existsSync(join(h.directory,'frame.entered')));
    for(let i=0;i<20;i++)await Promise.resolve();assert(!finished);assert(!existsSync(join(h.directory,'focus.entered')));
    h.release('frame');assert.equal((await op).error?.foregroundReason,'query-failed');
  }finally{h.release('frame');await op;h.dispose();}
});
for(const mode of ['original','candidate'] as const)test(`${mode} deadline during focus prevents fallback and returns caller cancellation`,async()=>{
  const h=fixture({barriers:['focus']}),controller=new AbortController();const op=outcome(h.invoke(mode,controller.signal));
  try{await h.until(()=>existsSync(join(h.directory,'focus.entered')));controller.abort(new DOMException('expired','TimeoutError'));
    assert.equal((await op).error?.name,'TimeoutError');assert(!existsSync(join(h.directory,'focusAll.entered')));
  }finally{controller.abort();h.release('focus');await op;h.dispose();}
});
for(const fault of ['disconnect','truncated'] as const)test(`batch ${fault} fails closed, never asks focus and joins display`,async()=>{
  const controller=new AbortController();let release!:()=>void,finished=false,focusCalls=0;
  const frame=new Promise<null>(resolve=>{release=()=>resolve(null);});
  const boundary=createTargetBatchBoundary({batch:async()=>{
    if(fault==='disconnect')throw Error('fixture disconnected');return {code:0,stdout:Buffer.from('INSPECTOR_TARGET_V1 truncated'),stderr:''};
  },command:async()=>{focusCalls++;throw Error('No focus after failed batch');},frame:()=>frame});
  const op=outcome(boundary('/fixture/adb','fixture',pkg,controller.signal)).finally(()=>{finished=true;});
  for(let i=0;i<20;i++)await Promise.resolve();assert(!finished);release();const result=await op;
  assert.equal(focusCalls,0);assert.equal(result.error?.name,fault==='disconnect'?'ForegroundUnavailableError':'TargetBatchProtocolError');
});

test('batch framing preserves byte lengths, stderr, NULs and embedded terminators',async()=>{
  const h=fixture({activity:{stdout:'中文\u0000\nEND fake\n',stderr:'stderr\n',code:7},debug:{stdout:'尾部',stderr:'debug stderr',code:9}});
  try{const request=createTargetBatchRequest(pkg),raw=await h.batch(h.adb,h.serial,request,new AbortController().signal),decoded=decodeTargetBatch(raw,request.requestId);
    assert.equal(decoded.activity.stdout.toString(),'中文\u0000\nEND fake\n');assert.equal(decoded.activity.stderr,'stderr\n');assert.equal(decoded.activity.code,7);
    assert.equal(decoded.debug.stdout.toString(),'尾部');assert.equal(decoded.debug.stderr,'debug stderr');assert.equal(decoded.debug.code,9);
    for(const bad of [raw.stdout.subarray(0,raw.stdout.length-1),Buffer.concat([raw.stdout,Buffer.from('extra')]),
      Buffer.from(raw.stdout.toString().replace('activity 7','activity 999')),Buffer.from(raw.stdout.toString().replace('debug 9','activity 9'))])
      assert.throws(()=>decodeTargetBatch({...raw,stdout:bad},request.requestId));
    assert.throws(()=>decodeTargetBatch(raw,createTargetBatchRequest(pkg).requestId));
    const nonAscii=Buffer.from(raw.stdout);nonAscii[0]|=128;
    assert.throws(()=>decodeTargetBatch({...raw,stdout:nonAscii},request.requestId));
    const wrongLength=Buffer.from(raw.stdout.toString().replace(/activity 7 \d+ /,'activity 7 99999999 '));
    assert.throws(()=>decodeTargetBatch({...raw,stdout:wrongLength},request.requestId));
    assert.throws(()=>decodeTargetBatch({...raw,code:null},request.requestId));assert.throws(()=>decodeTargetBatch({...raw,stderr:'shell failed'},request.requestId));
  }finally{h.dispose();}
});
test('oversize output fails closed and removes temporary results',async()=>{
  const h=fixture({activity:{stdout:'x'.repeat(TARGET_BATCH_STREAM_LIMIT+1)}});try{
    const request=createTargetBatchRequest(pkg),raw=await h.batch(h.adb,h.serial,request,new AbortController().signal);assert.notEqual(raw.code,0);
    assert.throws(()=>decodeTargetBatch(raw,request.requestId));
  }finally{h.dispose();}
});
test('package command injection is rejected before building a shell request',()=>{
  for(const invalid of ['com.test;id','com.test\nwhoami',"com.test'",'$(id).test','com'])assert.throws(()=>createTargetBatchRequest(invalid));
});
test('cleanup failure rejects a complete packet instead of publishing it as success',async()=>{
  const h=fixture();try{
    const rm=join(h.directory,'bin/rm');writeFileSync(rm,'#!/bin/sh\nexit 1\n');chmodSync(rm,0o700);
    const request=createTargetBatchRequest(pkg),raw=await h.batch(h.adb,h.serial,request,new AbortController().signal);
    assert.equal(raw.code,124);assert(raw.stdout.toString().endsWith(`END ${request.requestId}\n`));
    assert.throws(()=>decodeTargetBatch(raw,request.requestId));
    for(const name of readdirSync(h.scratch))rmSync(join(h.scratch,name),{recursive:true});
  }finally{h.dispose();}
});

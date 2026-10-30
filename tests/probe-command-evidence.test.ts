import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {createCommandRunner} from '../electron/platform/command-runner';
import {trackSignalDeadline} from '../electron/device/signal-deadline';
import {recordProbeCommand,ProbeCommandEvidenceError} from '../scripts/diagnostics/boundary/probe-command-evidence';
const fixture=fileURLToPath(new URL('./fixtures/probe-evidence-child.mjs',import.meta.url));
function harness(mode='ok'){
  const directory=mkdtempSync(join(tmpdir(),'probe-evidence-')),run=join(directory,'run');
  const runner=createCommandRunner(process.execPath,[fixture,mode,directory]),controller=new AbortController();
  const options={directory:run,name:'fixture',runner,args:[] as string[],timeoutMs:3000,signal:controller.signal};
  const until=async(test:()=>boolean)=>{const end=Date.now()+4000;while(!test()){assert(Date.now()<end,'Fixture barrier deadline');await delay(3);}};
  return {directory,run,runner,controller,options,invoke:()=>recordProbeCommand(options),
    record:()=>JSON.parse(readFileSync(join(run,'command.json'),'utf8')),until,
    release:()=>writeFileSync(join(directory,'release'),''),
    dispose:async()=>{controller.abort();await runner.finish(2000);rmSync(directory,{recursive:true,force:true});}};
}
async function failure(operation:Promise<Buffer>){try{await operation;assert.fail('Expected failure');}catch(error){assert(error instanceof ProbeCommandEvidenceError);return error;}}
test('success durably records both streams, exit, close and duration with a private record',async()=>{
  const h=harness();try{assert.equal((await h.invoke()).toString(),'ok\n');const r=h.record();
    assert.equal(r.status,'completed');assert.equal(r.command.stdout,'ok\n');assert.equal(r.command.stderr,'warning\n');
    assert(r.command.closed&&r.command.spawned);assert.equal(r.command.exitCode,0);assert(r.command.durationMs>=0&&r.elapsedMs>=r.command.durationMs);
    assert.equal(statSync(join(h.run,'command.json')).mode&0o777,0o600);assert.equal(h.runner.snapshot().length,1);
  }finally{await h.dispose();}
});
test('nonzero command retains exact error output, exit code and close before throwing',async()=>{
  const h=harness('fail');try{const e=await failure(h.invoke());assert.equal(e.code,'command_failed');const r=h.record();
    assert.equal(r.command.exitCode,7);assert.equal(r.command.stdout,'partial\n');assert.equal(r.command.stderr,'mkfifo: Permission denied\n');assert(r.command.closed);
    assert.match(r.error,/exit 7/);assert.deepEqual(e.record,r);assert.equal(h.runner.snapshot().length,1);
  }finally{await h.dispose();}
});
for(const kind of ['cancelled','expired','invalid'] as const)test(`${kind} before dispatch is archived without launching`,async()=>{
  const h=harness();try{if(kind==='cancelled')h.controller.abort();if(kind==='expired')trackSignalDeadline(h.controller.signal,performance.now()-1);if(kind==='invalid')h.options.args=['bad\0arg'];
    const e=await failure(h.invoke());assert.equal(e.code,'not_dispatched');assert.equal(h.runner.snapshot().length,0);assert.equal(h.record().command,null);assert(h.record().error);
  }finally{await h.dispose();}
});
test('missing executable records ENOENT and never invents exit0',async()=>{
  const h=harness();try{h.options.runner=createCommandRunner(join(h.directory,'missing'));const e=await failure(h.invoke());
    assert.equal(e.record.command?.errorCode,'ENOENT');assert.equal(e.record.command?.spawned,false);assert(e.record.command?.closed);assert.notEqual(e.record.command?.exitCode,0);
  }finally{await h.dispose();}
});
for(const mode of ['cancel','timeout'] as const)test(`${mode} keeps both partial streams and confirmed child closure`,async()=>{
  const h=harness('gate');if(mode==='timeout')h.options.timeoutMs=1500;const op=failure(h.invoke());
  try{await h.until(()=>existsSync(join(h.directory,'entered')));if(mode==='cancel')h.controller.abort();const e=await op;
    assert.equal(e.record.command?.stopReason,mode==='cancel'?'cancelled':'timeout');assert(e.record.command?.closed);
    assert.equal(e.record.command?.stdout,'started\n');assert.equal(e.record.command?.stderr,'waiting\n');assert.equal(e.record.command?.exitCode,null);
  }finally{h.release();await op;await h.dispose();}
});
test('truncated evidence fails explicitly even if the underlying process exits0',async()=>{
  const h=harness('long');try{const e=await failure(h.invoke());assert.equal(e.code,'evidence_truncated');assert.equal(e.record.command?.exitCode,0);
    assert(e.record.command?.stdoutTruncated);assert.equal(e.record.command?.stdout.length,4096);assert.equal(e.record.command?.stderr,'warning\n');
  }finally{await h.dispose();}
});
test('stderr stream overflow preserves the bounded error prefix and limit failure',async()=>{
  const h=harness('large-error');try{const e=await failure(h.invoke());assert.equal(e.record.command?.stopReason,'output-limit');
    assert(e.record.command?.stderrTruncated&&e.record.command?.closed);assert.equal(e.record.command?.stderr.length,4096);
  }finally{await h.dispose();}
});
test('initial archive collision cannot start another command or overwrite the first record',async()=>{
  const h=harness();try{await h.invoke();const before=readFileSync(join(h.run,'command.json'));await assert.rejects(h.invoke(),/EEXIST/);
    assert.deepEqual(readFileSync(join(h.run,'command.json')),before);assert.equal(h.runner.snapshot().length,1);
  }finally{await h.dispose();}
});
test('replaced archive is retained and failure gets an independent closed record',async()=>{
  const h=harness('gate'),op=failure(h.invoke());try{await h.until(()=>existsSync(join(h.directory,'entered')));writeFileSync(join(h.run,'command.json'),'foreign bytes');h.release();
    const e=await op;assert.equal(e.code,'archive_failed');assert.equal(readFileSync(join(h.run,'command.json'),'utf8'),'foreign bytes');
    assert(e.record.command?.closed&&e.record.archiveError);assert.equal(readdirSync(h.run).filter(p=>p.startsWith('failure-')).length,1);
  }finally{h.release();await op;await h.dispose();}
});
test('total archive loss returns the closed evidence to the caller without replacing foreign paths',async()=>{
  const h=harness('gate'),op=failure(h.invoke());try{await h.until(()=>existsSync(join(h.directory,'entered')));renameSync(h.run,join(h.directory,'retained'));writeFileSync(h.run,'foreign path');h.release();
    const e=await op;assert.equal(e.code,'archive_unavailable');assert.equal(e.reportPath,null);assert(e.record.command?.closed);assert.equal(e.record.command?.stdout,'started\ndone\n');
    assert.equal(readFileSync(h.run,'utf8'),'foreign path');
  }finally{h.release();await op;await h.dispose();}
});
test('archive tampering during dispatch prevents spawn and still leaves independent failure evidence',async()=>{
  const h=harness(),execute=h.runner.execute;
  h.runner.execute=(args,timeout,signal,options)=>execute(args,timeout,signal,{onDispatch:at=>{writeFileSync(join(h.run,'command.json'),'foreign bytes');options?.onDispatch?.(at);}});
  try{const e=await failure(h.invoke());assert.equal(e.record.command?.spawned,false);assert.equal(e.record.command?.errorCode,'DISPATCH_REJECTED');
    assert.equal(readFileSync(join(h.run,'command.json'),'utf8'),'foreign bytes');assert(e.record.archiveError);
  }finally{await h.dispose();}
});

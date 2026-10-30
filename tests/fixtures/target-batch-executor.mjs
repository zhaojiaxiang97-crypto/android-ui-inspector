// Fake ADB only: emits bounded test packets or exercises local process lifecycle faults.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const [directory,...args]=process.argv.slice(2),config=JSON.parse(readFileSync(join(directory,'config.json'),'utf8'));
if(args[0]==='orphan'){
  writeFileSync(join(directory,'orphan.pid'),String(process.pid));while(true)await delay(1000);
}
assert.deepEqual(args.slice(0,3),['-s','offline-executor','shell']);assert.equal(args.length,4);
const requestId=/INSPECTOR_TARGET_V1 ([a-f0-9-]{36})/.exec(args[3])?.[1];assert(requestId);
writeFileSync(join(directory,'entered'),String(process.pid));
const mode=config.mode??'packet';
if(mode==='disconnect'){process.stderr.write('error: device offline\n');process.exit(1);}
if(mode==='ignore-term')process.on('SIGTERM',()=>{});
if(mode==='cancel-cleanup')process.on('SIGTERM',async()=>{
  writeFileSync(join(directory,'cleanup-started'),'');while(!existsSync(join(directory,'cleanup-release')))await delay(2);
  writeFileSync(join(directory,'cleanup-done'),'');process.exit(0);
});
if(['gate','ignore-term','cancel-cleanup'].includes(mode))while(!existsSync(join(directory,'release')))await delay(2);
if(mode==='flood-stdout'||mode==='flood-stderr'){
  const stream=mode==='flood-stdout'?process.stdout:process.stderr;
  while(true){if(!stream.write(Buffer.alloc(65536,120)))await new Promise(resolve=>stream.once('drain',resolve));}
}
const encode=(name,code,out,err)=>Buffer.concat([Buffer.from(`${name} ${code} ${Buffer.byteLength(out)} ${Buffer.byteLength(err)}\n`),Buffer.from(out),Buffer.from(err),Buffer.from('\n')]);
const activity=`mResumedActivity: ActivityRecord{abc123 u0 com.example.boundary/.Main t12}\n`;
let packet=Buffer.concat([Buffer.from(`INSPECTOR_TARGET_V1 ${requestId}\n`),encode('activity',config.activityCode??0,activity,''),
  encode('debug',config.debugCode??0,'uid=10001(example)\n',''),Buffer.from(`END ${requestId}\n`)]);
if(mode==='partial')packet=packet.subarray(0,packet.length-3);
if(mode==='exact-limit')packet=Buffer.alloc(config.limit,120);
process.stdout.write(packet);
if(mode==='outer-stderr')process.stderr.write(Buffer.from([255,254]));
if(mode==='packet-hold'){
  writeFileSync(join(directory,'packet-written'),'');while(!existsSync(join(directory,'close-release')))await delay(2);
  writeFileSync(join(directory,'cleanup-done'),'');
}
if(mode==='orphan-pipe'){
  spawn(process.execPath,[fileURLToPath(import.meta.url),directory,'orphan'],{detached:true,stdio:['ignore',process.stdout,process.stderr]}).unref();
}
process.exitCode=config.exitCode??0;

// Local fake commands only. This file cannot find or invoke ADB.
import assert from 'node:assert/strict';
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const [directory,tool,...argv]=process.argv.slice(2);
assert(directory&&['adb','dumpsys','run-as'].includes(tool));
let args=argv;
if(tool==='adb'){
  assert.equal(args[0],'-s');assert.equal(args[2],'shell');args=args.slice(3);
}else args=[tool,...args];
const pkg='com.example.boundary';
const key=args.join(' '),kind=key==='dumpsys activity activities'?'activity':key===`run-as ${pkg} id`?'debug'
  :key==='dumpsys input'?'frame':key==='dumpsys window windows'?'focus':key==='dumpsys window'?'focusAll':null;
assert(kind,'Unexpected fake command '+key);
const config=JSON.parse(readFileSync(join(directory,'config.json'),'utf8'));
const log=event=>appendFileSync(join(directory,'events.jsonl'),JSON.stringify({kind,tool,event,pid:process.pid,key})+'\n');
log('start');writeFileSync(join(directory,kind+'.entered'),String(process.pid));
if(kind.startsWith('focus'))assert(existsSync(join(directory,'activity.done'))&&existsSync(join(directory,'debug.done')),'Focus ran before both initial reads settled');
while(config.barriers?.includes(kind)&&!existsSync(join(directory,kind+'.release')))await delay(2);
const defaults={activity:`mResumedActivity: ActivityRecord{abc123 u0 ${pkg}/.Main t12}\n`,debug:'uid=10001(example) gid=10001(example)\n',
  focus:`mTopFocusedDisplayId=0\nmCurrentFocus=Window{de45 u0 ${pkg}/.Main}\n`,
  focusAll:`mTopFocusedDisplayId=0\nmCurrentFocus=Window{de45 u0 ${pkg}/.Main}\n`,
  frame:'Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, 1080, 2400], isActive=[1]\n'};
const reply=config[kind]??{};
writeFileSync(join(directory,kind+'.done'),'');log('end');
process.stdout.write(reply.stdout??defaults[kind]);process.stderr.write(reply.stderr??'');process.exitCode=reply.code??0;

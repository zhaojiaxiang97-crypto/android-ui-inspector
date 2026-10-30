// Local fixture only. No Android access or child process spawning.
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const [mode,directory]=process.argv.slice(2);
if(mode==='gate'){
  process.stdout.write('started\n');process.stderr.write('waiting\n');writeFileSync(join(directory,'entered'),'');
  while(!existsSync(join(directory,'release')))await delay(3);
  process.stdout.write('done\n');
}else if(mode==='fail'){process.stdout.write('partial\n');process.stderr.write('mkfifo: Permission denied\n');process.exitCode=7;}
else if(mode==='long'){process.stdout.write('x'.repeat(6000));process.stderr.write('warning\n');}
else if(mode==='large-error'){process.stderr.write('e'.repeat(9000));await new Promise(()=>{});}
else{process.stdout.write('ok\n');process.stderr.write('warning\n');}

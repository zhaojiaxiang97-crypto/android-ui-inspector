// Local child fixture only. It never invokes adb or contacts Android.
const fs = require('node:fs');
const [statePath, mode, ...args] = process.argv.slice(2);
if (statePath === 'direct') {
  if (mode === 'exit') { process.stdout.write('partial'); process.stderr.write('denied'); process.exitCode = 7; }
  else if (mode === 'sleep') { process.stdout.write('partial\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
  else if (mode === 'large') { process.stdout.write('a'.repeat(2 * 1024 * 1024 + 1)); setInterval(() => {}, 1000); }
  else if (mode === 'stderr-large') { process.stderr.write('e'.repeat(9000)); setInterval(() => {}, 1000); }
  else if (mode === 'text') { process.stdout.write('中'.repeat(2000)); process.stderr.write('warning'); }
  else if (mode === 'echo') process.stdout.write(JSON.stringify(args));
  else if (mode === 'inherited-pipe') {
    require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();
    process.stdout.write('parent exited');
  }
  return;
}
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.calls.push(args); fs.writeFileSync(statePath, JSON.stringify(state));
const reply = value => process.stdout.write(value);
const record = 'ActivityRecord{abc u0 example.app/.Home t1}';
if (args[0] !== '-s' || args[1] !== 'fixture') throw Error('Unexpected device scope');
if (args[2] === 'forward') {
  if (args[3] === '--list') reply(state.mapping ? `fixture ${state.local} ${state.mapping}\n` : '');
  else if (args[3] === '--remove') state.mapping = null;
  else { state.local = args[3] === '--no-rebind' ? args[4] : args[3]; state.mapping = args.at(-1); }
  fs.writeFileSync(statePath, JSON.stringify(state));
} else if (args.includes('sha256sum')) reply(`${state.sha}  ${state.path}\n`);
else if (args.includes('pm')) reply(`package:${state.path}\n`);
else if (args.includes('run-as') && args.at(-1) === 'id') {
  if (mode === 'not-debug') { process.stderr.write('run-as: package not debuggable'); process.exitCode = 1; }
  else reply('uid=10123(example.app) gid=10123(example.app) groups=10123(example.app)\n');
} else if (args.includes('am')) {
  state.started = true; fs.writeFileSync(statePath, JSON.stringify(state));
  reply('Starting: Intent { cmp=example.app/.Home }\n');
  if (mode === 'launch-error') process.stderr.write('Error: Activity class does not exist.\n');
  if (mode === 'launch-warning') process.stderr.write('Warning: Activity not started, task brought to front\n');
  if (mode === 'launch-truncated') process.stderr.write(' '.repeat(5000) + 'Warning: Activity not started\n');
  if (mode === 'launch-hang') setInterval(() => {}, 1000);
} else if (args.includes('pidof')) {
  if (mode === 'pid-unknown') { process.stderr.write('denied'); process.exitCode = 1; }
  else if (!state.started) process.exitCode = 1;
  else if (mode === 'pid-missing') process.exitCode = 1;
  else reply('42\n');
} else if (args.includes('run-as')) {
  const fields = Array(25).fill('0'); fields[0] = 'S'; fields[19] = state.ticks;
  const stat = `42 (fixture) ${fields.join(' ')}\n`;
  reply(`${stat}example.app\0${stat}`);
} else if (args.at(-1) === 'activities') {
  reply(`ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)\n topResumedActivity=${record}\n` +
    ` * Hist #0: ${record}\n packageName=example.app processName=example.app\n app=ProcessRecord{def 42:example.app/u0a123}\n`);
} else if (args.at(-1) === 'windows') {
  reply('WINDOW MANAGER WINDOWS (dumpsys window windows)\n' + (state.ready ?
    ` Window #0 Window{fed u0 example.app/.Home}:\n mDisplayId=0 mSession=Session{aaa 42:u0a123}\n` +
    ` mOwnerUid=10123 package=example.app\n mAttrs={(0,0) ty=BASE_APPLICATION}\n mActivityRecord=${record}\n` : '') +
    ' mTopFocusedDisplayId=0\n');
} else if (args.at(-1) === 'displays') reply('WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n' +
  ` Display: mDisplayId=0\n mCurrentFocus=null\n mFocusedApp=${record}\n`);
else throw Error(`Forbidden fixture command ${args.join(' ')}`);

// Synthetic read-only device replies. NEVER contacts adb or contains business log fields.
const fs = require('node:fs');
const [statePath, mode, ...args] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.calls.push(args); fs.writeFileSync(statePath, JSON.stringify(state));
const n = state.calls.length, apk = '/data/app/fixture/example.app/base.apk';
const boot = '11111111-1111-1111-1111-111111111111';
if (args[0] !== '-s' || args[1] !== 'fixture') process.exit(90);
if (mode === 'warning' && n === 1) process.stderr.write('warning');
if (mode === 'nonzero' && n === 1) { process.stdout.write('partial'); process.exit(7); }
if (mode === 'wait' && n === 1) { process.stdout.write('partial'); setInterval(() => {}, 100); return; }
if (args[2] === 'shell' && args[3] === 'pm' && args[4] === 'path' && args[5] === 'example.app') {
  process.stdout.write(`package:${apk}\n`);
} else if (args[2] === 'shell' && args[3] === 'sha256sum' && args[4] === apk) {
  process.stdout.write(`${(mode === 'install-change' && n > 6 ? 'b' : 'a').repeat(64)}  ${apk}\n`);
} else if (args[2] === 'exec-out' && args[3] === 'run-as' && args[4] === 'example.app' && args[5] === 'cat') {
  const fields = Array(25).fill('0'); fields[0] = 'S';
  fields[19] = mode === 'pid-reuse' || (mode === 'process-change' && n > 6) ? '12346' : '12345';
  const stat = `42 (fixture) ${fields.join(' ')}\n`;
  process.stdout.write(stat + 'example.app\0' + stat);
} else if (args[2] === 'exec-out' && args[3] === 'sh' && args[4] === '-c' && args[5].includes('boot_id')) {
  // exec-out escapes argv itself. A pre-quoted script is a literal command name,
  // and the host can still return 0 after copying the remote error to stdout.
  if (args[5] !== 'cat /proc/sys/kernel/random/boot_id && date +%s && cat /proc/uptime'
    || mode === 'remote-clock-error') {
    process.stdout.write('sh: script: inaccessible or not found\n'); return;
  }
  const wall = mode === 'clock-change' || (mode === 'late-clock-change' && n > 6) ? 2000 : 1100;
  process.stdout.write(mode === 'invalid-clock' ? `${boot}\n${'9'.repeat(400)}\n${'9'.repeat(400)} 0.00\n` :
    `${mode === 'boot-change' ? boot.replaceAll('1', '2') : boot}\n${wall}\n100.00 0.00\n`);
} else if (args[2] === 'exec-out' && args[3] === 'run-as' && args[4] === 'example.app'
  && args[5] === 'sh' && args[6] === '-c' && args[7].includes('exec 3<') && args[8] === 'log-read') {
  if (!args[7].startsWith('set -eu\n') || !args[7].endsWith('printf \'%s\\n\' "$after"')
    || mode === 'remote-file-error') {
    process.stdout.write('sh: script: inaccessible or not found\n'); return;
  }
  let content = Buffer.from('synthetic event\n');
  if (mode === 'long') content = Buffer.from('x'.repeat(5000) + '\n');
  if (mode === 'bytes-limit') content = Buffer.from('x'.repeat(262144) + '\n');
  if (mode === 'lines-limit') content = Buffer.from('x\n'.repeat(2049));
  if (mode === 'total-lines') content = Buffer.from('x\n'.repeat(2048));
  if (mode === 'total-bytes') content = Buffer.from('x'.repeat(262143) + '\n');
  if (mode === 'tail') content = Buffer.from('unfinished');
  if (mode === 'binary') content = Buffer.from('x\0\n');
  if (mode === 'utf8') content = Buffer.from([0xff, 10]);
  const size = content.length + (mode === 'size-change' ? 1 : 0);
  const metadata = `1:2:${size}:3:4`;
  const end = mode === 'rotate' ? `1:5:${size}:3:4` : metadata;
  const output = Buffer.concat([Buffer.from(metadata + '\n'), content, Buffer.from('\n' + end + '\n')]);
  process.stdout.write(mode === 'truncated-frame' ? output.subarray(0, -1) : output);
} else process.exit(91); // Unexpected commands fail; no permissive fallback.

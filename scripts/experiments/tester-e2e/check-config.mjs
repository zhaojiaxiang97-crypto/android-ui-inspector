import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const cwd = dirname(fileURLToPath(import.meta.url));
const base = { ...process.env, E2E_DEVICE_NAME: 'offline-only', E2E_SAMPLE_CONSENT: 'sample-only', E2E_TELEMETRY_DISABLED: '1' };
for (const [key, message] of [
  ['E2E_DEVICE_NAME', 'E2E_DEVICE_NAME'],
  ['E2E_SAMPLE_CONSENT', 'E2E_SAMPLE_CONSENT'],
  ['E2E_TELEMETRY_DISABLED', 'E2E_TELEMETRY_DISABLED'],
]) {
  const result = spawnSync(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'list'], {
    cwd, env: { ...base, [key]: '' }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, new RegExp(message));
}
const listed = spawnSync(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'list'], {
  cwd, env: base, encoding: 'utf8', timeout: 15000,
});
assert.equal(listed.error, undefined);
assert.equal(listed.status, 0, listed.stderr);
assert.match(listed.stdout, /sample\.e2e\.ts/);
assert.doesNotMatch(listed.stdout, /kuaishou-navigation\.e2e\.ts/);

const business = { ...base, E2E_KUAISHOU_CONSENT: 'settings-playback-back-once' };
for (const key of ['E2E_DEVICE_NAME', 'E2E_KUAISHOU_CONSENT', 'E2E_TELEMETRY_DISABLED']) {
  const result = spawnSync(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'list', '--config', 'e2e.kuaishou.config.ts'], {
    cwd, env: { ...business, [key]: '' }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, new RegExp(key));
}
const businessListed = spawnSync(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'list', '--config', 'e2e.kuaishou.config.ts'], {
  cwd, env: business, encoding: 'utf8', timeout: 15000,
});
assert.equal(businessListed.error, undefined);
assert.equal(businessListed.status, 0, businessListed.stderr);
assert.match(businessListed.stdout, /kuaishou-navigation\.e2e\.ts/);
assert.doesNotMatch(businessListed.stdout, /sample\.e2e\.ts/);
const source = readFileSync(new URL('tests/kuaishou-navigation.e2e.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /await\s+app\.(?:open|restart|clearState)\s*\(/);
assert.equal((source.match(/\.tap\(\)/g) ?? []).length, 1);
assert.equal((source.match(/await device\.back\(\)/g) ?? []).length, 1);
console.log('6 个缺失配置拒绝、2 个隔离发现及业务单次输入源码检查通过；未连接手机。');

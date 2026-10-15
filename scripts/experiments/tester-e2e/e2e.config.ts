import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';

const device = process.env.E2E_DEVICE_NAME?.trim();
if (!device) throw new Error('请设置 E2E_DEVICE_NAME 为 agent-device 列出的唯一手机名称，不是 adb 序列号。');
if (process.env.E2E_SAMPLE_CONSENT !== 'sample-only') {
  throw new Error('先确认允许重开 Inspector 样例并点击一次，再设置 E2E_SAMPLE_CONSENT=sample-only。');
}
if (process.env.E2E_TELEMETRY_DISABLED !== '1') {
  throw new Error('本地实验要求 E2E_TELEMETRY_DISABLED=1。');
}

export default {
  projectId: 'inspector-sample-local-spike',
  tests: 'tests/sample.e2e.ts',
  targets: [{
    name: 'android-sample',
    engine: mobile({ platform: 'android', device, session: 'inspector-sample-e2e', snapshot: 'full' }),
    app: { bundleId: 'com.androiduiinspector.sample', launchArguments: ['--es', 'mode', 'dynamic'] },
  }],
  workers: 1,
  retries: 0,
  timeout: 45000,
  launchTimeout: 20000,
  actionTimeout: 15000,
  assertionTimeout: 5000,
  cleanupTimeout: 15000,
  trace: 'on',
  video: 'off',
} satisfies E2EConfig;

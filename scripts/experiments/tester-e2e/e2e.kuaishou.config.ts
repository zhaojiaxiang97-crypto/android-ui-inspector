import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';

const device = process.env.E2E_DEVICE_NAME?.trim();
if (!device) throw new Error('请设置 E2E_DEVICE_NAME 为唯一手机名称。');
if (process.env.E2E_KUAISHOU_CONSENT !== 'settings-playback-back-once') {
  throw new Error('请先取得本次设置→播放设置→返回授权，再设置 E2E_KUAISHOU_CONSENT=settings-playback-back-once。');
}
if (process.env.E2E_TELEMETRY_DISABLED !== '1') {
  throw new Error('本地实验要求 E2E_TELEMETRY_DISABLED=1。');
}

export default {
  projectId: 'inspector-kuaishou-local-spike',
  tests: 'tests/kuaishou-navigation.e2e.ts',
  targets: [{
    name: 'android-kuaishou',
    engine: mobile({ platform: 'android', device, session: 'inspector-kuaishou-e2e', snapshot: 'full' }),
    app: { bundleId: 'com.smile.gifmaker' },
  }],
  workers: 1,
  retries: 0,
  timeout: 45000,
  launchTimeout: 20000,
  actionTimeout: 15000,
  assertionTimeout: 10000,
  cleanupTimeout: 15000,
  trace: 'off',
  video: 'off',
} satisfies E2EConfig;

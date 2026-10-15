import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('样例文字点击后变化，且新增控件可见', async ({ app, device, screen }) => {
  // 只重开自有样例以启用已有 dynamic 模式，不重启业务 App、不清数据。
  await app.open();
  await expect((await device.foregroundApp()).bundleId).toBe('com.androiduiinspector.sample');
  await expect(screen.getByText('RED CHILD')).toHaveCount(1);
  await expect(screen.getByText('RED CHILD')).toBeVisible();
  await expect(screen.getByText('UPDATED CHILD')).toHaveCount(0);
  await expect(screen.getByText('NEW VIEW')).toHaveCount(0);

  await screen.getByText('RED CHILD').tap();

  await expect((await device.foregroundApp()).bundleId).toBe('com.androiduiinspector.sample');
  await expect(screen.getByText('UPDATED CHILD')).toBeVisible();
  await expect(screen.getByText('NEW VIEW')).toBeVisible();
  await expect(screen.getByText('RED CHILD')).toHaveCount(0);
});

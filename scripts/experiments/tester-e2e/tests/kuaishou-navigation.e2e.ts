import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('快手设置：一次进入播放设置，确认后返回', async ({ app, device, screen }) => {
  // 不调用 app.open：保留用户当前页面及进程，不重新启动业务 App。
  const title = screen.getByTestId('com.smile.gifmaker:id/title_tv');
  const playback = screen.getByText('播放设置', { exact: true });
  await expect((await device.foregroundApp()).bundleId).toBe('com.smile.gifmaker');
  await expect(title).toHaveCount(1);
  await expect(title).toHaveText('设置');
  await expect(playback).toHaveCount(1);
  await expect(playback).toBeVisible();
  await app.screenshot('before-settings');

  await playback.tap();
  await expect((await device.foregroundApp()).bundleId).toBe('com.smile.gifmaker');
  await expect(title).toHaveText('播放设置');
  // 可选截图失败不能阻止已确认目标页后的返回；失败会留在步骤记录中。
  try { await app.screenshot('playback-settings'); }
  catch { console.warn('目标页截图失败；继续执行已授权的一次返回。'); }

  // 只有目标页断言通过才返回，不在 finally 中盲目发送输入。
  await device.back();
  await expect((await device.foregroundApp()).bundleId).toBe('com.smile.gifmaker');
  await expect(title).toHaveText('设置');
  await app.screenshot('returned-settings');
});

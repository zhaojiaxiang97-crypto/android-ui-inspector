import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readReport, renderReport, writeReport } from './report.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1d0AAAAASUVORK5CYII=', 'base64');
const digest = createHash('sha256').update(png).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'inspector-e2e-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.e2e', 'run');
  mkdirSync(join(directory, 'artifacts'), { recursive: true });
  const file = join(directory, 'report.json');
  const step = { id: 's1', api: 'locator.tap', label: '播放设置', status: 'passed', durationMs: 500,
    source: { file: 'tests/navigation.e2e.ts', line: 12 } };
  const attempt = { id: 'a1', index: 0, status: 'passed', durationMs: 1200, cleanup: 'complete',
    steps: [step], artifacts: [], secondaryErrors: [] };
  const document = { schemaVersion: 'report-1', run: { id: 'run1', status: 'passed', exitCode: 0,
    startedAt: '2026-10-08T14:00:00Z', finishedAt: '2026-10-08T14:00:02Z', serialGroups: [], errors: [],
    results: [{ id: 'test1', status: 'passed', titlePath: ['导航'], targetId: 'android', selected: true, attempts: [attempt] }] } };
  const save = () => writeFileSync(file, JSON.stringify(document));
  save();
  return { root, directory, file, document, attempt, step, save, evidenceRoot: join(root, '.e2e') };
}
const shot = (path = 'page.png') => ({ id: 'shot1', kind: 'screenshot', mediaType: 'image/png', path,
  producer: { kind: 'step', stepId: 's1' }, sha256: digest, size: png.length });

test('成功步骤与截图哈希关联；新目录输出，不覆盖原报告', t => {
  const f = fixture(t);
  f.attempt.artifacts.push(shot('中文 page.png'));
  writeFileSync(join(f.directory, 'artifacts', '中文 page.png'), png);
  f.save();
  const original = readFileSync(f.file);
  const first = writeReport(f.file, f.evidenceRoot);
  const second = writeReport(f.file, f.evidenceRoot);
  assert.notEqual(first, second);
  assert.deepEqual(readFileSync(f.file), original);
  const index = JSON.parse(readFileSync(join(first, 'index.json')));
  assert.equal(index.run.modelTokens, null);
  assert.equal(index.cases[0].attempts[0].artifacts[0].availability, 'verified');
  assert.equal(index.cases[0].attempts[0].artifacts[0].stepId, 's1');
  assert.match(readFileSync(join(first, 'index.html'), 'utf8'), /%E4%B8%AD%E6%96%87%20page\.png/);
});

test('失败位置、结构化错误及清理失败不丢失', t => {
  const f = fixture(t);
  f.document.run.status = 'failed';
  f.document.run.errors = [{ code: 'CLEANUP_FAILED', message: '会话关闭失败' }];
  f.document.run.results[0].status = 'failed';
  f.attempt.status = 'failed';
  f.attempt.cleanup = 'failed';
  f.step.status = 'failed';
  f.step.api = 'expect.toHaveText';
  f.step.error = { code: 'ASSERTION_FAILED', message: '标题未变化', source: f.step.source,
    details: { expected: '播放设置', observed: '设置' } };
  f.attempt.error = f.step.error;
  f.attempt.secondaryErrors = [{ code: 'SCREENSHOT_FAILED', message: '未获取截图' }];
  f.attempt.failure = { screenshot: 'shot1', candidates: ['设置'] };
  f.attempt.artifacts = [shot()];
  f.save();
  const index = readReport(f.file, f.evidenceRoot);
  const a = index.cases[0].attempts[0];
  assert.equal(index.run.status, 'failed');
  assert.equal(a.cleanup, 'failed');
  assert.deepEqual(a.steps[0].error.details, { expected: '播放设置', observed: '设置' });
  assert.equal(a.artifacts[0].failureEvidence, true);
  assert.equal(a.artifacts[0].availability, 'missing');
  assert.equal(a.secondaryErrors[0].code, 'SCREENSHOT_FAILED');
  const html = renderReport(index);
  assert.match(html, /navigation\.e2e\.ts:12/);
  assert.match(html, /异常步骤/);
  assert.match(html, /CLEANUP_FAILED/);
  assert.doesNotMatch(html, /<img /);
});

test('多次尝试保留早期失败，不用最后一次通过遮盖', t => {
  const f = fixture(t);
  f.document.run.results[0].status = 'flaky';
  f.attempt.status = 'failed';
  f.document.run.results[0].attempts.push({ ...f.attempt, id: 'a2', index: 1, status: 'passed' });
  f.save();
  const index = readReport(f.file, f.evidenceRoot);
  assert.deepEqual(index.cases[0].attempts.map(a => a.status), ['failed', 'passed']);
  assert.match(renderReport(index), /重试后通过/);
});

test('无截图、无执行记录、配置阶段失败不造视觉证据', t => {
  const f = fixture(t);
  assert.match(renderReport(readReport(f.file, f.evidenceRoot)), /无截图/);
  f.document.run.results[0].attempts = [];
  f.save();
  assert.match(renderReport(readReport(f.file, f.evidenceRoot)), /没有执行记录/);
  f.document.run.status = 'failed';
  f.document.run.errors = [{ code: 'CONFIG_FAILED', message: '配置无效' }];
  f.document.run.results = [];
  f.save();
  const html = renderReport(readReport(f.file, f.evidenceRoot));
  assert.match(html, /CONFIG_FAILED/);
  assert.match(html, /没有用例/);
});

test('页面文本、错误、源码及路径不能注入HTML', t => {
  const f = fixture(t);
  f.document.run.results[0].titlePath = ['<script>alert(1)</script>'];
  f.step.label = '" onmouseover="alert(2)';
  f.step.error = { message: '<img src=https://external.example onerror=alert(3)>' };
  f.step.source.file = '<svg onload=alert(4)>';
  f.save();
  const html = renderReport(readReport(f.file, f.evidenceRoot));
  assert.doesNotMatch(html, /<script>|<svg|<img src=https/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /default-src 'none'/);
});

test('截图越界、外链、符号链接、错哈希及非PNG均不加载', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'artifacts', 'page.png'), png);
  writeFileSync(join(f.root, 'outside.png'), png);
  symlinkSync(join(f.root, 'outside.png'), join(f.directory, 'artifacts', 'linked.png'));
  for (const path of ['../outside.png', '/outside.png', 'https://external.example/page.png', 'file:///outside.png', 'linked.png', 'page.html']) {
    f.attempt.artifacts = [shot(path)];
    f.save();
    assert.equal(readReport(f.file, f.evidenceRoot).cases[0].attempts[0].artifacts[0].href, null, path);
  }
  f.attempt.artifacts = [{ ...shot(), sha256: 'wrong' }];
  f.save();
  assert.equal(readReport(f.file, f.evidenceRoot).cases[0].attempts[0].artifacts[0].availability, 'mismatch');
  writeFileSync(join(f.directory, 'artifacts', 'page.png'), '<script>not png</script>');
  assert.equal(readReport(f.file, f.evidenceRoot).cases[0].attempts[0].artifacts[0].availability, 'invalid-file');
});

test('未知模型用量、截图缺少摘要或步骤关联保持未知', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'artifacts', 'page.png'), png);
  f.attempt.artifacts = [{ ...shot(), sha256: undefined, producer: { kind: 'step', stepId: 'unknown' } }];
  f.save();
  const index = readReport(f.file, f.evidenceRoot);
  assert.equal(index.run.modelTokens, null);
  assert.equal(index.cases[0].attempts[0].artifacts[0].availability, 'unverified');
  assert.equal(index.cases[0].attempts[0].artifacts[0].stepReferenceMissing, true);
});

test('拒绝越界报告、坏格式、未知版本、重复步骤与不支持的报告类型', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'outside.json'), JSON.stringify(f.document));
  assert.throws(() => readReport(join(f.root, 'outside.json'), f.evidenceRoot), /只整理/);
  writeFileSync(f.file, '{invalid');
  assert.throws(() => readReport(f.file, f.evidenceRoot), SyntaxError);
  f.document.schemaVersion = 'report-2';
  f.save();
  assert.throws(() => readReport(f.file, f.evidenceRoot), /report-1/);
  f.document.schemaVersion = 'report-1';
  f.document.run.serialGroups = [{}];
  f.save();
  assert.throws(() => readReport(f.file, f.evidenceRoot), /普通测试/);
  f.document.run.serialGroups = [];
  f.attempt.steps.push(f.step);
  f.save();
  assert.throws(() => readReport(f.file, f.evidenceRoot), /步骤编号重复/);
});

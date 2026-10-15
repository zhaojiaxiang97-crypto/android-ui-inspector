import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const path = relative(root, file); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const escape = value => String(value ?? '未知').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const list = (value, label) => {
  if (!Array.isArray(value) || value.length > 10000) throw new Error(`${label} 必须是长度不超过10000的数组。`);
  return value;
};
const errorInfo = error => error ? {
  category: error.category, code: error.code, message: error.message,
  phase: error.phase, source: error.source, details: error.details,
} : null;
const source = value => value ? { file: value.file, line: value.line, column: value.column } : null;

function screenshot(artifact, directory, stepIds) {
  if (typeof artifact.id !== 'string' || !artifact.id) throw new Error('附件缺少编号。');
  const item = { id: artifact.id, kind: artifact.kind, stepId: artifact.producer?.stepId ?? null,
    failureEvidence: false, availability: 'unsupported', href: null, sha256: null };
  if (item.stepId && !stepIds.has(item.stepId)) item.stepReferenceMissing = true;
  if (artifact.kind !== 'screenshot' || artifact.mediaType !== 'image/png') return item;
  const path = artifact.path;
  if (typeof path !== 'string' || !path.endsWith('.png') || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.')) {
    return { ...item, availability: 'invalid-path' };
  }
  const root = join(directory, 'artifacts');
  const file = resolve(root, path);
  if (!inside(root, file)) return { ...item, availability: 'invalid-path' };
  try {
    // 不跟随指向其他目录的链接，也不加载报告引用的网页、SVG或脚本。
    if (realpathSync(root) !== root || !inside(root, realpathSync(file))) return { ...item, availability: 'invalid-path' };
    const info = statSync(file);
    if (!info.isFile() || info.size > 10 * 1024 * 1024) return { ...item, availability: 'invalid-file' };
    const bytes = readFileSync(file);
    const digest = hash(bytes);
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { ...item, availability: 'invalid-file' };
    if ((artifact.size !== undefined && artifact.size !== bytes.length) || (artifact.sha256 !== undefined && artifact.sha256 !== digest)) {
      return { ...item, availability: 'mismatch', sha256: digest };
    }
    return { ...item, availability: artifact.sha256 ? 'verified' : 'unverified', sha256: digest,
      href: `../artifacts/${path.split('/').map(encodeURIComponent).join('/')}` };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...item, availability: 'missing' };
    return { ...item, availability: 'unreadable' };
  }
}

export function readReport(file, evidenceRoot = join(project, '.e2e')) {
  const root = realpathSync(evidenceRoot);
  const report = realpathSync(file);
  if (!inside(root, report)) throw new Error('只整理本地 .e2e 内的报告。');
  if (basename(report) !== 'report.json') throw new Error('请输入原始 report.json 文件。');
  if (!statSync(report).isFile() || statSync(report).size > 8 * 1024 * 1024) throw new Error('报告不是文件或超过8MB。');
  const bytes = readFileSync(report);
  const document = JSON.parse(bytes);
  const run = document.run;
  if (document.schemaVersion !== 'report-1' || !run || typeof run.status !== 'string' || typeof run.id !== 'string') {
    throw new Error('仅支持 e2e report-1 报告，缺失状态不能推断为通过。');
  }
  // 本轮只支持普通测试；串行组/探索/历史携带记录不静默丢弃。
  if (list(run.serialGroups, 'serialGroups').length || run.explore || run.carried) throw new Error('当前仅支持普通测试报告，不支持串行组、探索或历史携带报告。');
  const cases = list(run.results, 'results').map(result => {
    if (typeof result.status !== 'string') throw new Error('用例缺少状态。');
    const attempts = list(result.attempts, 'attempts').map(attempt => {
      if (typeof attempt.status !== 'string') throw new Error('尝试缺少状态。');
      const steps = list(attempt.steps, 'steps').map(step => {
        if (typeof step.id !== 'string' || typeof step.status !== 'string') throw new Error('步骤缺少编号或状态。');
        return { id: step.id, api: step.api, label: step.label, status: step.status, durationMs: step.durationMs,
          source: source(step.source), error: errorInfo(step.error) };
      });
      const stepIds = new Set(steps.map(step => step.id));
      if (stepIds.size !== steps.length) throw new Error('步骤编号重复。');
      const artifacts = list(attempt.artifacts, 'artifacts').map(artifact => screenshot(artifact, dirname(report), stepIds));
      if (new Set(artifacts.map(item => item.id)).size !== artifacts.length) throw new Error('附件编号重复。');
      const failure = attempt.failure ? { screenshot: attempt.failure.screenshot, screen: attempt.failure.screen,
        candidates: attempt.failure.candidates } : null;
      for (const artifact of artifacts) artifact.failureEvidence = artifact.id === failure?.screenshot;
      return { id: attempt.id, index: attempt.index, status: attempt.status, durationMs: attempt.durationMs,
        cleanup: attempt.cleanup ?? 'unknown', error: errorInfo(attempt.error),
        secondaryErrors: list(attempt.secondaryErrors, 'secondaryErrors').map(errorInfo), failure, steps, artifacts };
    });
    return { id: result.id, title: list(result.titlePath, 'titlePath').join(' / '), targetId: result.targetId,
      status: result.status, selected: result.selected, source: source(result.source), attempts };
  });
  return { schemaVersion: 'inspector-e2e-index-1', generatedAt: new Date().toISOString(),
    reportSha256: hash(bytes), run: { id: run.id, status: run.status, exitCode: run.exitCode,
      startedAt: run.startedAt, finishedAt: run.finishedAt, runner: run.runner,
      modelTokens: run.usage?.modelTokens ?? null, errors: list(run.errors, 'errors').map(errorInfo) }, cases };
}

const statuses = { passed: '通过', failed: '失败', timedout: '超时', interrupted: '中断', skipped: '跳过', flaky: '重试后通过', blocked: '阻塞' };
const availability = { verified: '截图哈希核对通过', unverified: '截图未提供原始摘要', missing: '截图文件缺失', mismatch: '截图与记录不一致', 'invalid-path': '截图路径拒绝', 'invalid-file': '不是有效的PNG附件', unreadable: '截图不可读取', unsupported: '附件类型暂不支持' };
const state = value => escape(statuses[value] ?? value);
const where = value => value ? escape(`${value.file ?? '未知文件'}:${value.line ?? '?'}`) : '未记录';
const errorHtml = error => error ? `<pre>${escape(JSON.stringify(error, null, 2))}</pre>` : '';

export function renderReport(index) {
  const cases = index.cases.map(result => `<section><h2>${escape(result.title)} · ${state(result.status)}</h2>
    <p>目标 ${escape(result.targetId)} · 源码 ${where(result.source)}</p>
    ${result.attempts.length ? '' : '<p class="warning">本用例没有执行记录，不作为通过证据。</p>'}
    ${result.attempts.map(attempt => {
      const screenshots = attempt.artifacts.filter(item => item.kind === 'screenshot');
      const failed = attempt.steps.filter(step => !['passed', 'skipped'].includes(step.status) || step.error);
      return `<article><h3>尝试 ${escape(attempt.index)} · ${state(attempt.status)} · ${escape(attempt.durationMs)} ms</h3>
        <p>清理 ${escape(attempt.cleanup)} · 步骤记录：点击 ${attempt.steps.filter(s => s.api === 'locator.tap').length} / 返回 ${attempt.steps.filter(s => s.api === 'device.back' || s.api === 'app.back').length}（不等同于设备实际输入次数）</p>
        ${failed.length ? `<p class="warning">异常步骤：${failed.map(s => `${escape(s.api)} · ${where(s.source)}`).join('；')}</p>` : ''}
        ${errorHtml(attempt.error)}${attempt.secondaryErrors.map(errorHtml).join('')}
        ${attempt.failure ? `<details open><summary>失败时证据引用</summary><pre>${escape(JSON.stringify(attempt.failure, null, 2))}</pre></details>` : ''}
        <table><thead><tr><th>步骤</th><th>结果</th><th>耗时</th><th>源码 / 错误</th></tr></thead><tbody>
        ${attempt.steps.map((step, i) => `<tr><td>${i + 1}. ${escape(step.api)}<small>${escape(step.label ?? '')}</small></td><td>${state(step.status)}</td><td>${escape(step.durationMs)} ms</td><td>${where(step.source)}${errorHtml(step.error)}</td></tr>`).join('')}
        </tbody></table><h3>截图与步骤关联</h3>
        ${screenshots.length ? `<div class="gallery">${screenshots.map(item => `<figure>
          ${item.href ? `<a href="${escape(item.href)}"><img loading="lazy" src="${escape(item.href)}" alt="本地测试截图"></a>` : ''}
          <figcaption>${item.failureEvidence ? '失败时截图 · ' : ''}${escape(availability[item.availability] ?? item.availability)} · ${escape(attempt.steps.find(s => s.id === item.stepId)?.label ?? item.stepId ?? '尝试级附件')}${item.stepReferenceMissing ? ' · 步骤引用缺失' : ''}</figcaption>
          </figure>`).join('')}</div>` : '<p class="warning">无截图；仅有步骤和断言，不是视觉验收。</p>'}
        <p>其他附件 ${attempt.artifacts.filter(item => item.kind !== 'screenshot').length} 个：索引保留编号，不加载日志、录像或远端链接。</p></article>`;
    }).join('')}</section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>UI 自动化测试报告</title><style>
    body{font:15px/1.6 system-ui,sans-serif;color:#dfe5ed;background:#171b21;margin:0;padding:28px;max-width:1200px;margin-inline:auto}
    h1,h2,h3{line-height:1.3}p,small,figcaption{color:#aab6c5}small{display:block;overflow-wrap:anywhere}
    section{border-top:1px solid #39414b;margin-top:28px}article{padding:12px 0}a{color:#9bbcff}
    table{width:100%;border-collapse:collapse}td,th{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #39414b;overflow-wrap:anywhere}
    th{color:#aab6c5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#20262f;padding:12px}.warning{color:#e6b978}
    .gallery{display:flex;gap:18px;flex-wrap:wrap}figure{margin:0;max-width:280px}img{max-width:100%;max-height:500px;border:1px solid #39414b}
    </style></head><body><h1>UI 自动化测试报告 · ${state(index.run.status)}</h1>
    <p>开始 ${escape(index.run.startedAt)} · 结束 ${escape(index.run.finishedAt)} · 模型 Token ${escape(index.run.modelTokens)}</p>
    <p>运行编号 ${escape(index.run.id)} · 源报告 SHA-256 ${escape(index.reportSha256)}</p>
    <p class="warning">仅整理已有本地数据，未操作手机。截图和错误可能含私人信息，不要直接公开；通过不等于长期稳定或旧故障已修复。</p>
    <p><a href="../report.json">原始报告</a> · <a href="index.json">诊断证据索引</a></p>
    ${index.run.errors.map(errorHtml).join('')}${cases || '<p class="warning">没有用例；查看运行级错误，不推断为通过。</p>'}</body></html>`;
}

export function writeReport(file, evidenceRoot) {
  const index = readReport(file, evidenceRoot);
  const directory = mkdtempSync(join(dirname(realpathSync(file)), 'summary-'));
  writeFileSync(join(directory, 'index.json'), JSON.stringify(index, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(directory, 'index.html'), renderReport(index), { flag: 'wx' });
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('用法：npm run report -- .e2e/本轮目录/report.json（只读旧结果，不运行手机测试）');
    const evidenceRoot = join(project, '.e2e');
    if (realpathSync(evidenceRoot) !== evidenceRoot) throw new Error('.e2e 不能是目录链接。');
    console.log(writeReport(resolve(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type RequestListener } from "node:http";
import { recognitionConfig, recognitionMetrics, assertRecognitionIdentity, compareRecognition, readHelperDump } from "../scripts/recognition-comparison";

const packageName = "com.example.sample";
const frame = { width: 100, height: 200, rotation: 0 as const };
const identity = { packageName, activityName: ".MainActivity", component: `${packageName}/.MainActivity`, activityRecordId: "abc", windowId: "def" };
const config = recognitionConfig.parse({ serial: "fixture", packageName, component: identity.component,
  targets: [{ name: "按钮", resourceId: "button", text: "继续" }] });
const node = (extra = "", children = "") => `<node package="${packageName}" class="View" bounds="[0,0][100,200]" ${extra}>${children}</node>`;
const button = (extra = "") => node(`resource-id="button" text="继续" clickable="true" ${extra}`);
const xml = (helper = false, children = button()) => `<hierarchy rotation="0">${node(helper
  ? 'window-id="7" window-type="application" window-focused="true"' : "", children)}</hierarchy>`;
const observation = (helper = false, children = button()) => ({ xml: xml(helper, children), target: identity, frame });

test("recognition configuration requires a fixed page and unique explicit targets", () => {
  assert.equal(config.runs, 3);
  for (const override of [{ runs: 6 }, { serial: "../device" }, { component: "com.other/.Page" }, { targets: [] },
    { targets: [{ name: "猜测" }] }, { targets: [config.targets[0], config.targets[0]] }, { helperTokenFile: "relative.token" }])
    assert.equal(recognitionConfig.safeParse({ ...config, ...override }).success, false);
});

test("helper selects the unique target window instead of silently taking the first root", () => {
  const combined = xml(true).replace('<hierarchy rotation="0">', '<hierarchy rotation="0"><node package="com.android.systemui" bounds="[0,0][100,20]"/>');
  const metrics = recognitionMetrics(combined, "helper", packageName, frame, config.targets);
  assert.equal(metrics.windowCount, 2);
  assert.equal(metrics.treeNodes, 2);
  assert.equal(metrics.targets[0].matches, 1);
  assert.equal(metrics.helperWindowId, "7");
  assert.throws(() => recognitionMetrics(combined, "fast", packageName, frame, config.targets));
  for (const change of [combined.replace('window-focused="true"', 'window-focused="false"'),
    combined.replace('window-type="application"', 'window-type="input_method"'),
    combined.replace('window-id="7"', 'window-id="unknown"'),
    combined.replace('<node package="com.android.systemui"', '<node window-focused="true" package="com.android.systemui"')])
    assert.throws(() => recognitionMetrics(change, "helper", packageName, frame, config.targets));
});

test("visible, locatable and semantic coverage exclude hidden, offscreen and foreign nodes", () => {
  const children = button('hint="输入提示" error="格式错误" state-description="不可用"')
    + button('visible-to-user="false"') + button().replace('[0,0][100,200]', '[100,0][110,20]')
    + button().replace('[0,0][100,200]', '[0,0][0,0]') + button().split(packageName).join('com.other');
  const metrics = recognitionMetrics(xml(true, children), "helper", packageName, frame, config.targets);
  assert.equal(metrics.treeNodes, 6);
  assert.equal(metrics.visibleNodes, 4);
  assert.equal(metrics.locatableNodes, 2);
  assert.equal(metrics.interactiveNodes, 1);
  assert.equal(metrics.foreignPackageNodes, 1);
  assert.deepEqual(metrics.semantics, { hint: 1, error: 1, "state-description": 1 });
  assert.equal(metrics.targets[0].matches, 1);
  assert.equal(recognitionMetrics(xml(false, button() + button()), "fast", packageName, frame, config.targets).targets[0].matches, 2);
  assert.equal(recognitionMetrics(xml(false, button().replace('text="继续"', 'text="其他"')), "fast", packageName, frame, config.targets).targets[0].matches, 0);
});

test("empty, malformed, entity, wrong package, rotation and oversized trees are refused", () => {
  for (const tree of ["", '<hierarchy rotation="0"/>', '<hierarchy rotation="0"><node></hierarchy>',
    xml().split(packageName).join("com.other"), xml().replace('rotation="0"', 'rotation="1"'),
    '<!DOCTYPE hierarchy [<!ENTITY injected "x">]>' + xml(), " ".repeat(8 * 1024 * 1024 + 1), xml(false, button().repeat(5001)),
    '<hierarchy rotation="0">' + '<node>'.repeat(210) + '</node>'.repeat(210) + '</hierarchy>'])
    assert.throws(() => recognitionMetrics(tree, "fast", packageName, frame, config.targets));
});

test("same activity name cannot substitute for the same instance, window or display", () => {
  assertRecognitionIdentity(identity, { ...identity }, frame, { ...frame });
  for (const changed of [{ activityRecordId: "old" }, { windowId: "other" }, { component: `${packageName}/.Other` }, { packageName: "com.other" }])
    assert.throws(() => assertRecognitionIdentity(identity, { ...identity, ...changed }, frame, frame));
  assert.throws(() => assertRecognitionIdentity(identity, identity, frame, { ...frame, rotation: 1 }));
  assert.throws(() => assertRecognitionIdentity(identity, identity, frame, { ...frame, width: 200 }));
});

test("complete-layout comparison detects missing containers, changed parentage and geometry", async () => {
  const strict = recognitionConfig.parse({ ...config, runs: 1, requireLayoutParity: true });
  for (const children of [button(), node('', '') + button(), node('', button().replace('[0,0][100,200]', '[0,0][90,200]'))]) {
    const result = await compareRecognition(strict, identity, frame, {
      fast: async () => observation(false, node('', button())), helper: async () => observation(true, children),
    });
    assert.equal(result.summary.fast.successful, 1); assert.equal(result.summary.helper.successful, 1);
    assert.equal(result.comparable, false); assert.equal(result.layoutParity[0].matched, false);
    assert.equal(result.validationError?.code, "layout-coverage");
  }
  const same = await compareRecognition(strict, identity, frame, {
    fast: async () => observation(false, node('', button())),
    helper: async () => observation(true, node('', button('hint="额外语义"'))),
  });
  assert.equal(same.comparable, true); assert.equal(same.layoutParity[0].matched, true);
});

test("semantic requirements bind to the unique selected target, not an unrelated node", async () => {
  const required = recognitionConfig.parse({ ...config, runs: 1,
    targets: [{ ...config.targets[0], helperAttributes: { hint: "Account name", error: "Required", "state-description": "Paused" } }] });
  for (const extra of ['', 'hint="Account name" error="Wrong" state-description="Paused"']) {
    const result = await compareRecognition(required, identity, frame, {
      fast: async () => observation(),
      helper: async () => observation(true, button(extra) + node('hint="Account name" error="Required" state-description="Paused"')),
    });
    assert.equal(result.attempts[0].error?.code, "semantic-coverage");
    assert.equal(result.comparable, false);
    assert.equal(result.summary.fast.successful, 1);
  }
  const good = await compareRecognition(required, identity, frame, {
    fast: async () => observation(), helper: async () => observation(true, button('hint="Account name" error="Required" state-description="Paused"')),
  });
  assert.equal(good.comparable, true);
  assert.deepEqual(good.attempts[0].metrics?.targets[0].attributes, { hint: "Account name", error: "Required", "state-description": "Paused" });
  assert.equal(good.attempts[1].metrics?.targets[0].attributes?.hint, null);
  assert.equal(recognitionConfig.safeParse({ ...required, targets: [{ ...required.targets[0], helperAttributes: {} }] }).success, false);
  assert.equal(recognitionConfig.safeParse({ ...required, targets: [{ ...required.targets[0], helperAttributes: { injected: "value" } }] }).success, false);
});

test("all calls and failures count; one failed helper request is never replaced by fast", async () => {
  let fastCalls = 0, helperCalls = 0;
  const result = await compareRecognition(config, identity, frame, {
    fast: async () => { fastCalls++; return observation(); },
    helper: async () => { if (++helperCalls === 2) throw new Error("断连"); return observation(true); },
  });
  assert.equal(fastCalls, 3); assert.equal(helperCalls, 3);
  assert.deepEqual(result.attempts.map(attempt => `${attempt.backend}-${attempt.run}`), ["helper-1", "fast-1", "fast-2", "helper-2", "helper-3", "fast-3"]);
  assert.equal(result.attempts.length, 6);
  assert.equal(result.summary.helper.attempts, 3);
  assert.equal(result.summary.helper.successRate, 2 / 3);
  assert.equal(result.summary.helper.maxSuccessStreak, 1);
  assert.equal(result.summary.helper.totalDurationMs, result.attempts.filter(attempt => attempt.backend === "helper").reduce((sum, attempt) => sum + attempt.durationMs, 0));
  assert.equal(result.comparable, false);
});

test("missing helper is unmeasured; missing targets and changed pages retain metrics and failures", async () => {
  const partial = await compareRecognition(config, identity, frame, { fast: async () => observation() });
  assert.equal(partial.comparable, false); assert.equal(partial.summary.helper.attempts, 0);
  assert.equal(partial.summary.helper.successRate, null); assert.equal(partial.summary.helper.medianDurationMs, null);
  let calls = 0;
  const result = await compareRecognition(config, identity, frame, {
    fast: async () => observation(false, ++calls === 2 ? button() + node('text="新增"') : button()),
    helper: async () => observation(true, button().replace('text="继续"', 'text="未命中"')),
  });
  assert.equal(result.summary.helper.successful, 0);
  assert.equal(result.attempts.find(attempt => attempt.backend === "fast" && attempt.run === 2)?.error?.code, "page-changed");
  assert.equal(result.attempts[0].error?.code, "target-coverage");
  assert.equal(result.attempts[0].metrics?.targets[0].matches, 0);
  const good = await compareRecognition(config, identity, frame, { fast: async () => observation(), helper: async () => observation(true) });
  assert.equal(good.comparable, true);
});

test("cancellation rejects a late result and prevents subsequent calls", async () => {
  const controller = new AbortController(); let calls = 0;
  const result = await compareRecognition(config, identity, frame, {
    helper: async () => { calls++; controller.abort(); return observation(true); },
    fast: async () => { calls++; return observation(); },
  }, controller.signal);
  assert.equal(calls, 1); assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].error?.code, "cancelled"); assert.equal(result.cancelled, true); assert.equal(result.comparable, false);
});

async function serve(handler: RequestListener, run: (port: number) => Promise<void>) {
  const server: Server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run((server.address() as { port: number }).port); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const token = "0123456789abcdef0123456789abcdef";
const payload = { success: true, xml: xml(true), truncated: false, width: 100, height: 200, rotation: 0, window_count: 1, node_count: 2 };

test("helper transport sends only one authenticated read request", async () => {
  let calls = 0;
  await serve((request, response) => {
    calls++; assert.equal(request.method, "GET"); assert.equal(request.url, "/dump?fields=xml");
    assert.equal(request.headers["x-artemis-token"], token);
    response.end(JSON.stringify(payload));
  }, async port => assert.deepEqual(await readHelperDump(port, token, AbortSignal.timeout(1000)), payload));
  assert.equal(calls, 1);
});

test("HTTP rejection, redirects, truncation, empty response and bad protocol never trigger retries", async () => {
  let calls = 0;
  const cases = ["401", "redirect", "bad-json", JSON.stringify({ ...payload, success: false }),
    JSON.stringify({ ...payload, truncated: true }), JSON.stringify({ ...payload, xml: "" }),
    JSON.stringify({ ...payload, rotation: 4 }), JSON.stringify({ ...payload, node_count: 5001 })];
  for (const value of cases) {
    await serve((_request, response) => {
      calls++;
      if (value === "401") { response.statusCode = 401; response.end(); }
      else if (value === "redirect") { response.writeHead(302, { Location: "/unexpected" }); response.end(); }
      else response.end(value);
    }, async port => { await assert.rejects(readHelperDump(port, token, AbortSignal.timeout(1000)), error => {
      if (value.includes('"success":false')) assert.equal((error as { code: string }).code, "helper-empty");
      if (value.includes('"truncated":true')) assert.equal((error as { code: string }).code, "helper-truncated");
      return true;
    }); });
  }
  assert.equal(calls, cases.length);
});

test("helper limits response bytes and respects the caller deadline", async () => {
  await serve((_request, response) => response.end(" ".repeat(8 * 1024 * 1024 + 1)), async port => {
    await assert.rejects(readHelperDump(port, token, AbortSignal.timeout(3000)), /8MiB/);
  });
  await serve(() => undefined, async port => {
    await assert.rejects(readHelperDump(port, token, AbortSignal.timeout(30)));
  });
  await assert.rejects(readHelperDump(0, token, AbortSignal.timeout(1000)), /端口/);
  await assert.rejects(readHelperDump(1234, "bad\r\nheader", AbortSignal.timeout(1000)), /令牌/);
});

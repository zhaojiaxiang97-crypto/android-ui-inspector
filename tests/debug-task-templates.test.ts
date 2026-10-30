import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDebugTaskTemplateStore } from "../electron/desktop/debug-task-templates";
import { debugTaskTemplateFile, MAX_DEBUG_TASK_TEMPLATE_BYTES } from "../shared/debug-task-templates";
import { debugTaskDefinition } from "../shared/debug-task";

const output = fileURLToPath(new URL("../.benchmarks/task-template-tests/", import.meta.url));
const definition = debugTaskDefinition.parse({ goal: "确认完成", finalConditions: [{ id: "done", selector: { text: "DONE" }, state: "visible" }] });
async function fixture(run: (path: string) => Promise<void>) {
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, "store-"));
  try { await run(join(directory, "templates.json")); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("templates persist full stages, update explicitly, reload, and delete without temporary leftovers", async () => fixture(async path => {
  const store = createDebugTaskTemplateStore(path);
  assert.deepEqual(await store.load(), { templates: [], error: null });
  const full = debugTaskDefinition.parse({ ...definition, checkpoints: [{ id: "ready", title: "准备", conditions: [
    { id: "ready", selector: { text: " READY ", resourceId: "app:id/ready" }, state: "enabled" },
    { id: "hidden", selector: { contentDesc: " Loading " }, state: "absent" },
  ] }] });
  const saved = await store.save({ name: "  完成检查  ", definition: full });
  assert.equal(saved.error, null); assert.equal(saved.templates.length, 1);
  const template = saved.templates[0];
  assert.equal(template.name, "完成检查"); assert.deepEqual(template.definition, full);
  assert.deepEqual(await createDebugTaskTemplateStore(path).load(), saved);
  const updated = await store.save({ id: template.id, name: "新版完成检查", definition: { ...full, goal: "修改目标" } });
  assert.equal(updated.error, null); assert.equal(updated.templates[0].id, template.id);
  assert.equal(updated.templates[0].createdAt, template.createdAt);
  assert.deepEqual(updated.templates[0].definition.checkpoints, full.checkpoints);
  assert.deepEqual(await readdir(dirname(path)), ["templates.json"]);
  assert.deepEqual(await store.remove(template.id), { templates: [], error: null });
  assert.deepEqual(await store.load(), { templates: [], error: null });
}));

test("templates reject invalid selectors, duplicate IDs, all task limits, unknown fields and stale updates", async () => fixture(async path => {
  const store = createDebugTaskTemplateStore(path);
  const saved = await store.save({ name: "已有模板", definition }); assert.equal(saved.error, null);
  const original = await readFile(path);
  const oversized = { ...definition, finalConditions: Array.from({ length: 10 }, (_, index) => ({ id: `item${index}`, state: "visible",
    selector: { resourceId: "r".repeat(512), text: "t".repeat(512), contentDesc: "d".repeat(512), className: "c".repeat(512) } })) };
  const invalid = [
    { name: "无条件", definition: { ...definition, finalConditions: [] } },
    { name: "空selector", definition: { ...definition, finalConditions: [{ id: "x", selector: {}, state: "visible" }] } },
    { name: "非精确", definition: { ...definition, finalConditions: [{ id: "x", selector: { textContains: "DONE" }, state: "visible" }] } },
    { name: "重复条件", definition: { ...definition, finalConditions: [...definition.finalConditions, ...definition.finalConditions] } },
    { name: "重复阶段", definition: { ...definition, checkpoints: Array.from({ length: 2 }, () => ({ id: "ready", title: "准备", conditions: definition.finalConditions })) } },
    { name: "太多阶段", definition: { ...definition, checkpoints: Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, title: "准备", conditions: [{ ...definition.finalConditions[0], id: `c${index}` }] })) } },
    { name: "太多最终条件", definition: { ...definition, finalConditions: Array.from({ length: 11 }, (_, index) => ({ ...definition.finalConditions[0], id: `c${index}` })) } },
    { name: "总条件超限", definition: { ...definition, checkpoints: Array.from({ length: 2 }, (_, stage) => ({ id: `s${stage}`, title: "准备", conditions: Array.from({ length: 10 }, (_, index) => ({ ...definition.finalConditions[0], id: `s${stage}c${index}` })) })) } },
    { name: "字节超限", definition: oversized },
    { name: "属性太长", definition: { ...definition, finalConditions: [{ id: "x", selector: { text: "中".repeat(513) }, state: "visible" }] } },
    { name: "", definition }, { name: "已有模板", definition },
    { name: "额外字段", definition, permission: true },
    { id: randomUUID(), name: "旧编号", definition },
  ];
  for (const request of invalid) {
    const result = await store.save(request); assert.ok(result.error, JSON.stringify(request));
    assert.deepEqual(await readFile(path), original);
  }
  assert.match((await store.save({ name: "字节超限", definition: oversized })).error!, /12KB/);
  assert.ok((await store.remove("not-uuid")).error);
  assert.ok((await store.remove(randomUUID())).error);
  assert.deepEqual(await readFile(path), original);
}));

test("concurrent template writes are serialized and count limit never evicts old templates", async () => fixture(async path => {
  const store = createDebugTaskTemplateStore(path);
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => store.save({ name: `模板${index}`, definition })));
  assert.ok(results.every(result => result.error === null));
  const before = await readFile(path);
  assert.equal((await store.load()).templates.length, 30);
  assert.match((await store.save({ name: "第31份", definition })).error!, /30/);
  assert.deepEqual(await readFile(path), before);
  const first = results[0].templates[0];
  assert.equal((await store.save({ id: first.id, name: "改名", definition })).error, null);
  assert.equal((await store.load()).templates.length, 30);
}));

test("bad, oversized and unknown-version files stay intact for load, save and delete", async () => fixture(async path => {
  const store = createDebugTaskTemplateStore(path);
  const validTemplate = { id: randomUUID(), name: "原模板", createdAt: "2026-10-12T01:00:00Z", updatedAt: "2026-10-12T01:00:00Z", definition };
  const invalidFiles = [
    Buffer.from("{broken"), Buffer.alloc(MAX_DEBUG_TASK_TEMPLATE_BYTES + 1, 32),
    Buffer.from(JSON.stringify({ version: 2, templates: [validTemplate] })),
    Buffer.from(JSON.stringify({ version: 1, templates: [validTemplate, { ...validTemplate, name: "重复编号" }] })),
    Buffer.from(JSON.stringify({ version: 1, templates: [{ ...validTemplate, definition: { ...definition, finalConditions: [] } }] })),
    Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]),
  ];
  for (const content of invalidFiles) {
    await writeFile(path, content);
    for (const result of [await store.load(), await store.save({ name: "新模板", definition }), await store.remove(validTemplate.id)]) {
      assert.ok(result.error); assert.deepEqual(result.templates, []);
      assert.deepEqual(await readFile(path), content);
    }
  }
}));

test("old definitions without checkpoints normalize in memory and files are not rewritten on read", async () => fixture(async path => {
  const raw = JSON.stringify({ version: 1, templates: [{ id: randomUUID(), name: "旧模板", createdAt: "2026-10-12T01:00:00Z", updatedAt: "2026-10-12T01:00:00Z",
    definition: { goal: definition.goal, finalConditions: definition.finalConditions } }] });
  await writeFile(path, raw);
  const loaded = await createDebugTaskTemplateStore(path).load();
  assert.equal(loaded.error, null); assert.deepEqual(loaded.templates[0].definition.checkpoints, []);
  assert.equal(await readFile(path, "utf8"), raw);
  assert.equal(debugTaskTemplateFile.safeParse({ version: 1, templates: loaded.templates }).success, true);
}));

test("non-file template paths are rejected without following or modifying them", async () => fixture(async path => {
  const store = createDebugTaskTemplateStore(path);
  await mkdir(path); assert.ok((await store.load()).error); assert.ok((await store.save({ name: "模板", definition })).error);
  assert.deepEqual(await readdir(path), []); await rm(path, { recursive: true });
  const target = join(dirname(path), "original.json"), original = "preserve this file";
  await writeFile(target, original); await symlink(target, path);
  assert.ok((await store.load()).error); assert.ok((await store.save({ name: "模板", definition })).error);
  assert.equal(await readFile(target, "utf8"), original);
}));

test("FIFO template paths fail promptly instead of waiting for a writer", { skip: process.platform === "win32", timeout: 2000 }, async () => fixture(async path => {
  execFileSync("mkfifo", [path]);
  const before = Date.now(), result = await createDebugTaskTemplateStore(path).load();
  assert.ok(result.error); assert.ok(Date.now() - before < 1000);
}));

test("external changes during an atomic save are kept and its temporary file is removed", async () => fixture(async path => {
  // Intercept the real filesystem boundary in an isolated process, avoiding timing-dependent watchers.
  const bundle = join(dirname(path), "store.cjs"), script = join(dirname(path), "race.cjs");
  execFileSync("bun", ["build", fileURLToPath(new URL("../electron/desktop/debug-task-templates.ts", import.meta.url)), "--outfile", bundle, "--target", "node", "--format", "cjs"], { stdio: "pipe" });
  await writeFile(script, `const assert = require("node:assert/strict"), fs = require("node:fs"), promises = require("node:fs/promises");
const path = ${JSON.stringify(path)}, originalWrite = promises.writeFile;
let external = null, changed = false;
promises.writeFile = async (...args) => { const result = await originalWrite(...args); if (external !== null && String(args[0]).endsWith(".tmp")) { changed = true; fs.writeFileSync(path, external); } return result; };
const { createDebugTaskTemplateStore } = require(${JSON.stringify(bundle)});
(async () => {
  const store = createDebugTaskTemplateStore(path), definition = ${JSON.stringify(definition)};
  assert.equal((await store.save({ name: "原模板", definition })).error, null);
  const original = fs.readFileSync(path, "utf8");
  for (const replacement of ["{a corrupt edit from another writer", original.replace("原模板", "外部改名")]) {
    external = replacement; changed = false;
    const result = await store.save({ name: "新模板", definition });
    assert.ok(changed); assert.ok(result.error); assert.equal(fs.readFileSync(path, "utf8"), replacement);
    assert.ok(fs.readdirSync(require("node:path").dirname(path)).every(name => !name.endsWith(".tmp")));
    external = null; fs.writeFileSync(path, original);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });`);
  execFileSync("node", [script], { stdio: "pipe", timeout: 10_000 });
}));

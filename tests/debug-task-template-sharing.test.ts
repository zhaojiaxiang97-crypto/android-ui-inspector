import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDebugTaskTemplateStore } from "../electron/desktop/debug-task-templates";
import { debugTaskDefinition } from "../shared/debug-task";
import { debugTaskTemplateFile, MAX_DEBUG_TASK_TEMPLATE_BYTES } from "../shared/debug-task-templates";

const output = fileURLToPath(new URL("../.benchmarks/template-sharing-tests/", import.meta.url));
const definition = debugTaskDefinition.parse({ goal: "完成", finalConditions: [{ id: "done", state: "visible", selector: { text: " DONE " } }] });
const metadata = () => ({ id: randomUUID(), createdAt: "2026-10-12T01:00:00Z", updatedAt: "2026-10-12T01:00:00Z" });
const template = (name: string) => ({ ...metadata(), name, definition });
const fragment = (name: string) => ({ ...metadata(), name, kind: "condition" as const, condition: definition.finalConditions[0] });
const bundle = (templates = [template("共享模板")], fragments = [fragment("共享条件")]) => ({ version: 1 as const, templates, fragments });
async function fixture(run: (path: string) => Promise<void>) {
  await mkdir(output, { recursive: true }); const directory = await mkdtemp(join(output, "library-"));
  try { await run(join(directory, "library.json")); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("fragments share safe storage, preserve templates, reject duplicate names, and survive reload/delete", async () => fixture(async path => {
  const store = createDebugTaskTemplateStore(path);
  await store.save({ name: "现有模板", definition });
  const condition = await store.saveFragment({ name: "单条件", kind: "condition", condition: definition.finalConditions[0] });
  assert.equal(condition.error, null);
  const stage = await store.saveFragment({ name: "完整阶段", kind: "stage", stage: { id: "ready", title: "准备", conditions: [
    definition.finalConditions[0], { id: "hidden", selector: { contentDesc: " Loading " }, state: "absent" },
  ] } });
  assert.equal(stage.error, null); assert.equal(stage.fragments.length, 2);
  assert.deepEqual(await createDebugTaskTemplateStore(path).loadFragments(), stage);
  const original = await readFile(path);
  for (const input of [
    { name: "单条件", kind: "condition", condition: definition.finalConditions[0] },
    { name: "无selector", kind: "condition", condition: { ...definition.finalConditions[0], selector: {} } },
    { name: "重复编号", kind: "stage", stage: { id: "x", title: "阶段", conditions: [definition.finalConditions[0], definition.finalConditions[0]] } },
    { name: "额外字段", kind: "condition", condition: definition.finalConditions[0], execute: "rm" },
  ]) { assert.ok((await store.saveFragment(input)).error); assert.deepEqual(await readFile(path), original); }
  assert.equal((await store.load()).templates[0].name, "现有模板");
  await store.remove((await store.load()).templates[0].id);
  assert.equal((await store.loadFragments()).fragments.length, 2);
  assert.equal((await store.removeFragment(condition.fragments[0].id)).fragments.length, 1);
  assert.ok((await store.removeFragment(condition.fragments[0].id)).error);
  assert.ok((await store.removeFragment("bad-id")).error);
  assert.deepEqual((await readdir(dirname(path))).filter(name => name.endsWith(".tmp")), []);
}));

test("JSON export/import is explicit data-only, keeps same-name local content and regenerates library IDs", async () => fixture(async path => {
  const store = createDebugTaskTemplateStore(path), source = join(dirname(path), "incoming.json"), exported = join(dirname(path), "exported.json");
  const local = await store.save({ name: "同名", definition });
  const localPiece = await store.saveFragment({ name: "同名条件", kind: "condition", condition: definition.finalConditions[0] });
  const incoming = bundle([{ ...template("同名"), definition: { ...definition, goal: "远端不能替换" } }, template("新的模板")], [fragment("同名条件"), fragment("新的片段")]);
  await writeFile(source, JSON.stringify(incoming));
  const imported = await store.importFile(source);
  assert.equal(imported.error, null); assert.deepEqual(imported.imported, { templates: 1, fragments: 1 });
  assert.deepEqual(imported.skipped, { templates: ["同名"], fragments: ["同名条件"] });
  assert.deepEqual(imported.templates[0], local.templates[0]); assert.deepEqual(imported.fragments[0], localPiece.fragments[0]);
  assert.notEqual(imported.templates[1].id, incoming.templates[1].id); assert.notEqual(imported.fragments[1].id, incoming.fragments[1].id);
  const exportedResult = await store.exportFile(exported); assert.equal(exportedResult.error, null);
  assert.equal(exportedResult.templateCount, 2); assert.equal(exportedResult.fragmentCount, 2);
  assert.deepEqual(debugTaskTemplateFile.parse(JSON.parse(await readFile(exported, "utf8"))), { version: 1, templates: imported.templates, fragments: imported.fragments });
  const before = await readFile(path), again = await store.importFile(exported);
  assert.deepEqual(again.imported, { templates: 0, fragments: 0 }); assert.equal(again.skipped.templates.length, 2);
  assert.deepEqual(await readFile(path), before);
  const targetStore = createDebugTaskTemplateStore(join(dirname(path), "fresh-library.json"));
  assert.deepEqual((await targetStore.importFile(exported)).imported, { templates: 2, fragments: 2 });
}));

test("invalid, oversized and unknown-version imports never partially change the local library", async () => fixture(async path => {
  const store = createDebugTaskTemplateStore(path), source = join(dirname(path), "bad.json"); await store.save({ name: "本机", definition });
  const before = await readFile(path);
  const invalid = [Buffer.from("{broken"), Buffer.alloc(MAX_DEBUG_TASK_TEMPLATE_BYTES + 1, 32), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]),
    Buffer.from(JSON.stringify({ ...bundle(), version: 2 })), Buffer.from(JSON.stringify({ ...bundle(), sessionId: randomUUID() })),
    Buffer.from(JSON.stringify(bundle([template("有效先到"), { ...template("坏模板"), definition: { ...definition, finalConditions: [] } }]))),
    Buffer.from(JSON.stringify({ version: 1, templates: [], fragments: [{ ...fragment("坏片段"), condition: { ...definition.finalConditions[0], selector: { textContains: "DONE" } } }] })),
    Buffer.from(JSON.stringify(bundle([], Array.from({ length: 61 }, (_, index) => fragment(`片段${index}`))))),
  ];
  for (const content of invalid) { await writeFile(source, content); const result = await store.importFile(source);
    assert.ok(result.error); assert.deepEqual(result.imported, { templates: 0, fragments: 0 }); assert.deepEqual(await readFile(path), before); }
  assert.ok((await store.importFile(join(dirname(path), "missing.json"))).error);
  await writeFile(source, JSON.stringify({ version: 1, templates: [template("旧文件")] }));
  assert.equal((await store.importFile(source)).error, null); assert.equal((await store.loadFragments()).fragments.length, 0);
}));

test("combined count/byte limits reject the entire batch including its otherwise-valid items", async () => fixture(async path => {
  const source = join(dirname(path), "incoming.json"), store = createDebugTaskTemplateStore(path);
  const cases = [
    { local: bundle(Array.from({ length: 29 }, (_, index) => template(`现有${index}`)), []), incoming: bundle([template("现有0"), template("新增A"), template("新增B")]), reason: /30/ },
    { local: bundle([], Array.from({ length: 59 }, (_, index) => fragment(`现有${index}`))), incoming: bundle([template("可用模板")], [fragment("现有0"), fragment("新增A"), fragment("新增B")]), reason: /60/ },
  ];
  for (const { local, incoming, reason } of cases) {
    await writeFile(path, JSON.stringify(local)); await writeFile(source, JSON.stringify(incoming)); const before = await readFile(path);
    assert.match((await store.importFile(source)).error!, reason); assert.deepEqual(await readFile(path), before);
  }
  const heavy = debugTaskDefinition.parse({ goal: "大模板", finalConditions: Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, state: "visible", selector: { text: "x".repeat(512), resourceId: "r".repeat(512), className: "c".repeat(512) } })) });
  const local = bundle(Array.from({ length: 30 }, (_, index) => ({ ...template(`现有${index}`), definition: heavy })), []);
  const incoming = { version: 1, templates: [], fragments: Array.from({ length: 30 }, (_, index) => ({ ...metadata(), name: `阶段${index}`, kind: "stage", stage: { id: "stage", title: "阶段", conditions: Array.from({ length: 10 }, (_, number) => ({ id: `c${number}`, state: "enabled", selector: { text: "x".repeat(512), className: "c".repeat(512) } })) } })) };
  assert.equal(debugTaskTemplateFile.safeParse(local).success, true); assert.equal(debugTaskTemplateFile.safeParse(incoming).success, true);
  await writeFile(path, JSON.stringify(local)); await writeFile(source, JSON.stringify(incoming)); const before = await readFile(path);
  assert.match((await store.importFile(source)).error!, /512KB/); assert.deepEqual(await readFile(path), before);
}));

test("queued cancellation, corrupt local libraries and unsafe export paths preserve every file", async () => fixture(async path => {
  const store = createDebugTaskTemplateStore(path), source = join(dirname(path), "source.json"), target = join(dirname(path), "target.json");
  await writeFile(source, JSON.stringify(bundle())); const controller = new AbortController();
  const save = store.save({ name: "本机", definition }), pendingImport = store.importFile(source, controller.signal), pendingExport = store.exportFile(target, controller.signal);
  controller.abort(); await save;
  assert.equal((await pendingImport).canceled, true); assert.equal((await pendingExport).canceled, true);
  const before = await readFile(path); await writeFile(target, "keep this file");
  assert.ok((await store.exportFile(path)).error); assert.deepEqual(await readFile(path), before);
  const directory = join(dirname(path), "not-a-file"); await mkdir(directory); assert.ok((await store.exportFile(directory)).error);
  const linked = join(dirname(path), "linked.json"); await symlink(target, linked); assert.ok((await store.exportFile(linked)).error); assert.equal(await readFile(target, "utf8"), "keep this file");
  await writeFile(path, "{corrupt local library");
  assert.ok((await store.importFile(source)).error); assert.ok((await store.exportFile(target)).error);
  assert.equal(await readFile(path, "utf8"), "{corrupt local library"); assert.equal(await readFile(target, "utf8"), "keep this file");
}));

test("abort before commit preserves files, abort after commit reports success, and new targets never clobber racers", async () => fixture(async path => {
  const compiled = join(dirname(path), "store.cjs"), script = join(dirname(path), "boundaries.cjs");
  execFileSync("bun", ["build", fileURLToPath(new URL("../electron/desktop/debug-task-templates.ts", import.meta.url)), "--outfile", compiled, "--target", "node", "--format", "cjs"], { stdio: "pipe" });
  await writeFile(script, `const assert = require("node:assert/strict"), fs = require("node:fs"), p = require("node:fs/promises"), path = require("node:path");
const library = ${JSON.stringify(path)}, source = path.join(path.dirname(library), "source.json"), target = path.join(path.dirname(library), "target.json"), originalWrite = p.writeFile, originalRename = p.rename, originalLink = p.link;
let controller = null, mode = "none";
p.writeFile = async (...args) => { const value = await originalWrite(...args); if (String(args[0]).endsWith(".tmp") && mode === "abort-before") controller.abort(); if (String(args[0]).endsWith(".tmp") && mode === "replace-target") fs.writeFileSync(target, "external replacement"); return value; };
p.rename = async (...args) => { const value = await originalRename(...args); if (mode === "abort-after") controller.abort(); return value; };
p.link = async (...args) => { if (mode === "race-new") fs.writeFileSync(args[1], "new external file"); const value = await originalLink(...args); if (mode === "abort-after") controller.abort(); return value; };
const { createDebugTaskTemplateStore } = require(${JSON.stringify(compiled)});
(async () => {
  const store = createDebugTaskTemplateStore(library), definition = ${JSON.stringify(definition)};
  await store.save({ name: "本机", definition }); const original = fs.readFileSync(library, "utf8");
  fs.writeFileSync(source, JSON.stringify(${JSON.stringify(bundle())}));
  controller = new AbortController(); mode = "abort-before";
  assert.equal((await store.importFile(source, controller.signal)).canceled, true); assert.equal(fs.readFileSync(library, "utf8"), original);
  fs.writeFileSync(target, "original export target"); controller = new AbortController();
  assert.equal((await store.exportFile(target, controller.signal)).canceled, true); assert.equal(fs.readFileSync(target, "utf8"), "original export target");
  mode = "replace-target"; assert.ok((await store.exportFile(target)).error); assert.equal(fs.readFileSync(target, "utf8"), "external replacement");
  mode = "abort-after"; controller = new AbortController(); const committed = await store.importFile(source, controller.signal); assert.equal(committed.canceled, false); assert.equal(committed.error, null); assert.equal(committed.imported.templates, 1);
  controller = new AbortController(); const exported = await store.exportFile(target, controller.signal); assert.equal(exported.canceled, false); assert.equal(exported.error, null);
  fs.unlinkSync(target); mode = "race-new"; assert.ok((await store.exportFile(target)).error); assert.equal(fs.readFileSync(target, "utf8"), "new external file");
  assert.ok(fs.readdirSync(path.dirname(library)).every(name => !name.endsWith(".tmp")));
})().catch(error => { console.error(error); process.exitCode = 1; });`);
  execFileSync("node", [script], { stdio: "pipe", timeout: 10_000 });
}));

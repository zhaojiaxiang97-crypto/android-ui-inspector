import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { debugTaskFragmentSaveInput, debugTaskTemplateFile, debugTaskTemplateId, debugTaskTemplateSaveInput,
  MAX_DEBUG_TASK_TEMPLATE_BYTES, MAX_DEBUG_TASK_TEMPLATES, MAX_DEBUG_TASK_FRAGMENTS, type DebugTaskFragmentsResult,
  type DebugTaskTemplateExportResult, type DebugTaskTemplateImportResult, type DebugTaskTemplatesResult } from "../../shared/debug-task-templates";

export type DebugTaskTemplateStore = {
  load(): Promise<DebugTaskTemplatesResult>;
  save(input: unknown): Promise<DebugTaskTemplatesResult>;
  remove(id: unknown): Promise<DebugTaskTemplatesResult>;
  loadFragments(): Promise<DebugTaskFragmentsResult>;
  saveFragment(input: unknown): Promise<DebugTaskFragmentsResult>;
  removeFragment(id: unknown): Promise<DebugTaskFragmentsResult>;
  importFile(sourcePath: string, signal?: AbortSignal): Promise<DebugTaskTemplateImportResult>;
  exportFile(targetPath: string, signal?: AbortSignal): Promise<DebugTaskTemplateExportResult>;
};
type Library = ReturnType<typeof debugTaskTemplateFile.parse>;
const fileIdentity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const templateFailure = (error: string): DebugTaskTemplatesResult => ({ templates: [], error });
const fragmentFailure = (error: string): DebugTaskFragmentsResult => ({ fragments: [], error });

async function readBoundedFile(path: string) {
  if (!isAbsolute(path)) throw new Error("文件路径必须为绝对路径。");
  let handle;
  try {
    const pathStat = await lstat(path);
    if (!pathStat.isFile()) throw new Error("模板路径必须是普通文件，不能是目录、链接或设备文件。");
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("模板路径必须是普通文件。");
    if (before.size > BigInt(MAX_DEBUG_TASK_TEMPLATE_BYTES)) throw new Error("模板与片段文件超过512KB。");
    const bytes = Buffer.alloc(MAX_DEBUG_TASK_TEMPLATE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_DEBUG_TASK_TEMPLATE_BYTES) throw new Error("模板与片段文件超过512KB。");
    const after = await handle.stat({ bigint: true }), pathStat = await lstat(path, { bigint: true });
    if (!pathStat.isFile() || fileIdentity(before) !== fileIdentity(after) || fileIdentity(after) !== fileIdentity(pathStat)) {
      throw new Error("文件读取期间已被修改，请重新读取。");
    }
    const content = bytes.subarray(0, length);
    return { content, identity: `${fileIdentity(after)}:${createHash("sha256").update(content).digest("hex")}` };
  } finally { await handle.close(); }
}

function parseLibrary(content: Buffer): Library {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  const parsed = debugTaskTemplateFile.safeParse(value);
  if (!parsed.success) throw new Error("模板文件内容无效：" + parsed.error.issues.map(issue => issue.message).join("；"));
  return parsed.data;
}
function serialize(file: Library) {
  const content = JSON.stringify(debugTaskTemplateFile.parse(file), null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > MAX_DEBUG_TASK_TEMPLATE_BYTES) throw new Error("模板与片段文件超过512KB。");
  return content;
}
async function atomicWrite(path: string, content: string, identity: string | null, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    signal?.throwIfAborted();
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    signal?.throwIfAborted();
    if (((await readBoundedFile(path))?.identity ?? null) !== identity) throw new Error("文件已被外部修改；原文件已保留，请重新读取后再保存。");
    signal?.throwIfAborted();
    if (identity === null) await link(temporary, path); else await rename(temporary, path);
    // A successful commit remains successful if cancellation arrives afterwards.
  } finally { await unlink(temporary).catch(() => {}); }
}

export function createDebugTaskTemplateStore(filePath: string): DebugTaskTemplateStore {
  if (!isAbsolute(filePath)) throw new Error("模板文件路径必须为绝对路径。");
  let queue: Promise<unknown> = Promise.resolve();
  const locked = <T>(operation: () => Promise<T>, failed: (error: string) => T): Promise<T> => {
    const result = queue.then(operation).catch((error: unknown) => failed(errorText(error)));
    queue = result;
    return result;
  };
  async function read() {
    try {
      const receipt = await readBoundedFile(filePath);
      return { file: receipt ? parseLibrary(receipt.content) : debugTaskTemplateFile.parse({ version: 1, templates: [] }), identity: receipt?.identity ?? null };
    } catch (error) { throw new Error(`无法读取任务模板；原文件已保留。${errorText(error)}`); }
  }
  const write = (file: Library, identity: string | null, signal?: AbortSignal) => atomicWrite(filePath, serialize(file), identity, signal);

  return {
    load: () => locked(async () => ({ templates: (await read()).file.templates, error: null }), templateFailure),
    save: input => locked(async () => {
      const parsed = debugTaskTemplateSaveInput.safeParse(input);
      if (!parsed.success) throw new Error("模板未保存：" + parsed.error.issues.map(issue => issue.message).join("；"));
      const { file, identity } = await read(), request = parsed.data;
      const index = request.id ? file.templates.findIndex(item => item.id === request.id) : -1;
      if (request.id && index < 0) throw new Error("模板已不存在，请重新读取或另存为新模板。");
      if (file.templates.some(item => item.name === request.name && item.id !== request.id)) throw new Error("模板名已存在，请更换名称或先读取该模板。");
      if (index < 0 && file.templates.length >= MAX_DEBUG_TASK_TEMPLATES) throw new Error("最多保存30份模板，请先删除不用的模板。");
      const now = new Date().toISOString();
      const template = { id: request.id ?? randomUUID(), name: request.name, definition: request.definition,
        createdAt: index < 0 ? now : file.templates[index].createdAt, updatedAt: now };
      if (index < 0) file.templates.push(template); else file.templates[index] = template;
      await write(file, identity);
      return { templates: file.templates, error: null };
    }, templateFailure),
    remove: id => locked(async () => {
      const parsed = debugTaskTemplateId.safeParse(id);
      if (!parsed.success) throw new Error("模板编号无效。");
      const { file, identity } = await read();
      if (!file.templates.some(item => item.id === parsed.data)) throw new Error("模板已不存在，请重新读取。");
      file.templates = file.templates.filter(item => item.id !== parsed.data);
      await write(file, identity);
      return { templates: file.templates, error: null };
    }, templateFailure),
    loadFragments: () => locked(async () => ({ fragments: (await read()).file.fragments, error: null }), fragmentFailure),
    saveFragment: input => locked(async () => {
      const parsed = debugTaskFragmentSaveInput.safeParse(input);
      if (!parsed.success) throw new Error("片段未保存：" + parsed.error.issues.map(issue => issue.message).join("；"));
      const { file, identity } = await read(), request = parsed.data;
      if (file.fragments.some(item => item.name === request.name)) throw new Error("片段名已存在，请更换名称；本机片段已保留。");
      if (file.fragments.length >= MAX_DEBUG_TASK_FRAGMENTS) throw new Error("最多保存60份片段，请先删除不用的片段。");
      const now = new Date().toISOString();
      file.fragments.push({ ...request, id: randomUUID(), createdAt: now, updatedAt: now });
      await write(file, identity);
      return { fragments: file.fragments, error: null };
    }, fragmentFailure),
    removeFragment: id => locked(async () => {
      const parsed = debugTaskTemplateId.safeParse(id);
      if (!parsed.success) throw new Error("片段编号无效。");
      const { file, identity } = await read();
      if (!file.fragments.some(item => item.id === parsed.data)) throw new Error("片段已不存在，请重新读取。");
      file.fragments = file.fragments.filter(item => item.id !== parsed.data);
      await write(file, identity);
      return { fragments: file.fragments, error: null };
    }, fragmentFailure),
    importFile: (sourcePath, signal) => locked<DebugTaskTemplateImportResult>(async () => {
      signal?.throwIfAborted();
      const source = await readBoundedFile(sourcePath);
      signal?.throwIfAborted();
      if (!source) throw new Error("所选 JSON 文件已不存在。");
      const incoming = parseLibrary(source.content), { file, identity } = await read();
      signal?.throwIfAborted();
      const skipped = { templates: [] as string[], fragments: [] as string[] };
      const newTemplates = incoming.templates.filter(item => {
        if (!file.templates.some(local => local.name === item.name)) return true;
        skipped.templates.push(item.name); return false;
      });
      const newFragments = incoming.fragments.filter(item => {
        if (!file.fragments.some(local => local.name === item.name)) return true;
        skipped.fragments.push(item.name); return false;
      });
      if (file.templates.length + newTemplates.length > MAX_DEBUG_TASK_TEMPLATES) throw new Error("导入后超过30份模板，整批未导入；请先删除不用的模板。");
      if (file.fragments.length + newFragments.length > MAX_DEBUG_TASK_FRAGMENTS) throw new Error("导入后超过60份片段，整批未导入；请先删除不用的片段。");
      file.templates.push(...newTemplates.map(item => ({ ...item, id: randomUUID() })));
      file.fragments.push(...newFragments.map(item => ({ ...item, id: randomUUID() })));
      const content = serialize(file);
      signal?.throwIfAborted();
      if (newTemplates.length || newFragments.length) await atomicWrite(filePath, content, identity, signal);
      return { canceled: false, filePath: sourcePath, templates: file.templates, fragments: file.fragments,
        imported: { templates: newTemplates.length, fragments: newFragments.length }, skipped, error: null };
    }, error => ({ canceled: Boolean(signal?.aborted), filePath: null, templates: [], fragments: [],
      imported: { templates: 0, fragments: 0 }, skipped: { templates: [], fragments: [] }, error: signal?.aborted ? null : error })),
    exportFile: (targetPath, signal) => locked<DebugTaskTemplateExportResult>(async () => {
      signal?.throwIfAborted();
      if (resolve(targetPath) === resolve(filePath)) throw new Error("请选择本机模板库以外的导出路径。");
      const { file } = await read();
      signal?.throwIfAborted();
      const target = await readBoundedFile(targetPath);
      signal?.throwIfAborted();
      await atomicWrite(targetPath, serialize(file), target?.identity ?? null, signal);
      return { canceled: false, filePath: targetPath, templateCount: file.templates.length, fragmentCount: file.fragments.length, error: null };
    }, error => ({ canceled: Boolean(signal?.aborted), filePath: null, templateCount: 0, fragmentCount: 0, error: signal?.aborted ? null : error })),
  };
}

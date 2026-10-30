import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { debugTaskTemplateFile, debugTaskTemplateId, debugTaskTemplateSaveInput,
  MAX_DEBUG_TASK_TEMPLATE_BYTES, MAX_DEBUG_TASK_TEMPLATES, type DebugTaskTemplatesResult } from "../../shared/debug-task-templates";

export type DebugTaskTemplateStore = {
  load(): Promise<DebugTaskTemplatesResult>;
  save(input: unknown): Promise<DebugTaskTemplatesResult>;
  remove(id: unknown): Promise<DebugTaskTemplatesResult>;
};
const fileIdentity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

export function createDebugTaskTemplateStore(filePath: string): DebugTaskTemplateStore {
  if (!isAbsolute(filePath)) throw new Error("模板文件路径必须为绝对路径。");
  let queue: Promise<unknown> = Promise.resolve();
  const locked = (operation: () => Promise<DebugTaskTemplatesResult>) => {
    const result = queue.then(operation).catch((error: unknown) => ({ templates: [], error: error instanceof Error ? error.message : String(error) }));
    queue = result;
    return result;
  };

  async function read(): Promise<{ file: ReturnType<typeof debugTaskTemplateFile.parse>; identity: string | null }> {
    let handle;
    try {
      const pathStat = await lstat(filePath);
      if (!pathStat.isFile()) throw new Error("模板路径必须是普通文件，不能是目录、链接或设备文件。");
      handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: { version: 1 as const, templates: [] }, identity: null };
      throw error;
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new Error("模板路径必须是普通文件。");
      if (before.size > BigInt(MAX_DEBUG_TASK_TEMPLATE_BYTES)) throw new Error("模板文件超过512KB。");
      // Read one bounded buffer: a growing or oversized file cannot bypass the byte limit.
      const bytes = Buffer.alloc(MAX_DEBUG_TASK_TEMPLATE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_DEBUG_TASK_TEMPLATE_BYTES) throw new Error("模板文件超过512KB。");
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
      const parsed = debugTaskTemplateFile.safeParse(value);
      if (!parsed.success) throw new Error("模板文件内容无效：" + parsed.error.issues.map(issue => issue.message).join("；"));
      const after = await handle.stat({ bigint: true }), pathStat = await lstat(filePath, { bigint: true });
      if (!pathStat.isFile() || fileIdentity(before) !== fileIdentity(after) || fileIdentity(after) !== fileIdentity(pathStat)) {
        throw new Error("模板文件读取期间已被修改，请重新读取。");
      }
      return { file: parsed.data, identity: `${fileIdentity(after)}:${createHash("sha256").update(bytes.subarray(0, length)).digest("hex")}` };
    } catch (error) {
      throw new Error(`无法读取任务模板；原文件已保留。${error instanceof Error ? error.message : String(error)}`);
    } finally { await handle.close(); }
  }

  async function write(file: ReturnType<typeof debugTaskTemplateFile.parse>, identity: string | null) {
    const parsed = debugTaskTemplateFile.parse(file);
    const content = JSON.stringify(parsed, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > MAX_DEBUG_TASK_TEMPLATE_BYTES) throw new Error("模板文件超过512KB。");
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      if ((await read()).identity !== identity) throw new Error("模板文件已被外部修改；原文件已保留，请重新读取后再保存。");
      await rename(temporary, filePath);
    } finally { await unlink(temporary).catch(() => {}); }
  }

  return {
    load: () => locked(async () => ({ templates: (await read()).file.templates, error: null })),
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
    }),
    remove: id => locked(async () => {
      const parsed = debugTaskTemplateId.safeParse(id);
      if (!parsed.success) throw new Error("模板编号无效。");
      const { file, identity } = await read();
      if (!file.templates.some(item => item.id === parsed.data)) throw new Error("模板已不存在，请重新读取。");
      file.templates = file.templates.filter(item => item.id !== parsed.data);
      await write(file, identity);
      return { templates: file.templates, error: null };
    }),
  };
}

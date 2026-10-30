/** Never choose an arbitrary PID from a multi-process or malformed reply. */
export function parseAppPid(code: number | null, output: string): number {
  const value = output.trim();
  if (code !== 0 || !/^[1-9]\d{0,9}$/.test(value)) throw new Error("无法确认目标 App 的唯一主进程");
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) throw new Error("目标 App 进程号无效");
  return pid;
}

export function parseAppPids(code: number | null, output: string): number[] {
  const values = output.trim().split(/\s+/);
  if (values.length > 8) throw new Error("目标 App 进程数量异常");
  const pids = values.map(value => parseAppPid(code, value));
  if (new Set(pids).size !== pids.length) throw new Error("目标 App 进程号重复");
  return pids;
}

/** Forked helpers may temporarily keep the App cmdline; Activity owner is authoritative. */
export function selectActivityPid(pids: number[], section: string): number {
  const owner = /^ACTIVITY\s+\S+\s+\S+\s+pid=([1-9]\d*)\b/.exec(section.trimStart())?.[1];
  if (!owner || !pids.includes(Number(owner))) throw new Error("前台窗口进程与 App 进程列表不一致，未建立连接");
  return parseAppPid(0, owner);
}

/** Android cmdline is NUL-terminated, sometimes with extra trailing padding. */
export function verifyAppProcessName(code: number | null, output: Buffer, packageName: string): void {
  if (code !== 0 || output.length === 0 || output.length > 4096
      || output.toString("utf8").split("\0", 1)[0] !== packageName) {
    throw new Error("调试进程不属于目标 App，未建立连接；请重新采集");
  }
}

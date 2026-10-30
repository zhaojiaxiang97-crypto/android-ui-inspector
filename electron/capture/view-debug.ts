import { decodeViewHierarchy } from "./view-hierarchy";
import { connectJdwp as connect, requestChunk } from "./jdwp-transport";
import { utf16be, parseWindowNames, matchesViewRoot, parseCapturedViewLayers } from "./view-protocol";

/** Resolve the ViewDebug window name without exporting the full hierarchy. */
export async function probeWindowName(port: number, rootRefs: readonly string[], signal?: AbortSignal) {
  const { socket, reader } = await connect(port, signal);
  try {
    const names = parseWindowNames(await requestChunk(socket, reader, 1, "VULW"));
    if (names.length > 32) throw new Error("Debug 窗口数量异常。");
    let selected: string | null = null;
    let sequence = 2;
    for (const name of names) {
      const encodedName = utf16be(name);
      const request = Buffer.alloc(8 + encodedName.length);
      request.writeUInt32BE(1, 0);
      request.writeUInt32BE(name.length, 4);
      encodedName.copy(request, 8);
      // Identity-only probe: enough to match the window, no property export.
      const dump = Buffer.concat([request, Buffer.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])]);
      const hierarchy = (await requestChunk(socket, reader, sequence++, "VURT", dump)).toString("utf8");
      const rootRef = hierarchy.trimStart().split(/\s/)[0];
      if (!rootRefs.some((expected) => matchesViewRoot(expected, rootRef))) continue;
      if (selected) throw new Error("多个 Debug 窗口匹配当前控件树，请关闭弹窗后重新采集。");
      selected = name;
    }
    if (!selected) throw new Error("Debug 窗口与当前控件树不一致，请重新采集。");
    return selected;
  } finally {
    socket.destroy();
  }
}

export type ViewHierarchyTiming = {
  connectMs: number; windowsMs: number; probeMs: number; exportMs: number; decodeMs: number;
  probeRequests: number; exportRequests: number; totalMs: number;
  success: boolean; phase: "connect" | "windows" | "probe" | "export" | "decode" | "identity" | "complete";
};

export async function captureViewLayers(port: number, options: { rootRefs: readonly string[]; onHierarchy: (hierarchy: string, windowName: string) => void | Promise<void>; onHierarchyTiming?: (timing: ViewHierarchyTiming) => void; onBatchTiming?: (timing: { waitMs: number; readMs: number; parseMs: number; bytes: number; layers: number; images: number }) => void; skipImages?: boolean | (() => boolean); signal?: AbortSignal }) {
  const started = performance.now();
  const timing: ViewHierarchyTiming = { connectMs: 0, windowsMs: 0, probeMs: 0, exportMs: 0, decodeMs: 0,
    probeRequests: 0, exportRequests: 0, totalMs: 0, success: false, phase: "connect" };
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  let published = false;
  const publish = () => {
    if (published) return;
    published = true; timing.totalMs = performance.now() - started;
    // Observational sink: diagnostics must not change capture or cleanup behavior.
    try { options.onHierarchyTiming?.({ ...timing }); } catch { /* ignore sink failure */ }
  };
  const measure = async <T>(key: "connectMs" | "windowsMs" | "probeMs" | "exportMs", action: () => Promise<T>) => {
    const at = performance.now();
    try { return await action(); } finally { timing[key] += performance.now() - at; }
  };
  try {
    connection = await measure("connectMs", () => connect(port, options.signal));
    const { socket, reader } = connection;
    timing.phase = "windows";
    const names = parseWindowNames(await measure("windowsMs", () => requestChunk(socket, reader, 1, "VULW")));
    if (names.length > 32) throw new Error("Debug 窗口数量异常。");
    let selected: { request: Buffer; name: string } | null = null;
    let sequence = 2;
    timing.phase = "probe";
    for (const name of names) {
      const encodedName = utf16be(name);
      const request = Buffer.alloc(8 + encodedName.length);
      request.writeUInt32BE(1, 0);
      request.writeUInt32BE(name.length, 4);
      encodedName.copy(request, 8);
      // Probe identities without exporting every unrelated window's properties.
      const dump = Buffer.concat([request, Buffer.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])]);
      timing.probeRequests++;
      const hierarchy = (await measure("probeMs", () => requestChunk(socket, reader, sequence++, "VURT", dump))).toString("utf8");
      const rootRef = hierarchy.trimStart().split(/\s/)[0];
      if (!options.rootRefs.some((expected) => matchesViewRoot(expected, rootRef))) continue;
      if (selected) throw new Error("多个 Debug 窗口匹配当前控件树，请关闭弹窗后重新采集。");
      selected = { request, name };
    }
    if (!selected) throw new Error("Debug 窗口与当前控件树不一致，请重新采集。");
    // Legacy reflection becomes prohibitively slow after the first JDWP attach.
    // V2 calls View.encode directly; do not retry a malformed V2 dump with legacy.
    const dump = Buffer.concat([selected.request, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1])]);
    let hierarchy: string;
    const exportHierarchy = async () => {
      timing.phase = "export"; timing.exportRequests++;
      const bytes = await measure("exportMs", () => requestChunk(socket, reader, sequence++, "VURT", dump));
      timing.phase = "decode";
      const at = performance.now();
      try { return decodeViewHierarchy(bytes); } finally { timing.decodeMs += performance.now() - at; }
    };
    try {
      hierarchy = await exportHierarchy();
    } catch (error) {
      if (!(error instanceof Error && /Debug V2/.test(error.message))) throw error;
      // A page can redraw while Android encodes the tree; retry only this small request.
      hierarchy = await exportHierarchy();
    }
    timing.phase = "identity";
    if (!options.rootRefs.some((expected) => matchesViewRoot(expected, hierarchy.trimStart().split(/\s/)[0]))) throw new Error("Debug 窗口身份已变化，请重新采集。");
    timing.success = true; timing.phase = "complete"; publish();
    await options.onHierarchy(hierarchy, selected.name);
    if (typeof options.skipImages === "function" ? options.skipImages() : options.skipImages) return [];
    selected.request.writeUInt32BE(2, 0);
    let waitMs = 0, readMs = 0, bytes = 0;
    const batch = await requestChunk(socket, reader, sequence, "VURT", selected.request, (wait, read, size) => { waitMs = wait; readMs = read; bytes = size; });
    const parseStarted = performance.now();
    const layers = parseCapturedViewLayers(batch);
    options.onBatchTiming?.({ waitMs, readMs, parseMs: performance.now() - parseStarted, bytes, layers: layers.length, images: layers.filter((layer) => Boolean(layer.imageDataUrl)).length });
    return layers;
  } finally {
    publish();
    connection?.socket.destroy();
  }
}

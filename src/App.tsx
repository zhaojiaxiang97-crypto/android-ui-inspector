import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import type { AdbProbeResult, ExportFormat, StoredSnapshot, UiNode, UiSnapshot } from "../shared/types";
import { filterTree, flattenNodes, nodeDisplayLabel } from "../shared/tree-utils";
import { UiTree } from "./components/UiTree";
import { ScreenshotPreview } from "./components/ScreenshotPreview";

function formatCheckedAt(date: Date | null) {
  if (!date) return "尚未检查";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function stateLabel(state: string) {
  if (state === "device") return "已授权";
  if (state === "unauthorized") return "待授权";
  if (state === "offline") return "离线";
  return state;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function dumpModeLabel(mode: UiSnapshot["hierarchyDumpMode"]) {
  if (mode === "full") return "完整 hierarchy";
  if (mode === "compressed") return "压缩 hierarchy";
  return "hierarchy 模式未知";
}

function countVirtualAccessibilityNodes(root: UiNode) {
  let count = 0;
  const pending = [root];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const node = pending[cursor];
    if (node.className?.includes("$VirtualChild")) count += 1;
    pending.push(...node.children);
  }
  return count;
}

function virtualAccessibilityHint(node: UiNode) {
  if (!node.className?.includes("$VirtualChild")) return null;
  return "这是 VirtualChild 虚拟无障碍节点。UIAutomator 只能读取应用暴露的 Accessibility 信息，不一定等于 QML、Compose 或 WebView 内部的全部绘制控件。";
}

function xpathLiteral(value: string) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;

  const parts = value.split("'");
  const expressions: string[] = [];
  parts.forEach((part, index) => {
    if (part) expressions.push(`'${part}'`);
    if (index < parts.length - 1) expressions.push(`"'"`);
  });
  return `concat(${expressions.join(",")})`;
}

function findNodePath(root: UiNode, targetId: string) {
  const path: UiNode[] = [];

  function visit(node: UiNode): boolean {
    path.push(node);
    if (node.id === targetId) return true;

    for (const child of node.children) {
      if (visit(child)) return true;
    }

    path.pop();
    return false;
  }

  return visit(root) ? path : null;
}

function xpathForNode(root: UiNode, node: UiNode) {
  const className = node.className ?? "*";
  if (node.resourceId) return `//${className}[@resource-id=${xpathLiteral(node.resourceId)}]`;
  if (node.contentDesc) return `//${className}[@content-desc=${xpathLiteral(node.contentDesc)}]`;
  if (node.text) return `//${className}[@text=${xpathLiteral(node.text)}]`;

  const path = findNodePath(root, node.id);
  if (!path) return `//${className}`;

  return `//${path.map((item, index) => {
    const itemClass = item.className ?? "*";
    if (index === 0) return itemClass;
    const rawIndex = Number.parseInt(item.id.split("/").pop() ?? "", 10);
    return `${itemClass}[${Number.isFinite(rawIndex) ? rawIndex + 1 : 1}]`;
  }).join("/")}`;
}

function uiSelectorForNode(node: UiNode) {
  const parts = ["new UiSelector()"];
  if (node.className) parts.push(`.className(${JSON.stringify(node.className)})`);
  if (node.resourceId) {
    parts.push(`.resourceId(${JSON.stringify(node.resourceId)})`);
  } else if (node.text) {
    parts.push(`.text(${JSON.stringify(node.text)})`);
  } else if (node.contentDesc) {
    parts.push(`.description(${JSON.stringify(node.contentDesc)})`);
  }
  if (node.index !== null) parts.push(`.index(${node.index})`);
  return parts.join("");
}

function adbTapCommand(serial: string, node: UiNode) {
  if (!node.bounds) return "当前节点没有有效 bounds";
  const x = Math.round((node.bounds.left + node.bounds.right) / 2);
  const y = Math.round((node.bounds.top + node.bounds.bottom) / 2);
  return `adb -s ${JSON.stringify(serial)} shell input tap ${x} ${y}`;
}

function nodeJson(node: UiNode) {
  return JSON.stringify(node, null, 2);
}

type SnapshotDiff = {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  changes: SnapshotChange[];
};

type SnapshotFieldChange = {
  field: string;
  previous: string | null;
  current: string | null;
};

type SnapshotChange = {
  id: string;
  label: string;
  kind: "added" | "removed" | "changed";
  fields: string[];
  details: SnapshotFieldChange[];
};

type SavedSnapshot = StoredSnapshot & {
  diff: SnapshotDiff | null;
};

function diffValue(value: string | boolean | null) {
  return value === null ? null : String(value);
}

function changedNodeFields(previous: UiNode, current: UiNode) {
  const details: SnapshotFieldChange[] = [];
  const compare = (field: string, previousValue: string | boolean | null, currentValue: string | boolean | null) => {
    if (previousValue !== currentValue) {
      details.push({ field, previous: diffValue(previousValue), current: diffValue(currentValue) });
    }
  };

  compare("class", previous.className, current.className);
  compare("package", previous.package, current.package);
  compare("text", previous.text, current.text);
  compare("resource-id", previous.resourceId, current.resourceId);
  compare("content-desc", previous.contentDesc, current.contentDesc);
  compare("bounds", previous.bounds?.raw ?? null, current.bounds?.raw ?? null);
  compare("clickable", previous.clickable, current.clickable);
  compare("enabled", previous.enabled, current.enabled);
  compare("focusable", previous.focusable, current.focusable);
  compare("focused", previous.focused, current.focused);
  compare("scrollable", previous.scrollable, current.scrollable);
  compare("selected", previous.selected, current.selected);
  compare("visible-to-user", previous.visibleToUser, current.visibleToUser);
  return details;
}

function compareNodeTrees(previous: UiNode, current: UiNode): SnapshotDiff {
  const before = flattenNodes(previous);
  const after = flattenNodes(current);
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  const changes: SnapshotChange[] = [];

  function recordChange(change: SnapshotChange) {
    if (changes.length < 200) changes.push(change);
  }

  after.forEach((node, id) => {
    const previousNode = before.get(id);
    if (!previousNode) {
      added += 1;
      recordChange({ id, label: nodeDisplayLabel(node), kind: "added", fields: [], details: [] });
    } else {
      const details = changedNodeFields(previousNode, node);
      if (details.length === 0) {
        unchanged += 1;
      } else {
        changed += 1;
        recordChange({
          id,
          label: nodeDisplayLabel(node),
          kind: "changed",
          fields: details.map((detail) => detail.field),
          details,
        });
      }
    }
  });
  before.forEach((node, id) => {
    if (!after.has(id)) {
      removed += 1;
      recordChange({ id, label: nodeDisplayLabel(node), kind: "removed", fields: [], details: [] });
    }
  });

  return { added, removed, changed, unchanged, changes };
}

function diffSummary(diff: SnapshotDiff) {
  return `+${diff.added} / -${diff.removed} / ${diff.changed} 项属性变化`;
}

function addSnapshotDiffs(entries: StoredSnapshot[]): SavedSnapshot[] {
  let previous: StoredSnapshot | null = null;
  return entries.map((entry) => {
    const previousRoot = previous?.snapshot.serial === entry.snapshot.serial ? previous.snapshot.root : null;
    const diff = previousRoot && entry.snapshot.root ? compareNodeTrees(previousRoot, entry.snapshot.root) : null;
    previous = entry;
    return { ...entry, diff };
  });
}

function formatSnapshotTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function changeKindLabel(kind: SnapshotChange["kind"]) {
  if (kind === "added") return "新增";
  if (kind === "removed") return "删除";
  return "变化";
}

function App() {
  const [probe, setProbe] = useState<AdbProbeResult | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<UiSnapshot | null>(null);
  const [selectedNode, setSelectedNode] = useState<UiNode | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [treeQuery, setTreeQuery] = useState("");
  const [interactiveOnly, setInteractiveOnly] = useState(false);
  const [identifiedOnly, setIdentifiedOnly] = useState(false);
  const [treeSession, setTreeSession] = useState(0);
  const [treeRevealRequest, setTreeRevealRequest] = useState(0);
  const [savedSnapshots, setSavedSnapshots] = useState<SavedSnapshot[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);
  const [snapshotStoreError, setSnapshotStoreError] = useState<string | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null);
  const [diffExportStatus, setDiffExportStatus] = useState<string | null>(null);
  const [latestDiff, setLatestDiff] = useState<SnapshotDiff | null>(null);
  const [diffExpanded, setDiffExpanded] = useState(false);

  const refreshDevices = useCallback(async () => {
    setLoading(true);
    setRuntimeError(null);

    try {
      const result = await window.electronApi.probeAdb();
      setProbe(result);
      setCheckedAt(new Date());
    } catch (error) {
      setRuntimeError(
        typeof error === "string"
          ? error
          : "无法连接到 Electron 后端，请使用桌面应用启动。",
      );
      setCheckedAt(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  const inspectDevice = useCallback(async (serial: string) => {
    setTreeSession((value) => value + 1);
    setSelectedSerial(serial);
    setSnapshot(null);
    setSelectedNode(null);
    setInspectionError(null);
    setCopyStatus(null);
    setExportStatus(null);
    setTreeQuery("");
    setInteractiveOnly(false);
    setIdentifiedOnly(false);
    setSnapshotStatus(null);
    setLatestDiff(null);
    setDiffExpanded(false);
    setInspectionLoading(true);

    try {
      const result = await window.electronApi.inspectDevice(serial);
      setSnapshot(result);
      setSelectedNode(result.root);
      if (result.error) {
        setInspectionError(result.error);
      }
    } catch (error) {
      setInspectionError(
        typeof error === "string" ? error : "读取 UI hierarchy 失败，请确认设备仍保持连接。",
      );
    } finally {
      setInspectionLoading(false);
    }
  }, []);

  const closeInspector = useCallback(() => {
    setSelectedSerial(null);
    setSnapshot(null);
    setSelectedNode(null);
    setInspectionError(null);
    setCopyStatus(null);
    setExportStatus(null);
    setSnapshotStatus(null);
    setLatestDiff(null);
    setDiffExpanded(false);
  }, []);

  const handleScreenshotSelect = useCallback((node: UiNode) => {
    setSelectedNode(node);
    setTreeQuery("");
    setInteractiveOnly(false);
    setIdentifiedOnly(false);
    setTreeRevealRequest((value) => value + 1);
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    let active = true;
    async function restoreSnapshots() {
      setSnapshotsLoading(true);
      try {
        const result = await window.electronApi.loadSnapshots();
        if (!active) return;
        setSnapshotStoreError(result.error);
        setSavedSnapshots(result.error ? [] : addSnapshotDiffs(result.snapshots));
      } catch {
        if (active) {
          setSnapshotStoreError("读取本地快照失败");
          setSavedSnapshots([]);
        }
      } finally {
        if (active) setSnapshotsLoading(false);
      }
    }

    void restoreSnapshots();
    return () => {
      active = false;
    };
  }, []);

  const devices = probe?.devices ?? [];
  const readyDevices = useMemo(
    () => devices.filter((device) => device.state === "device"),
    [devices],
  );
  const hasAdb = Boolean(probe?.adbPath);
  const statusTone = runtimeError || probe?.error ? "danger" : readyDevices.length ? "success" : "neutral";
  const detailNode = selectedNode ?? snapshot?.root ?? null;
  const virtualNodeCount = useMemo(
    () => snapshot?.root ? countVirtualAccessibilityNodes(snapshot.root) : 0,
    [snapshot?.root],
  );
  const detailAttributes = useMemo(
    () => Object.entries(detailNode?.attributes ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [detailNode],
  );
  const hasTreeFilter = Boolean(treeQuery.trim()) || interactiveOnly || identifiedOnly;
  const clearTreeFilter = useCallback(() => {
    setTreeQuery("");
    setInteractiveOnly(false);
    setIdentifiedOnly(false);
  }, []);
  const filteredRoot = useMemo(
    () => snapshot?.root
      ? filterTree(snapshot.root, { query: treeQuery, interactiveOnly, identifiedOnly })
      : null,
    [identifiedOnly, interactiveOnly, snapshot?.root, treeQuery],
  );
  const filteredNodeCount = useMemo(() => filteredRoot ? flattenNodes(filteredRoot).size : 0, [filteredRoot]);
  const selectorData = useMemo(() => snapshot?.root && detailNode
    ? {
        xpath: xpathForNode(snapshot.root, detailNode),
        uiSelector: uiSelectorForNode(detailNode),
        adbTap: adbTapCommand(snapshot.serial, detailNode),
        json: nodeJson(detailNode),
      }
    : null, [snapshot?.root, snapshot?.serial, detailNode]);

  const copyValue = useCallback(async (label: string, value: string) => {
    try {
      await window.electronApi.copyText(value);
      setCopyStatus(`${label} 已复制`);
    } catch {
      setCopyStatus(`${label} 复制失败`);
    }
  }, []);

  const exportCurrentSnapshot = useCallback(async (format: ExportFormat) => {
    if (!snapshot) return;

    const data = format === "json"
      ? JSON.stringify({
          serial: snapshot.serial,
          nodeCount: snapshot.nodeCount,
          xmlSize: snapshot.xmlSize,
          root: snapshot.root,
        }, null, 2)
      : format === "xml"
        ? snapshot.rawXml ?? ""
        : snapshot.screenshotDataUrl ?? "";

    if (!data) {
      setExportStatus(`当前没有可导出的 ${format.toUpperCase()} 内容`);
      return;
    }

    setExportStatus("正在准备导出…");
    try {
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      const result = await window.electronApi.exportSnapshot({
        format,
        data,
        defaultFileName: `android-ui-inspector-${stamp}.${format}`,
      });
      if (result.canceled) {
        setExportStatus(null);
      } else if (result.error) {
        setExportStatus(result.error);
      } else {
        setExportStatus(`已保存：${result.filePath}`);
      }
    } catch {
      setExportStatus("导出失败，请重试");
    }
  }, [snapshot]);

  const exportLatestDiff = useCallback(async () => {
    if (!latestDiff || !snapshot) return;

    setDiffExportStatus("正在准备差异导出…");
    try {
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      const result = await window.electronApi.exportSnapshot({
        format: "json",
        data: JSON.stringify({
          exportedAt: new Date().toISOString(),
          serial: snapshot.serial,
          currentNodeCount: snapshot.nodeCount,
          diff: latestDiff,
        }, null, 2),
        defaultFileName: `android-ui-inspector-diff-${stamp}.json`,
      });
      if (result.canceled) {
        setDiffExportStatus(null);
      } else if (result.error) {
        setDiffExportStatus(result.error);
      } else {
        setDiffExportStatus(`差异已保存：${result.filePath}`);
      }
    } catch {
      setDiffExportStatus("差异导出失败，请重试");
    }
  }, [latestDiff, snapshot]);

  const saveCurrentSnapshot = useCallback(async () => {
    if (!snapshot?.root) {
      setSnapshotStatus("当前没有可保存的 UI 快照");
      return;
    }

    setSnapshotStatus("正在保存本地快照…");
    try {
      const result = await window.electronApi.saveSnapshot({
        capturedAt: new Date().toISOString(),
        snapshot,
      });
      if (result.error) {
        setSnapshotStoreError(result.error);
        setSnapshotStatus(result.error);
        return;
      }

      const records = addSnapshotDiffs(result.snapshots);
      const newest = records[records.length - 1];
      setSavedSnapshots(records);
      setSnapshotStoreError(null);
      setLatestDiff(newest?.diff ?? null);
      setDiffExpanded(false);
      setSnapshotStatus(newest ? `已保存本地快照 ${newest.id.slice(0, 8)}` : "已保存本地快照");
    } catch {
      setSnapshotStoreError("保存本地快照失败");
      setSnapshotStatus("保存本地快照失败");
    }
  }, [snapshot]);

  const clearSavedSnapshots = useCallback(async () => {
    setSnapshotStatus("正在清空本地快照…");
    try {
      const result = await window.electronApi.clearSnapshots();
      if (result.error) {
        setSnapshotStoreError(result.error);
        setSnapshotStatus(result.error);
        return;
      }
      setSavedSnapshots([]);
      setSnapshotStoreError(null);
      setLatestDiff(null);
      setDiffExpanded(false);
      setSnapshotStatus("已清空本地快照");
    } catch {
      setSnapshotStoreError("清空本地快照失败");
      setSnapshotStatus("清空本地快照失败");
    }
  }, []);

  const viewSavedSnapshot = useCallback((entry: SavedSnapshot) => {
    setTreeSession((value) => value + 1);
    setSelectedSerial(entry.snapshot.serial);
    setSnapshot(entry.snapshot);
    setSelectedNode(entry.snapshot.root);
    setInspectionError(entry.snapshot.error);
    setCopyStatus(null);
    setExportStatus(null);
    setDiffExportStatus(null);
    setTreeQuery("");
    setInteractiveOnly(false);
    setIdentifiedOnly(false);
    setLatestDiff(entry.diff);
    setDiffExpanded(false);
    setSnapshotStatus(`正在查看历史快照 ${entry.id.slice(0, 8)}`);
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <div>
            <p className="eyebrow">ANDROID TOOLING</p>
            <h1>UI Inspector</h1>
          </div>
          <span className="alpha-badge">ALPHA</span>
        </div>

        <div className="topbar-meta">
          <span className="connection-dot" />
          <span>本机工作区</span>
          <button
            className="refresh-button"
            type="button"
            onClick={() => void refreshDevices()}
            disabled={loading}
          >
            <span className={loading ? "refresh-icon spinning" : "refresh-icon"}>↻</span>
            {loading ? "检查中" : "刷新设备"}
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="hero-section">
          <div>
            <p className="section-kicker">STEP 01 / DEVICE BRIDGE</p>
            <h2>先把设备接进来。</h2>
            <p className="hero-copy">
              通过 ADB 建立稳定连接，后续才能读取 UI 层级、截图并定位到具体控件。
            </p>
          </div>
          <div className="hero-orbit" aria-hidden="true">
            <div className="orbit-ring ring-one" />
            <div className="orbit-ring ring-two" />
            <div className="orbit-core">ADB</div>
            <span className="orbit-node node-one" />
            <span className="orbit-node node-two" />
            <span className="orbit-node node-three" />
          </div>
        </section>

        <section className="metrics-grid" aria-label="连接状态概览">
          <article className="metric-card accent-card">
            <span className="metric-label">可用设备</span>
            <strong>{readyDevices.length}</strong>
            <span className="metric-caption">可开始检查 UI</span>
          </article>
          <article className="metric-card">
            <span className="metric-label">检测到</span>
            <strong>{devices.length}</strong>
            <span className="metric-caption">包含待授权设备</span>
          </article>
          <article className="metric-card">
            <span className="metric-label">ADB 状态</span>
            <strong className="metric-status">{hasAdb ? "READY" : "MISSING"}</strong>
            <span className="metric-caption">{probe?.adbVersion ?? "等待检测"}</span>
          </article>
        </section>

        <section className={`status-banner ${statusTone}`}>
          <div className="status-icon" aria-hidden="true">
            {statusTone === "success" ? "✓" : statusTone === "danger" ? "!" : "·"}
          </div>
          <div className="status-content">
            <strong>
              {runtimeError || probe?.error
                ? "ADB 还没有准备好"
                : readyDevices.length
                  ? `${readyDevices.length} 台设备已就绪`
                  : "等待 Android 设备连接"}
            </strong>
            <span>
              {runtimeError || probe?.error ||
                (readyDevices.length
                  ? "设备已通过授权，可以进入 UI 层级检查。"
                  : "连接 USB 并开启 USB 调试，应用会自动识别设备。")}
            </span>
          </div>
          <span className="last-checked">最后检查 {formatCheckedAt(checkedAt)}</span>
        </section>

        <div className="content-grid">
          <section className="panel device-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">CONNECTED TARGETS</p>
                <h3>设备列表</h3>
              </div>
              <span className="count-pill">{devices.length.toString().padStart(2, "0")}</span>
            </div>

            {devices.length > 0 ? (
              <div className="device-list">
                {devices.map((device) => (
                  <article className="device-card" key={device.serial}>
                    <div className="device-avatar">{device.model?.slice(0, 1).toUpperCase() ?? "A"}</div>
                    <div className="device-details">
                      <div className="device-name-row">
                        <h4>{device.model ?? "Android device"}</h4>
                        <span className={`device-state ${device.state}`}>{stateLabel(device.state)}</span>
                      </div>
                      <p>{device.serial}</p>
                      <span className="device-product">{device.product ?? "USB / ADB target"}</span>
                    </div>
                    <button
                      className="inspect-button"
                      type="button"
                      onClick={() => void inspectDevice(device.serial)}
                      disabled={device.state !== "device" || inspectionLoading}
                    >
                      检查 UI <span>→</span>
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-illustration" aria-hidden="true">
                  <div className="phone-shape"><span /><span /><span /></div>
                  <div className="empty-cable" />
                </div>
                <h4>{runtimeError || probe?.error ? "无法找到 ADB" : "还没有发现设备"}</h4>
                <p>
                  {runtimeError || probe?.error
                    ? "请确认 Platform-Tools 已安装，并从 Electron 桌面应用启动。"
                    : "插入 Android 手机后点击右上角刷新。首次连接时，请在手机上允许 USB 调试。"}
                </p>
                <button className="secondary-button" type="button" onClick={() => void refreshDevices()} disabled={loading}>
                  {loading ? "重新检查中" : "重新检查"}
                </button>
              </div>
            )}
          </section>

          <aside className="panel setup-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">QUICK SETUP</p>
                <h3>连接前准备</h3>
              </div>
              <span className="setup-index">01—03</span>
            </div>
            <ol className="setup-list">
              <li>
                <span className="step-number">01</span>
                <div><strong>打开开发者选项</strong><p>设置 → 关于手机 → 连续点击版本号</p></div>
              </li>
              <li>
                <span className="step-number">02</span>
                <div><strong>开启 USB 调试</strong><p>在开发者选项中打开 USB 调试</p></div>
              </li>
              <li>
                <span className="step-number">03</span>
                <div><strong>允许这台电脑</strong><p>在手机弹窗中确认 RSA 授权</p></div>
              </li>
            </ol>
            <div className="setup-note">
              <span className="note-icon">i</span>
              <p>当前版本只读取设备信息，不会修改手机数据。</p>
            </div>
          </aside>
        </div>
        {selectedSerial && (
          <section className="panel inspector-panel">
            <div className="inspector-heading">
              <div>
                <p className="section-kicker">UIAUTOMATOR HIERARCHY</p>
                <h3>界面层级</h3>
              </div>
              <div className="inspector-heading-meta">
                <span>{snapshot ? `${snapshot.nodeCount} nodes · ${formatBytes(snapshot.xmlSize)} · ${dumpModeLabel(snapshot.hierarchyDumpMode)}` : "读取中"}</span>
                <button
                  className="close-button inspector-refresh"
                  type="button"
                  onClick={() => void inspectDevice(selectedSerial)}
                  disabled={inspectionLoading}
                >
                  {inspectionLoading ? "读取中" : "刷新 UI"}
                </button>
                <button className="close-button" type="button" onClick={closeInspector}>返回设备</button>
              </div>
            </div>

            {inspectionLoading ? (
              <div className="inspection-placeholder">
                <span className="loading-orbit" />
                <h4>正在读取 UI hierarchy</h4>
                <p>执行 uiautomator dump，并从设备拉取当前页面结构。</p>
              </div>
            ) : inspectionError || snapshot?.error ? (
              <div className="inspection-placeholder error-placeholder">
                <div className="error-mark">!</div>
                <h4>读取失败</h4>
                <p>{inspectionError || snapshot?.error}</p>
                <button className="secondary-button" type="button" onClick={() => void inspectDevice(selectedSerial)}>
                  再试一次
                </button>
              </div>
            ) : snapshot?.root ? (
              <>
                {snapshot.warning && <div className="snapshot-warning">{snapshot.warning}</div>}
                {virtualNodeCount > 0 && (
                  <div className="hierarchy-note">
                    当前 hierarchy 包含 {virtualNodeCount} 个 VirtualChild 虚拟无障碍节点。它们只代表应用暴露的可访问性信息，不保证包含所有实际绘制控件。
                  </div>
                )}
                <div className="snapshot-toolbar">
                  <div className="snapshot-toolbar-info">
                    <span>本地快照：{savedSnapshots.length} 份</span>
                    {snapshotsLoading && <span className="tree-hint">正在读取本地记录…</span>}
                    {latestDiff ? (
                      <>
                        <span className="snapshot-diff">较上一份：{diffSummary(latestDiff)}</span>
                        <button className="diff-toggle" type="button" onClick={() => setDiffExpanded((value) => !value)}>
                          {diffExpanded ? "收起明细" : "查看明细"}
                        </button>
                      </>
                    ) : !snapshotsLoading && <span className="tree-hint">保存后可比较下一次刷新</span>}
                    {snapshotStatus && <span className="snapshot-status">{snapshotStatus}</span>}
                    {diffExportStatus && <span className="snapshot-export-status">{diffExportStatus}</span>}
                    {snapshotStoreError && <span className="snapshot-store-error">{snapshotStoreError}</span>}
                  </div>
                  <div className="snapshot-actions">
                    <button className="close-button" type="button" onClick={() => void saveCurrentSnapshot()} disabled={snapshotsLoading}>保存快照</button>
                    <button className="close-button" type="button" onClick={() => void clearSavedSnapshots()} disabled={snapshotsLoading || (savedSnapshots.length === 0 && !snapshotStoreError)}>清空记录</button>
                  </div>
                </div>
                {savedSnapshots.length > 0 && (
                  <div className="snapshot-history">
                    <div className="snapshot-history-heading">
                      <span>最近保存</span>
                      <span>最多保留 30 份</span>
                    </div>
                    <div className="snapshot-history-list">
                      {savedSnapshots.slice(-6).reverse().map((entry) => (
                        <button className="snapshot-history-item" type="button" key={entry.id} onClick={() => viewSavedSnapshot(entry)}>
                          <code>{formatSnapshotTime(entry.capturedAt)}</code>
                          <span>{entry.snapshot.nodeCount} nodes</span>
                          <span className="tree-hint">{entry.snapshot.serial}</span>
                          {entry.diff && <span className="snapshot-diff">{diffSummary(entry.diff)}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {latestDiff && diffExpanded && (
                  <div className="snapshot-diff-details">
                    <div className="snapshot-history-heading">
                      <span>节点变化明细</span>
                      <div className="diff-heading-actions">
                        <span>最多展示 200 项</span>
                        <button className="diff-toggle" type="button" onClick={() => void exportLatestDiff()}>导出差异 JSON</button>
                      </div>
                    </div>
                    {latestDiff.changes.length === 0 ? (
                      <p className="diff-empty">未发现节点变化</p>
                    ) : (
                      <div className="diff-list">
                        {latestDiff.changes.map((change) => (
                          <div
                            className={`diff-row ${change.kind}`}
                            key={`${change.kind}-${change.id}`}
                            title={change.details.length > 0
                              ? change.details.map((detail) => `${detail.field}: ${detail.previous ?? "∅"} → ${detail.current ?? "∅"}`).join("\n")
                              : undefined}
                          >
                            <span className="diff-kind">{changeKindLabel(change.kind)}</span>
                            <code>#{change.id}</code>
                            <span className="diff-label">{change.label}</span>
                            <span className="diff-fields">{change.fields.length > 0 ? change.fields.join(" · ") : "节点结构"}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="inspector-grid">
                  <div className="tree-pane">
                    <div className="subpanel-heading">
                      <span>层级树</span>
                      <span className="tree-hint">{hasTreeFilter ? `${filteredNodeCount}/${snapshot.nodeCount} nodes` : `${snapshot.nodeCount} nodes`}</span>
                    </div>
                    <div className="tree-tools">
                      <input
                        className="tree-search"
                        type="search"
                        value={treeQuery}
                        onChange={(event) => setTreeQuery(event.target.value)}
                        placeholder="搜索文本、resource-id、class…"
                        aria-label="搜索 UI 节点"
                      />
                      <div className="tree-filter-row">
                        <label><input type="checkbox" checked={interactiveOnly} onChange={(event) => setInteractiveOnly(event.target.checked)} /> 可操作</label>
                        <label><input type="checkbox" checked={identifiedOnly} onChange={(event) => setIdentifiedOnly(event.target.checked)} /> 有标识</label>
                        {hasTreeFilter && <button className="tree-clear" type="button" onClick={clearTreeFilter}>清除筛选</button>}
                      </div>
                    </div>
                    <UiTree
                      key={treeSession}
                      root={snapshot.root}
                      filteredRoot={filteredRoot}
                      selectedId={selectedNode?.id ?? snapshot.root.id}
                      filterActive={hasTreeFilter}
                      filterKey={JSON.stringify([treeQuery, interactiveOnly, identifiedOnly])}
                      revealRequest={treeRevealRequest}
                      onSelect={setSelectedNode}
                      onClearFilter={clearTreeFilter}
                    />
                  </div>

                  <div className="preview-pane">
                    <div className="subpanel-heading">
                      <span>设备画面</span>
                      <span className="tree-hint">{selectedSerial}</span>
                    </div>
                    {snapshot.screenshotDataUrl ? (
                      <ScreenshotPreview key={treeSession} src={snapshot.screenshotDataUrl} root={snapshot.root}
                        selectedNode={selectedNode} geometry={snapshot.captureGeometry} onSelect={handleScreenshotSelect} />
                    ) : <div className="screenshot-frame"><div className="no-screenshot">截图不可用</div></div>}
                    {detailNode && (
                      <div className="node-details">
                        <div className="node-detail-heading">
                          <div>
                            <p className="section-kicker">SELECTED NODE</p>
                            <h4>{nodeDisplayLabel(detailNode)}</h4>
                          </div>
                          <span className="node-id">#{detailNode.id}</span>
                        </div>
                        {virtualAccessibilityHint(detailNode) && <p className="node-source-note">{virtualAccessibilityHint(detailNode)}</p>}
                        <dl>
                          <div><dt>class</dt><dd>{detailNode.className ?? "—"}</dd></div>
                          <div><dt>index</dt><dd>{detailNode.index ?? "—"}</dd></div>
                          <div><dt>package</dt><dd>{detailNode.package ?? "—"}</dd></div>
                          <div><dt>text</dt><dd>{detailNode.text ?? "—"}</dd></div>
                          <div><dt>content-desc</dt><dd>{detailNode.contentDesc ?? "—"}</dd></div>
                          <div><dt>resource-id</dt><dd>{detailNode.resourceId ?? "—"}</dd></div>
                          <div><dt>bounds</dt><dd>{detailNode.bounds?.raw ?? "—"}</dd></div>
                          <div><dt>flags</dt><dd>{[
                            detailNode.clickable && "clickable",
                            detailNode.enabled && "enabled",
                            detailNode.focusable && "focusable",
                            detailNode.focused && "focused",
                            detailNode.scrollable && "scrollable",
                            detailNode.selected && "selected",
                            !detailNode.visibleToUser && "hidden",
                          ].filter(Boolean).join(" · ") || "none"}</dd></div>
                        </dl>
                        {detailAttributes.length > 0 ? (
                          <details className="node-attributes" open>
                            <summary>全部 XML 属性 · {detailAttributes.length}</summary>
                            <dl className="node-attributes-list">
                              {detailAttributes.map(([name, value]) => (
                                <div key={name}>
                                  <dt>{name}</dt>
                                  <dd title={value}>{value || "∅"}</dd>
                                </div>
                              ))}
                            </dl>
                          </details>
                        ) : (
                          <p className="node-attributes-empty">当前快照没有保存原始 XML 属性；重新刷新 UI 可获取完整属性。</p>
                        )}
                        {selectorData && (
                          <div className="selector-panel">
                            <div className="selector-panel-heading">
                              <span>定位器与操作</span>
                              {copyStatus && <span className="selector-status">{copyStatus}</span>}
                            </div>
                            <div className="selector-row">
                              <code title={selectorData.xpath}>{selectorData.xpath}</code>
                              <button className="selector-copy" type="button" onClick={() => void copyValue("XPath", selectorData.xpath)}>复制 XPath</button>
                            </div>
                            <div className="selector-row">
                              <code title={selectorData.uiSelector}>{selectorData.uiSelector}</code>
                              <button className="selector-copy" type="button" onClick={() => void copyValue("UiSelector", selectorData.uiSelector)}>复制 UiSelector</button>
                            </div>
                            <div className="selector-row">
                              <code title={selectorData.adbTap}>{selectorData.adbTap}</code>
                              <button className="selector-copy" type="button" onClick={() => void copyValue("ADB 命令", selectorData.adbTap)} disabled={!detailNode.bounds}>复制 ADB</button>
                            </div>
                            <div className="selector-actions">
                              <button type="button" onClick={() => void copyValue("节点 JSON", selectorData.json)}>复制节点 JSON</button>
                              <button type="button" onClick={() => void exportCurrentSnapshot("json")}>导出 JSON</button>
                              <button type="button" onClick={() => void exportCurrentSnapshot("xml")} disabled={!snapshot.rawXml}>导出 XML</button>
                              <button type="button" onClick={() => void exportCurrentSnapshot("png")} disabled={!snapshot.screenshotDataUrl}>导出 PNG</button>
                            </div>
                            {exportStatus && <p className="export-status">{exportStatus}</p>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </section>
        )}
      </main>

      <footer className="app-footer">
        <span>ANDROID UI INSPECTOR / LOCAL-FIRST</span>
        <span>下一步：读取 UIAutomator hierarchy</span>
      </footer>
    </div>
  );
}

export default App;

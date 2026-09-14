import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import "./App.css";
import type { AdbProbeResult, ExportFormat, StoredSnapshot, UiNode, UiSnapshot } from "../shared/types";
import { filterTree, flattenNodes, nodeDisplayLabel } from "../shared/tree-utils";
import { UiTree } from "./components/UiTree";
import { ScreenshotPreview } from "./components/ScreenshotPreview";
import { NodePropertiesPanel } from "./components/NodePropertiesPanel";

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

type DetailsResizeDrag = {
  pointerId: number;
  startY: number;
  startHeight: number;
  height: number;
  minimum: number;
  maximum: number;
};

const MIN_DETAILS_HEIGHT = 0;
const MIN_SCREENSHOT_HEIGHT = 260;
const DETAILS_COLLAPSE_SNAP_HEIGHT = 32;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

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

function expandedTreeNodeIds(root: UiNode) {
  return new Set([...flattenNodes(root).values()].filter((node) => node.children.length > 0).map((node) => node.id));
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
  const [treeExpandedIds, setTreeExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [treeRevealRequest, setTreeRevealRequest] = useState(0);
  const [detailsHeight, setDetailsHeight] = useState<number | null>(null);
  const [detailsResizing, setDetailsResizing] = useState(false);
  const detailsResizeRef = useRef<DetailsResizeDrag | null>(null);
  const [sceneToolbarHost, setSceneToolbarHost] = useState<HTMLDivElement | null>(null);
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
    setTreeExpandedIds(new Set());
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
      setTreeExpandedIds(result.root ? expandedTreeNodeIds(result.root) : new Set());
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
    setTreeExpandedIds(new Set());
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

  const detailsResizeBounds = useCallback((handle: HTMLElement) => {
    const preview = handle.closest<HTMLElement>(".preview-pane");
    const details = preview?.querySelector<HTMLElement>(".node-details");
    const frame = preview?.querySelector<HTMLElement>(".screenshot-frame");
    if (!preview || !details || !frame) return { minimum: MIN_DETAILS_HEIGHT, maximum: MIN_DETAILS_HEIGHT };
    const staticHeight = Math.max(0, preview.clientHeight - details.offsetHeight - frame.offsetHeight);
    return {
      minimum: MIN_DETAILS_HEIGHT,
      maximum: Math.max(MIN_DETAILS_HEIGHT, preview.clientHeight - staticHeight - MIN_SCREENSHOT_HEIGHT),
    };
  }, []);

  const beginDetailsResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const details = event.currentTarget.closest<HTMLElement>(".preview-pane")?.querySelector<HTMLElement>(".node-details");
    if (!details) return;
    const { minimum, maximum } = detailsResizeBounds(event.currentTarget);
    detailsResizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: details.offsetHeight, height: details.offsetHeight, minimum, maximum };
    setDetailsResizing(true);
    event.preventDefault();
  }, [detailsResizeBounds]);

  const moveDetailsResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = detailsResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextHeight = Math.round(clamp(drag.startHeight + drag.startY - event.clientY, drag.minimum, drag.maximum));
    drag.height = nextHeight <= DETAILS_COLLAPSE_SNAP_HEIGHT ? 0 : nextHeight;
    event.currentTarget.closest<HTMLElement>(".preview-pane")?.style.setProperty("--node-details-height", `${drag.height}px`);
  }, []);

  const endDetailsResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = detailsResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    detailsResizeRef.current = null;
    setDetailsHeight(drag.height);
    setDetailsResizing(false);
  }, []);

  const resizeDetailsByKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const adjustment = event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0;
    if (!adjustment && event.key !== "Home" && event.key !== "End") return;
    const details = event.currentTarget.closest<HTMLElement>(".preview-pane")?.querySelector<HTMLElement>(".node-details");
    if (!details) return;
    const { minimum, maximum } = detailsResizeBounds(event.currentTarget);
    const current = detailsHeight ?? details.offsetHeight;
    const next = event.key === "Home" ? minimum : event.key === "End" ? maximum : clamp(current + adjustment, minimum, maximum);
    setDetailsHeight(Math.round(next));
    event.preventDefault();
  }, [detailsHeight, detailsResizeBounds]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      document.getElementById("global-node-search")?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

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
    setTreeExpandedIds(entry.snapshot.root ? expandedTreeNodeIds(entry.snapshot.root) : new Set());
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

  const selectDevice = useCallback((serial: string) => {
    setSelectedSerial(serial || null);
    setSnapshot(null);
    setSelectedNode(null);
    setTreeExpandedIds(new Set());
    setInspectionError(null);
    setCopyStatus(null);
    setExportStatus(null);
    setTreeQuery("");
    setInteractiveOnly(false);
    setIdentifiedOnly(false);
    setSnapshotStatus(null);
    setLatestDiff(null);
    setDiffExpanded(false);
  }, []);

  const toolbarSerial = selectedSerial ?? readyDevices[0]?.serial ?? "";
  const toolbarDevice = devices.find((device) => device.serial === toolbarSerial) ?? null;
  const primaryDevice = toolbarDevice ?? devices[0] ?? null;
  const homeConnectionLabel = runtimeError || probe?.error
    ? "连接异常"
    : primaryDevice?.state === "device"
      ? "已授权，可开始检查"
      : primaryDevice
        ? stateLabel(primaryDevice.state)
        : "等待设备连接";
  const captureSerial = toolbarDevice?.state === "device" ? toolbarDevice.serial : null;
  const captureSelected = useCallback(() => {
    if (captureSerial) void inspectDevice(captureSerial);
  }, [captureSerial, inspectDevice]);
  const previewStyle = detailsHeight === null ? undefined : { "--node-details-height": `${detailsHeight}px` } as CSSProperties;

  return (
    <div className={`app-shell ${selectedSerial ? "inspection-active" : ""}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <div>
            <p className="eyebrow">ANDROID TOOLING</p>
            <h1>Android UI Inspector</h1>
          </div>
          <span className="alpha-badge">ALPHA</span>
        </div>

        <div className="topbar-meta inspector-toolbar">
          {selectedSerial && (
            <button className="toolbar-back-button" type="button" onClick={closeInspector} aria-label="返回设备列表">
              ‹ 返回
            </button>
          )}
          <div className="toolbar-device-control">
            <span className={`connection-dot ${statusTone}`} aria-hidden="true" />
            <label className="toolbar-label" htmlFor="device-select">目标设备</label>
            <select
              id="device-select"
              className="device-select"
              aria-label="选择 Android 设备"
              value={toolbarSerial}
              onChange={(event) => selectDevice(event.currentTarget.value)}
            >
              <option value="">{devices.length > 0 ? "选择设备" : "未发现设备"}</option>
              {devices.map((device) => (
                <option
                  key={device.serial}
                  value={device.serial}
                  data-device-state={device.state}
                  className="device-option"
                >
                  {device.model ?? "Android device"} · {stateLabel(device.state)}
                </option>
              ))}
              {selectedSerial && !toolbarDevice && (
                <option value={selectedSerial} data-device-state="history">{selectedSerial} · 历史快照</option>
              )}
            </select>
            {toolbarDevice && <span className={`device-state toolbar-device-state ${toolbarDevice.state}`}>{stateLabel(toolbarDevice.state)}</span>}
          </div>
          <span className={`toolbar-status ${statusTone}`} title={runtimeError || probe?.error || undefined}>
            {runtimeError || probe?.error ? "连接异常" : captureSerial ? "设备已连接" : "等待设备"}
          </span>
          <span className={`adb-badge ${hasAdb ? "ready" : "missing"}`}>ADB {hasAdb ? "READY" : "MISSING"}</span>
          <span className="toolbar-checked">{formatCheckedAt(checkedAt)}</span>
          <button
            className="refresh-button"
            type="button"
            onClick={() => void refreshDevices()}
            disabled={loading}
          >
            <span className={loading ? "refresh-icon spinning" : "refresh-icon"}>↻</span>
            {loading ? "检查中" : "刷新设备"}
          </button>
          <button
            className="capture-button"
            type="button"
            onClick={captureSelected}
            disabled={!captureSerial || inspectionLoading || loading}
          >
            <span className={inspectionLoading ? "capture-icon spinning" : "capture-icon"} aria-hidden="true">●</span>
            {inspectionLoading ? "采集中…" : "采集截图"}
          </button>
          <label className="topbar-search" htmlFor="global-node-search">
            <span aria-hidden="true">⌕</span>
            <input
              id="global-node-search"
              type="search"
              value={treeQuery}
              onChange={(event) => setTreeQuery(event.target.value)}
              placeholder="搜索节点…"
              aria-label="搜索 UI 节点"
            />
            <kbd>⌘ K</kbd>
          </label>
        </div>
        <div className="scene-toolbar-host" ref={setSceneToolbarHost} />
      </header>

      <main className="workspace">
        <section className="home-view" aria-label="设备连接">
          <div className="home-layout">
            <section className="home-card connected-device-card">
              <div className="home-card-heading">
                <div>
                  <p className="home-kicker">CONNECTED DEVICE</p>
                  <h2>已连接设备</h2>
                </div>
                <span className={`home-state-pill ${statusTone}`}>
                  <span className="home-status-dot" aria-hidden="true" />
                  {homeConnectionLabel}
                </span>
              </div>

              {primaryDevice ? (
                <>
                  <div className="home-device-hero">
                    <div className="home-phone-illustration" aria-hidden="true">
                      <div className="home-phone-speaker" />
                      <div className="home-phone-screen">
                        <span />
                        <span />
                        <span />
                      </div>
                    </div>
                    <div className="home-device-copy">
                      <h3>{primaryDevice.model ?? "Android device"}</h3>
                      <code>{primaryDevice.serial}</code>
                      <p>{primaryDevice.product ?? "USB / ADB target"}</p>
                      <div className="home-device-status">
                        <span className={`home-status-dot ${primaryDevice.state === "device" ? "ready" : ""}`} aria-hidden="true" />
                        <strong>{stateLabel(primaryDevice.state)}</strong>
                        <span>{hasAdb ? "ADB READY" : "ADB MISSING"}</span>
                      </div>
                    </div>
                  </div>
                  <div className="home-device-footer">
                    <div>
                      <strong>{readyDevices.length > 0 ? "准备开始检查 UI" : "等待设备授权"}</strong>
                      <p>{readyDevices.length > 0 ? "使用顶部的“采集截图”读取当前页面。" : "请在手机上允许这台电脑进行 USB 调试。"}</p>
                    </div>
                    <span className="home-device-count">{devices.length} 台设备</span>
                  </div>
                </>
              ) : (
                <div className="home-empty-state">
                  <div className="home-phone-illustration empty" aria-hidden="true">
                    <div className="home-phone-screen"><span /><span /><span /></div>
                  </div>
                  <h3>{runtimeError || probe?.error ? "ADB 尚未准备好" : "等待 Android 设备"}</h3>
                  <p>{runtimeError || probe?.error ? "请确认 Platform-Tools 已安装后重新检查。" : "连接 USB 并开启 USB 调试，应用会自动识别设备。"}</p>
                  <button className="home-secondary-action" type="button" onClick={() => void refreshDevices()} disabled={loading}>
                    {loading ? "检查中…" : "重新检查设备"}
                  </button>
                </div>
              )}
            </section>

            <aside className="home-card quick-start-card">
              <div className="home-card-heading">
                <div>
                  <p className="home-kicker">QUICK START</p>
                  <h2>开始之前</h2>
                </div>
                <span className="home-step-count">01 — 03</span>
              </div>
              <ol className="home-steps">
                <li>
                  <span className="home-step-number">01</span>
                  <div><strong>打开开发者选项</strong><p>设置 → 关于手机 → 连续点击版本号</p></div>
                </li>
                <li>
                  <span className="home-step-number">02</span>
                  <div><strong>开启 USB 调试</strong><p>在开发者选项中打开 USB 调试</p></div>
                </li>
                <li>
                  <span className="home-step-number">03</span>
                  <div><strong>允许这台电脑</strong><p>在手机弹窗中确认 RSA 授权</p></div>
                </li>
              </ol>
              <div className="home-safety-note">
                <span aria-hidden="true">i</span>
                <p>当前版本只读取设备信息，不会修改手机数据。</p>
              </div>
            </aside>
          </div>
          <p className="home-last-checked">最后检查：{formatCheckedAt(checkedAt)}</p>
        </section>
        {selectedSerial && (
          <section className="panel inspector-panel">
            <div className="inspector-heading">
              <div>
                <p className="section-kicker">UIAUTOMATOR HIERARCHY</p>
                <h3>界面层级</h3>
              </div>
              <div className="inspector-heading-meta">
                <span className="snapshot-summary">{snapshot ? `${snapshot.nodeCount} nodes · ${formatBytes(snapshot.xmlSize)} · ${dumpModeLabel(snapshot.hierarchyDumpMode)}` : "读取中"}</span>
                <button className="close-button" type="button" onClick={closeInspector}>返回设备</button>
              </div>
            </div>

            {inspectionLoading ? (
              <div className="inspector-grid inspector-state-grid">
                <div className="tree-pane inspector-state-pane">
                  <div className="subpanel-heading">
                    <span>层级树</span>
                    <span className="tree-hint">读取中</span>
                  </div>
                  <div className="workspace-empty-copy">
                    <span className="loading-orbit" />
                    <h4>正在读取 UI hierarchy</h4>
                    <p>执行 uiautomator dump，并从设备拉取当前页面结构。</p>
                  </div>
                </div>
                <div className="preview-pane inspector-state-pane">
                  <div className="subpanel-heading">
                    <span>设备画面</span>
                    <span className="tree-hint">采集中</span>
                  </div>
                  <div className="workspace-empty-copy">
                    <span className="workspace-empty-icon" aria-hidden="true">◎</span>
                    <h4>正在同步截图</h4>
                    <p>等待 hierarchy 和设备画面完成采集。</p>
                  </div>
                </div>
              </div>
            ) : inspectionError || snapshot?.error ? (
              <div className="inspector-grid inspector-state-grid">
                <div className="tree-pane inspector-state-pane">
                  <div className="subpanel-heading">
                    <span>层级树</span>
                    <span className="tree-hint">读取失败</span>
                  </div>
                  <div className="workspace-empty-copy error-placeholder">
                    <div className="error-mark">!</div>
                    <h4>读取失败</h4>
                    <p>{inspectionError || snapshot?.error}</p>
                    <span className="tree-hint">请使用顶部“采集截图”重新获取。</span>
                  </div>
                </div>
                <div className="preview-pane inspector-state-pane">
                  <div className="subpanel-heading">
                    <span>设备画面</span>
                    <span className="tree-hint">未采集</span>
                  </div>
                  <div className="workspace-empty-copy">
                    <span className="workspace-empty-icon" aria-hidden="true">×</span>
                    <h4>暂无截图结果</h4>
                    <p>本次检查未生成可用截图，右侧会在下一次采集后显示设备画面。</p>
                  </div>
                </div>
              </div>
            ) : snapshot?.root ? (
              <>
                {snapshot.warning && <div className="snapshot-warning">{snapshot.warning}</div>}
                {virtualNodeCount > 0 && (
                  <div className="hierarchy-note">
                    当前 hierarchy 包含 {virtualNodeCount} 个 VirtualChild 虚拟无障碍节点。它们只代表应用暴露的可访问性信息，不保证包含所有实际绘制控件。
                  </div>
                )}
                <div className="inspector-grid">
                  <div className="tree-pane">
                    <div className="subpanel-heading">
                      <span>层级树</span>
                      <span className="tree-hint">{hasTreeFilter ? `${filteredNodeCount}/${snapshot.nodeCount} nodes` : `${snapshot.nodeCount} nodes`}</span>
                    </div>
                    <div className="tree-tools">
                      <div className="tree-search-row">
                        <input
                          className="tree-search"
                          type="search"
                          value={treeQuery}
                          onChange={(event) => setTreeQuery(event.target.value)}
                          placeholder="搜索文本、resource-id、class…"
                          aria-label="搜索 UI 节点"
                        />
                        {hasTreeFilter && <button className="tree-clear tree-clear-inline" type="button" onClick={clearTreeFilter}>清除筛选</button>}
                        <details className="tree-filter-details">
                          <summary>筛选</summary>
                          <div className="tree-filter-row">
                            <label><input type="checkbox" checked={interactiveOnly} onChange={(event) => setInteractiveOnly(event.target.checked)} /> 可操作</label>
                            <label><input type="checkbox" checked={identifiedOnly} onChange={(event) => setIdentifiedOnly(event.target.checked)} /> 有标识</label>
                          </div>
                        </details>
                      </div>
                    </div>
                    <UiTree
                      key={treeSession}
                      root={snapshot.root}
                      filteredRoot={filteredRoot}
                      selectedId={selectedNode?.id ?? snapshot.root.id}
                      expanded={treeExpandedIds}
                      filterActive={hasTreeFilter}
                      filterKey={JSON.stringify([treeQuery, interactiveOnly, identifiedOnly])}
                      revealRequest={treeRevealRequest}
                      onExpandedChange={setTreeExpandedIds}
                      onSelect={setSelectedNode}
                      onClearFilter={clearTreeFilter}
                    />
                  </div>

                  <div className={`preview-pane ${detailsHeight === 0 ? "details-collapsed" : ""}`} style={previewStyle} onPointerMove={moveDetailsResize} onPointerUp={endDetailsResize} onPointerCancel={endDetailsResize}>
                    <div className="subpanel-heading">
                      <span>设备画面</span>
                      <span className="tree-hint">{selectedSerial}</span>
                    </div>
                    <details className="snapshot-drawer">
                      <summary>
                        <span>快照与历史</span>
                        <span className="snapshot-drawer-summary">
                          {savedSnapshots.length} 份
                          {latestDiff ? ` · ${diffSummary(latestDiff)}` : " · 保存当前页面"}
                        </span>
                      </summary>
                      <div className="snapshot-drawer-body">
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
                      </div>
                    </details>
                    {snapshot.screenshotDataUrl ? (
                      <ScreenshotPreview key={treeSession} src={snapshot.screenshotDataUrl} root={snapshot.root}
                        selectedNode={selectedNode} expandedNodeIds={treeExpandedIds} geometry={snapshot.captureGeometry} toolbarHost={sceneToolbarHost} onSelect={handleScreenshotSelect} />
                    ) : <div className="screenshot-frame"><div className="no-screenshot">截图不可用</div></div>}
                    {detailNode && (
                      <>
                      <div
                        className={`node-details-resizer ${detailsResizing ? "is-dragging" : ""}`}
                        role="separator"
                        tabIndex={0}
                        aria-label="调整属性栏高度；向下拖到底可隐藏，可上下拖拽或使用方向键"
                        aria-orientation="horizontal"
                        onPointerDown={beginDetailsResize}
                        onKeyDown={resizeDetailsByKeyboard}
                      />
                      <div className="node-details">
                        <div className="node-detail-heading">
                          <div>
                            <p className="section-kicker">SELECTED NODE</p>
                            <h4>{nodeDisplayLabel(detailNode)}</h4>
                          </div>
                          <span className="node-id">#{detailNode.id}</span>
                        </div>
                        {virtualAccessibilityHint(detailNode) && <p className="node-source-note">{virtualAccessibilityHint(detailNode)}</p>}
                        <NodePropertiesPanel
                          root={snapshot.root!}
                          node={detailNode}
                          screenshotSize={snapshot.captureGeometry?.screenshotSize ?? null}
                        />
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
                      </>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="inspector-grid inspector-empty-grid">
                <div className="tree-pane empty-tree-pane">
                  <div className="subpanel-heading">
                    <span>层级树</span>
                    <span className="tree-hint">等待 hierarchy</span>
                  </div>
                  <div className="workspace-empty-copy">
                    <span className="workspace-empty-icon" aria-hidden="true">⌁</span>
                    <h4>{captureSerial ? "准备采集当前页面" : "请选择已授权设备"}</h4>
                    <p>{captureSerial ? "点击顶部“采集截图”，同时获取 UIAutomator 层级和设备画面。" : "顶部选择已授权的 Android 设备后，再开始采集。"}</p>
                  </div>
                </div>
                <div className="preview-pane empty-preview-pane">
                  <div className="subpanel-heading">
                    <span>设备截图</span>
                    <span className="tree-hint">未采集</span>
                  </div>
                  <div className="workspace-empty-copy">
                    <span className="workspace-empty-icon" aria-hidden="true">◎</span>
                    <h4>{captureSerial ? "等待截图结果" : "连接设备后开始"}</h4>
                    <p>{captureSerial ? "截图和树状结构会在这里同步显示。" : "请先连接并授权 Android 设备。"}</p>
                  </div>
                </div>
              </div>
            )}
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

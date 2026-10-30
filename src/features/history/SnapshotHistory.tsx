import { changeKindLabel, diffSummary, formatSnapshotTime, type SavedSnapshot, type SnapshotDiff } from "./model";

export function SnapshotHistory({ entries, fileBytes, onSelect, onExport, onDelete }: { entries: SavedSnapshot[]; fileBytes?: number | null;
  onSelect: (entry: SavedSnapshot) => void; onExport?: (entry: SavedSnapshot) => void; onDelete?: (entry: SavedSnapshot) => void }) {
  return (
    <div className="snapshot-history">
      <div className="snapshot-history-heading">
        <span>本地快照</span>
        <span>{fileBytes === null || fileBytes === undefined ? "最多 30 份 / 200 MiB"
          : "磁盘 " + (fileBytes / 1048576).toFixed(1) + " MiB · 新保存配额 200 MiB"}</span>
      </div>
      {fileBytes !== null && fileBytes !== undefined && fileBytes > 200 * 1048576 && (
        <p className="snapshot-history-capacity">旧文件可能含格式空白；新保存按紧凑内容核算 200 MiB。请先导出并确认可打开，再按需删除。</p>
      )}
      <div className="snapshot-history-list">
        {entries.slice().reverse().map((entry) => (
          <div className="snapshot-history-row" key={entry.id}>
            <button className="snapshot-history-item" type="button" onClick={() => onSelect(entry)}>
              <code>{formatSnapshotTime(entry.capturedAt)}</code>
              <span>{entry.snapshot.nodeCount} nodes</span>
              <span className="tree-hint">{entry.snapshot.serial}</span>
              {entry.diff && <span className="snapshot-diff">{diffSummary(entry.diff)}</span>}
            </button>
            {onExport && <button className="snapshot-history-export" type="button"
              aria-label={"导出 " + formatSnapshotTime(entry.capturedAt) + "（" + entry.id.slice(0, 8) + "）的完整快照"}
              onClick={() => onExport(entry)}>导出</button>}
            {onDelete && <button className="snapshot-history-delete" type="button"
              aria-label={`删除 ${formatSnapshotTime(entry.capturedAt)}（${entry.id.slice(0, 8)}）的本地快照`}
              onClick={() => onDelete(entry)}>删除</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SnapshotDiffDetails({ diff, onExport }: { diff: SnapshotDiff; onExport: () => Promise<void> }) {
  return (
    <div className="snapshot-diff-details">
      <div className="snapshot-history-heading">
        <span>节点变化明细</span>
        <div className="diff-heading-actions">
          <span>最多展示 200 项</span>
          <button className="diff-toggle" type="button" onClick={() => void onExport()}>导出差异 JSON</button>
        </div>
      </div>
      {diff.changes.length === 0 ? (
        <p className="diff-empty">未发现节点变化</p>
      ) : (
        <div className="diff-list">
          {diff.changes.map((change) => (
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
  );
}

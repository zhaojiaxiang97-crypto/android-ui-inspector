import { changeKindLabel, diffSummary, formatSnapshotTime, type SavedSnapshot, type SnapshotDiff } from "./model";

export function SnapshotHistory({ entries, onSelect }: { entries: SavedSnapshot[]; onSelect: (entry: SavedSnapshot) => void }) {
  return (
    <div className="snapshot-history">
      <div className="snapshot-history-heading">
        <span>最近保存</span>
        <span>最多保留 30 份</span>
      </div>
      <div className="snapshot-history-list">
        {entries.slice(-6).reverse().map((entry) => (
          <button className="snapshot-history-item" type="button" key={entry.id} onClick={() => onSelect(entry)}>
            <code>{formatSnapshotTime(entry.capturedAt)}</code>
            <span>{entry.snapshot.nodeCount} nodes</span>
            <span className="tree-hint">{entry.snapshot.serial}</span>
            {entry.diff && <span className="snapshot-diff">{diffSummary(entry.diff)}</span>}
          </button>
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

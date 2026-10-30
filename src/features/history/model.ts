import type { StoredSnapshot, UiNode } from "../../../shared/types";
import { flattenNodes, nodeDisplayLabel } from "../../../shared/tree-utils";


export type SnapshotDiff = {
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

export type SavedSnapshot = StoredSnapshot & {
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

export function diffSummary(diff: SnapshotDiff) {
  return `+${diff.added} / -${diff.removed} / ${diff.changed} 项属性变化`;
}

export function addSnapshotDiffs(entries: StoredSnapshot[]): SavedSnapshot[] {
  let previous: StoredSnapshot | null = null;
  return entries.map((entry) => {
    const previousRoot = previous?.snapshot.serial === entry.snapshot.serial ? previous.snapshot.root : null;
    const diff = previousRoot && entry.snapshot.root ? compareNodeTrees(previousRoot, entry.snapshot.root) : null;
    previous = entry;
    return { ...entry, diff };
  });
}

export function formatSnapshotTime(value: string) {
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

export function changeKindLabel(kind: SnapshotChange["kind"]) {
  if (kind === "added") return "新增";
  if (kind === "removed") return "删除";
  return "变化";
}

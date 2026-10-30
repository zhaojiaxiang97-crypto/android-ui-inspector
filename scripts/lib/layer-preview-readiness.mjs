// Serializable into the isolated renderer probe; no image bytes or device reads.
export function layerPreviewReadiness(updatedIds, expected, committed) {
  const updated = new Set(updatedIds);
  const targets = expected.filter(item => updated.has(item.id) && Boolean(item.key));
  const ready = new Map(committed.map(item => [item.id, item]));
  const missing = targets.filter(item => ready.get(item.id)?.key !== item.key).map(item => item.id);
  return { ready: targets.length > 0 && missing.length === 0, eligible: targets.length,
    drawn: targets.filter(item => ready.get(item.id)?.key === item.key && ready.get(item.id)?.drawn).length,
    excluded: updated.size - new Set(targets.map(item => item.id)).size, missing };
}

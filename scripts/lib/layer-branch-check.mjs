export function descendantPlaneIds(parentId, planes) {
  return planes.map(plane => plane.id).filter(id => typeof id === "string" && id.startsWith(`${parentId}/`));
}

export function branchChildrenRemoved(childIds, planes) {
  if (!childIds.length) return false;
  const remaining = new Set(planes.map(plane => plane.id));
  return childIds.every(id => !remaining.has(id));
}

export function visibleNativeBranchIds(planes) {
  return planes.filter(parent => {
    const children = descendantPlaneIds(parent.id, planes);
    return children.length > 0 && children.length <= 6
      && planes.some(child => children.includes(child.id) && child.mode === "native");
  }).map(parent => parent.id);
}

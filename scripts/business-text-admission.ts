// This gate describes experiment eligibility, not whether legacy capture works.
export function businessTextAdmission(tree: any, text: string, expectedPid: number) {
  const reasons: string[] = [];
  if (tree?.pid !== expectedPid || typeof tree?.processInstance !== "string" || !tree.processInstance) {
    reasons.push("SDK process identity missing or changed");
  }
  for (const key of ["refDebugCanvasVersion", "uiWakeVersion", "branchGeometryVersion"]) {
    if (tree?.[key] !== 1) reasons.push(`${key} must be 1`);
  }
  const pending = tree?.root ? [tree.root] : [];
  const matches: any[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (node.text === text) matches.push(node);
    pending.push(...(node.children ?? []));
  }
  if (matches.length !== 1) reasons.push("target text must match exactly one node");
  const target = matches.length === 1 ? matches[0] : undefined;
  if (target) {
    if (target.hardwareAccelerated !== true) reasons.push("target hardwareAccelerated must be explicit true");
    if (!target.className?.endsWith("TextView") || target.children?.length || !target.ref) {
      reasons.push("target must be a referenced TextView leaf");
    }
  }
  return { eligible: reasons.length === 0, reasons, pid: tree?.pid,
    processInstance: tree?.processInstance,
    capabilities: Object.fromEntries(["refDebugCanvasVersion", "uiWakeVersion", "branchGeometryVersion"]
      .map(key => [key, tree?.[key] ?? null])),
    target: target ? { ref: target.ref, className: target.className,
      hardwareAccelerated: target.hardwareAccelerated ?? null } : null };
}

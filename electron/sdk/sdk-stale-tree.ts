import { matchesViewRoot } from "../capture/view-protocol";

/** Optional telemetry never authorizes rejection; the request binding below still does. */
export function parseTreeDifference(wire: string | undefined): string | undefined {
  if (!wire || wire.length > 512) return;
  const p = wire.split(";");
  if (p.length !== 16 || p[0] !== "1" || !["before", "after"].includes(p[1])
      || !["root", "detached", "owner", "hidden", "missing", "position", "size"].includes(p[2])
      || !/^\d+$/.test(p[3]) || Number(p[3]) > 120000
      || p.slice(12).some(v => !/^[01]$/.test(v))) return;
  const numbers = (values: string[]) => values.every((v, i) => /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v))
    && Math.abs(Number(v)) <= 0x7fffffff && (i < 2 || Number(v) >= 0));
  const missing = p.slice(4, 8).every(v => v === "-");
  if ((!missing && !numbers(p.slice(4, 8))) || !numbers(p.slice(8, 12))) return;
  const expected = missing ? null : p.slice(4, 8).map(Number), actual = p.slice(8, 12).map(Number);
  const [sameRoot, attached, sameOwner, shown] = p.slice(12).map(v => v === "1");
  const reason = !sameRoot ? "root" : !attached ? "detached" : !sameOwner ? "owner" : !shown ? "hidden"
    : !expected ? "missing" : Math.abs(actual[0] - expected[0]) > 1 || Math.abs(actual[1] - expected[1]) > 1 ? "position"
    : actual[2] !== expected[2] || actual[3] !== expected[3] ? "size" : null;
  if (reason !== p[2]) return;
  return JSON.stringify({ version: 1, phase: p[1], reason, guardAgeMs: Number(p[3]), expected, actual,
    delta: expected ? actual.map((v, i) => v - expected[i]) : null, sameRoot, attached, sameOwner, shown });
}

/** A typed, request-bound rejection; free-form error text never authorizes early exit. */
export function parseSdkStaleTree(field: (name: string) => string | undefined, nonce: string, rootRef: string, instance?: string) {
  const target = field("failureTarget"), completed = field("failureCompleted");
  if (field("result") === "ok" || field("failureKind") !== "stale-tree" || field("nonce") !== nonce
      || !matchesViewRoot(rootRef, field("rootRef") ?? "") || !instance
      || !/^[a-f0-9-]{36}$/i.test(instance) || field("processInstance") !== instance
      || !target || target.length > 256 || !/^[\w.$]+@[0-9a-f]{1,8}$/i.test(target)
      || completed === undefined || !/^\d+$/.test(completed) || Number(completed) > 5000) return null;
  const geometry = parseTreeDifference(field("failureGeometry"));
  return { "sdk-visible-failure-phase": "tree-guard", "sdk-visible-failure-target": target,
    "sdk-visible-failure-completed": completed, ...(geometry ? { "sdk-visible-failure-geometry": geometry } : {}) };
}

export type ProviderSessionTiming =
  | { status: "not-requested" | "not-started" | "unsupported" | "invalid" }
  | { status: "available"; version: 1; callNs: number; lockWaitNs: number; dispatchNs: number; openNs: number };

/** Optional evidence only: never authorize a session or change the original error. */
export function parseProviderSessionTiming(output: string): ProviderSessionTiming {
  const keys = ["sessionTimingVersion", "sessionCallNs", "sessionLockWaitNs", "sessionDispatchNs", "sessionOpenNs"];
  const bundle = /^Result: Bundle\[\{([^\r\n]*)\}\]$/.exec(output.trim());
  if (!bundle) return { status: "invalid" };
  const fields = new Map<string, string>();
  for (const token of bundle[1].split(/,\s*/)) {
    const index = token.indexOf("=");
    const key = token.slice(0, index).trim();
    if (!keys.includes(key)) continue;
    if (fields.has(key)) return { status: "invalid" };
    fields.set(key, token.slice(index + 1).trim());
  }
  if (!fields.size) return { status: "unsupported" };
  if (fields.get(keys[0]) !== "1" || keys.some(key => !/^\d+$/.test(fields.get(key) ?? ""))) return { status: "invalid" };
  const [, callNs, lockWaitNs, dispatchNs, openNs] = keys.map(key => Number(fields.get(key)));
  if ([callNs, lockWaitNs, dispatchNs, openNs].some(value => !Number.isSafeInteger(value))
    || callNs < lockWaitNs + dispatchNs || dispatchNs < openNs) return { status: "invalid" };
  return { status: "available", version: 1, callNs, lockWaitNs, dispatchNs, openNs };
}

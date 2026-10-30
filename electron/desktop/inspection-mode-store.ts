import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { inspectionModeOrDefault, type InspectionMode } from "../../shared/inspection-mode";

export function createInspectionModeStore(path: string) {
  return {
    load(): InspectionMode {
      try {
        const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (stored && typeof stored === "object" && "version" in stored && stored.version === 1 && "mode" in stored)
          return inspectionModeOrDefault(stored.mode);
      } catch { /* Missing or invalid legacy settings default to no SDK access. */ }
      return "standard";
    },
    async save(mode: InspectionMode) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, mode }), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
    },
  };
}

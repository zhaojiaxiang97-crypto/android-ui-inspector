import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const project = fileURLToPath(new URL("../", import.meta.url));
export async function buildWebpAlpha(output = join(project, "dist-electron")) {
  await mkdir(output, { recursive: true });
  const result = spawnSync("bun", ["build", "electron/desktop/webp-alpha-worker.ts", "--target", "node", "--format", "cjs",
    "--external", "sharp", "--outfile", join(output, "webp-alpha-worker.cjs")], { cwd: project, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("WebP alpha worker build failed");
  return join(output, "webp-alpha-worker.cjs");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWebpAlpha(process.argv[2]);

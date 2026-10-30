import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { HelperCaptureError } from "../../electron/capture/accessibility-helper";
import { readHelperObservation } from "../../electron/capture/helper-observation";
import { helperPackage, helperPayload, helperToken } from "./helper-protocol";

async function main() {
  const frame = { width: 1024, height: 2048, rotation: 0 as const };
  const png = await sharp(randomBytes(frame.width * frame.height * 3), { raw: { ...frame, channels: 3 } })
    .png({ compressionLevel: 0 }).toBuffer();
  const base64 = png.toString("base64");
  assert.ok(base64.length > 6 * 1024 * 1024);
  const payload = { ...helperPayload(base64), ...frame };
  payload.helperObservation.displayBefore = { ...frame };
  payload.helperObservation.displayAfter = { ...frame };
  const read = (encoded: string) => readHelperObservation(12345, helperToken, helperPackage, frame,
    new AbortController().signal, (async () => Response.json({ ...payload, screenshot_base64: encoded })) as typeof fetch);
  const result = await read(base64);
  assert.equal(result.screenshotDataUrl, `data:image/png;base64,${base64}`);
  for (const invalid of [base64 + "A", base64 + "====", base64.slice(0, -4) + "A===", base64.slice(0, -1) + "\n", "AA=A", "AA-_", "AAAA\n"])
    await assert.rejects(read(invalid), error => error instanceof HelperCaptureError && error.code === "helper-image");
  console.log(JSON.stringify({ acceptedLargePng: true, rejectedMalformedBase64: 7 }));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });

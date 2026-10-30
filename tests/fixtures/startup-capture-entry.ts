import { inspectPreferredDevice } from "../../electron/capture/inspection";
import { createProviderSessionPool } from "../../electron/sdk/provider-session";
const provider = createProviderSessionPool();

const progress: string[] = [];
const started = performance.now();
console.log("readiness probe started");
try {
  const snapshot = await inspectPreferredDevice(provider, "startup-fixture", {
    expectedPackage: "com.example.startup",
    onProgress: stage => progress.push(stage),
  });
  console.log(JSON.stringify({ durationMs: Math.round(performance.now() - started), progress,
    root: snapshot.root, nodeCount: snapshot.nodeCount, error: snapshot.error,
    screenshotDataUrl: snapshot.screenshotDataUrl, diagnostics: snapshot.captureRequestDiagnostics }));
} finally { await provider.dispose(); }

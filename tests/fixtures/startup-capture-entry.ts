import { inspectPreferredDevice } from "../../electron/capture/inspection";
import { closeProviderSessions } from "../../electron/sdk/provider-session";

const progress: string[] = [];
const started = performance.now();
console.log("readiness probe started");
try {
  const snapshot = await inspectPreferredDevice("startup-fixture", {
    expectedPackage: "com.example.startup",
    onProgress: stage => progress.push(stage),
  });
  console.log(JSON.stringify({ durationMs: Math.round(performance.now() - started), progress,
    root: snapshot.root, nodeCount: snapshot.nodeCount, error: snapshot.error,
    screenshotDataUrl: snapshot.screenshotDataUrl, diagnostics: snapshot.captureRequestDiagnostics }));
} finally { closeProviderSessions(); }

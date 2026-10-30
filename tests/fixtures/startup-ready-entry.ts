import { inspectDevice } from "../../electron/capture/inspection";
import { createProviderSessionPool } from "../../electron/sdk/provider-session";
const provider = createProviderSessionPool();
const controller = new AbortController();
const progress: string[] = [];
const cancelTimer = process.env.STARTUP_READY_FIXTURE === "cancel-wait"
  ? setTimeout(() => controller.abort(new Error("readiness fixture user cancel")), 300) : null;
try {
  const snapshot = await inspectDevice(provider, "startup-fixture", { expectedPackage: "com.example.startup", signal: controller.signal,
    onProgress(stage) {
      progress.push(stage);
      if (stage === "读取完整控件属性") throw new Error("readiness fixture stop before images");
    } });
  console.log(JSON.stringify({ error: snapshot.error, progress, root: snapshot.root,
    readiness: snapshot.captureReadiness, diagnostics: snapshot.captureRequestDiagnostics }));
} catch (error) {
  console.log(JSON.stringify({ error: String(error), progress }));
} finally {
  if (cancelTimer) clearTimeout(cancelTimer);
  await provider.dispose();
}

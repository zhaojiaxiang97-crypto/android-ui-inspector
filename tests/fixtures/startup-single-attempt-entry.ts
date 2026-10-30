import { inspectPreferredDevice } from "../../electron/capture/inspection";
import { createProviderSessionPool } from "../../electron/sdk/provider-session";
const provider = createProviderSessionPool();
const mode = process.env.STARTUP_POLICY_FIXTURE;
const controller = new AbortController();
const progress: string[] = [];
let captureStages = 0;
try {
  const snapshot = await inspectPreferredDevice(provider, "startup-fixture", {
    expectedPackage: "com.example.startup", signal: controller.signal,
    singleAttempt: mode === "single" || mode === "cancel-single" ? true : mode === "explicit-default" ? false : undefined,
    onProgress(stage) {
      progress.push(stage);
      if (stage === "读取完整控件属性") {
        captureStages++;
        if (mode === "cancel-single") controller.abort(new Error("single fixture user cancel"));
        throw new Error(captureStages === 1 ? "App 仍在启动：single fixture first failure" : "single fixture second failure");
      }
      if (mode === "cancel-default" && stage === "等待 App 页面稳定") controller.abort(new Error("single fixture user cancel"));
    },
  });
  console.log(JSON.stringify({ error: snapshot.error, root: snapshot.root, captureStages, progress,
    diagnostics: snapshot.captureRequestDiagnostics }));
} catch (error) {
  console.log(JSON.stringify({ error: (error as Error).message, captureStages, progress }));
} finally { await provider.dispose(); }

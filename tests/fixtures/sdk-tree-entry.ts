import { inspectHybridDevice } from "../../electron/capture/inspection";
import { createProviderSessionPool } from "../../electron/sdk/provider-session";
const provider = createProviderSessionPool();
try {
  await inspectHybridDevice(provider, "startup-fixture", "com.example.startup", {
    inspectionMode: "sdk-enhanced",
    singleAttempt: process.argv[2] === "single" ? true : process.argv[2] === "false" ? false : undefined,
  });
  throw Error("fixture unexpectedly succeeded");
} catch (error) {
  console.log(JSON.stringify({ error: (error as Error).message }));
} finally { await provider.dispose(); }

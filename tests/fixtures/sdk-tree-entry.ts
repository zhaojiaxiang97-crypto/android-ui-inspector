import { inspectHybridDevice } from "../../electron/capture/inspection";
import { closeProviderSessions } from "../../electron/sdk/provider-session";
try {
  await inspectHybridDevice("startup-fixture", "com.example.startup", {
    singleAttempt: process.argv[2] === "single" ? true : process.argv[2] === "false" ? false : undefined,
  });
  throw Error("fixture unexpectedly succeeded");
} catch (error) {
  console.log(JSON.stringify({ error: (error as Error).message }));
} finally { await closeProviderSessions(); }

import { inspectDevice } from "../../electron/capture/inspection";
import { closeProviderSessions } from "../../electron/sdk/provider-session";
import { startupRetryBudget } from "../../electron/capture/startup-retry-budget";
const parent = new AbortController();
if (process.env.BUDGET_USER_CANCEL === "1") parent.abort(new Error("user cancelled"));
const budget = startupRetryBudget(25, parent.signal);
try {
  const value = await inspectDevice("startup-fixture", {signal: budget.signal});
  console.log(JSON.stringify({error: value.error, root: value.root, nodeCount: value.nodeCount,
    diagnostics: value.captureRequestDiagnostics}));
} catch (error) { console.log(JSON.stringify({thrown: String(error)})); }
finally { budget.dispose(); closeProviderSessions(); }

import { singleAppPid } from "../../electron/device/target";
import { join } from "node:path";

const mode = process.argv[2];
const current = mode === "fresh" ? undefined : {
  packageName: mode === "wrong-package" ? "com.example.other" : "com.example.startup",
  activityName: mode === "switched" ? ".OtherActivity" : ".MainActivity",
  component: mode === "switched" ? "com.example.startup/.OtherActivity" : "com.example.startup/.MainActivity",
  windowId: "abc",
};
try {
  const pid = await singleAppPid(join(import.meta.dirname, "startup-adb/platform-tools/adb"), "startup-fixture", "com.example.startup", current);
  console.log(JSON.stringify({ pid }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}

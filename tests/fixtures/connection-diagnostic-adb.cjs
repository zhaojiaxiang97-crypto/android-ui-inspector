#!/usr/bin/env node
// Offline diagnosis fixture: never delegates to ADB or contacts a phone.
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (!process.env.DIAGNOSTIC_ADB_LOG) process.exit(2);
appendFileSync(process.env.DIAGNOSTIC_ADB_LOG, JSON.stringify(args) + "\n");
const serial = "diagnostic-fixture", app = "com.example.diagnostics";
if (args.join(" ") === "version") {
  if (process.env.DIAGNOSTIC_ADB_DELAY) setTimeout(() => console.log("Android Debug Bridge version 1.0.41"), 10_000);
  else console.log("Android Debug Bridge version 1.0.41");
} else if (args.join(" ") === "devices -l") {
  console.log(`List of devices attached\n${serial}\t${process.env.DIAGNOSTIC_DEVICE_STATE || "device"} model:Fixture transport_id:1`);
} else {
  if (args[0] !== "-s" || args[1] !== serial) process.exit(2);
  const command = args.slice(2).join(" ");
  if (command === "shell getprop ro.build.version.release") console.log("15");
  else if (command === "shell dumpsys window policy") console.log(`mShowingLockscreen=${process.env.DIAGNOSTIC_LOCKED ? "true" : "false"}`);
  else if (command === "shell dumpsys activity activities") console.log(`mResumedActivity: ActivityRecord{abc u0 ${app}/.Main t1}`);
  else if (command === "shell dumpsys window windows") console.log(`mCurrentFocus=Window{111 u0 ${app}/.Main}`);
  else if (command === `shell run-as ${app} id`) console.log(`uid=10001(${app})`);
  else if (command === `shell dumpsys package ${app}`) console.log(`Package [${app}]`);
  else if (command === "shell settings get secure enabled_accessibility_services") console.log("null");
  else { console.error("Unexpected diagnostic fixture command"); process.exit(2); }
}

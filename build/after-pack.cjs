const { resolve } = require("node:path");
const { prepareWindowsRuntime } = require("../scripts/prepare-windows-runtime.cjs");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const expected = resolve(__dirname, "../release/win-unpacked");
  if (resolve(context.appOutDir) !== expected) throw new Error("Windows runtime permission hook expects release/win-unpacked");
  prepareWindowsRuntime("Unpacked");
};

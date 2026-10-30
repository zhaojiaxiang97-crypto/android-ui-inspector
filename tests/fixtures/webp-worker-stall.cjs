const { parentPort } = require("node:worker_threads");
parentPort.on("message", () => {
  const end = performance.now() + 2000;
  while (performance.now() < end) { /* Simulate an unresponsive decoder. */ }
  parentPort.postMessage(true);
});

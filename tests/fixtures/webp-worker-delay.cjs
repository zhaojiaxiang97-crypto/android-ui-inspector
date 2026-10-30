const { parentPort } = require("node:worker_threads");
parentPort.on("message", () => setTimeout(() => parentPort.postMessage(true), 1100));

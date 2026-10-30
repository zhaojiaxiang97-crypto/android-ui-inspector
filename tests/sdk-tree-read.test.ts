import assert from "node:assert/strict";
import { test } from "node:test";
import { requestSdkTree } from "../electron/sdk/sdk-tree-read";

const timeout = { code: 0, stdout: Buffer.from("Result: Bundle[{error=View tree timed out}]") };
const ok = { code: 0, stdout: Buffer.from("Result: Bundle[{result=ok}]") };
test("strict tree read never retries a UI timeout", async () => {
  let calls = 0;
  await assert.rejects(requestSdkTree(async () => { calls++; return timeout; }, true), /SDK 控件树超时/);
  assert.equal(calls, 1);
});
test("default tree read retains bounded retry and returns second success", async () => {
  let calls = 0;
  assert.equal(await requestSdkTree(async () => ++calls === 1 ? timeout : ok, false), ok);
  assert.equal(calls, 2);
});
test("default repeated timeout stops after two calls", async () => {
  let calls = 0;
  await assert.rejects(requestSdkTree(async () => { calls++; return timeout; }, false), /连续超时/);
  assert.equal(calls, 2);
});
test("transport failures and other SDK errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(requestSdkTree(async () => { calls++; throw Error("transport failed"); }, false), /transport failed/);
  assert.equal(calls, 1);
  const other = { code: 0, stdout: Buffer.from("Result: Bundle[{error=Window is detached}]") };
  assert.equal(await requestSdkTree(async () => other, false), other);
});
test("cancellation before dispatch or after reply preserves reason and prevents retry", async () => {
  const controller = new AbortController();
  const reason = Error("user cancelled tree");
  let calls = 0;
  await assert.rejects(requestSdkTree(async () => {
    calls++; controller.abort(reason); return timeout;
  }, false, controller.signal), error => error === reason);
  await assert.rejects(requestSdkTree(async () => { calls++; return ok; }, false, controller.signal), error => error === reason);
  assert.equal(calls, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { commandSignal } from "../electron/device/command-context";
import { createInspectionRunner } from "../electron/capture/inspection";
import { createProviderSessionPool, type ProviderClient } from "../electron/sdk/provider-session";

// Real snapshot orchestrator and session transport. Only device observations,
// image acquisition and screenshot pixels are fixture boundaries.
for (const mode of ["warm", "cold", "cancel-image", "cancel-before-images", "changed-after-images", "wrong-package"]) {
  test(`capture orchestration uses default session preparation safely: ${mode}`, async () => {
    const controller = new AbortController();
    const reason = new Error("flow fixture cancelled");
    const calls: string[][] = [], requests: string[] = [], sockets = new Set<net.Socket>();
    let serviceReady = mode !== "cold", changed = false, prepared = 0, screens = 0, late = 0;
    const target = { packageName: "sample.app", component: "sample.app/.MainActivity", activityName: ".MainActivity", activityRecordId: "abc", windowId: "aaa" };
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          requests.push(request.method);
          if (request.method === "session-probe") {
            if (!serviceReady) socket.destroy();
            else socket.write("Result: Bundle[{error=Unknown session method}]\n");
          } else if (mode === "cancel-image" && late === 0) {
            controller.abort(reason);
            setTimeout(() => { late++; if (!socket.destroyed) socket.write("Result: Bundle[{result=ok}]\n"); }, 30);
          } else socket.write("Result: Bundle[{result=ok}]\n");
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const ok = (text = "") => ({ code: 0, stdout: Buffer.from(text), stderr: "" });
    const dependencies = {
      runDeviceAdb: async (_adb: string, _serial: string, args: string[]) => {
        commandSignal()?.throwIfAborted(); calls.push(args);
        const command = args.join(" ");
        if (command === "forward tcp:0 localabstract:sample.app.inspector.session") {
          assert.ok(prepared >= 2 && prepared % 2 === 0, "prepare only after focus checks bracket the tree"); return ok(String(port));
        }
        if (command === `forward --remove tcp:${port}`) return ok();
        if (args.includes("open-session")) { assert.equal(mode, "cold"); assert.ok(!args.includes("--extra")); serviceReady = true; return ok("Result: Bundle[{result=ok}]"); }
        if (command === "shell dumpsys activity activities") return ok(`mResumedActivity: ActivityRecord{${changed ? "def" : "abc"} u0 ${mode === "wrong-package" ? "other.app" : "sample.app"}/.MainActivity t1}`);
        if (command === "shell run-as sample.app id") return ok("uid=10001(sample.app)");
        if (command === "shell dumpsys activity sample.app") return ok("ACTIVITY sample.app/.MainActivity abc pid=42\n    View Hierarchy:\n      DecorView@abcdef[MainActivity]\n        android.widget.TextView{123456 V.E...... ........ 0,0-100,100}\n    Looper (main)");
        assert.fail(`unexpected command: ${command}`);
      },
      runCommand: () => assert.fail("no content fallback or duplicate capture"),
      findAdbPath: () => "fixture-adb", commandError: (message: string) => message,
      readDebugFocus: async () => ({ id: target.windowId, packageName: target.packageName }),
      checkedDebugTarget: async () => { prepared++; return target; },
      captureDebugViewImages: async (provider: ProviderClient) => {
        const timings: Record<string, number> = {};
        await provider.call("fixture-adb", "fixture", target.packageName, "capture-visible", "0123456789abcdef", null, 1000,
          false, undefined, undefined, { startedAt: performance.now(), timings });
        if (mode === "changed-after-images") changed = true;
        return { imageCount: 0, finalScreen: null }; // Fixture supplies no real Android image bytes.
      },
      captureScreen: async () => { screens++; return { screenshotDataUrl: "fixture-no-pixels", result: ok(), captureGeometry: undefined }; },
    };
    const api = createInspectionRunner(dependencies);
    const pool = createProviderSessionPool({ idleMs: 0, runDeviceAdb: dependencies.runDeviceAdb, runCommand: dependencies.runCommand });
    try {
      const capture = api.inspectDevice(pool, "fixture", {
        expectedPackage: target.packageName, signal: controller.signal,
        onProgress: (stage: string) => { if (mode === "cancel-before-images" && stage === "读取完整控件属性") controller.abort(reason); },
      });
      if (mode.startsWith("cancel-")) {
        await assert.rejects(capture, error => error === reason);
        assert.equal(screens, 0);
        if (mode === "cancel-image") { await wait(60); assert.equal(late, 1); }
      } else {
        const snapshot = await capture;
        if (mode === "changed-after-images" || mode === "wrong-package") {
          assert.match(snapshot.error!, /前台.*变化/); assert.equal(snapshot.root, null); assert.equal(snapshot.screenshotDataUrl, null);
        } else { assert.equal(snapshot.error, null); assert.ok(snapshot.root); assert.equal(snapshot.captureReadiness?.phase, "ready"); }
      }
      if (mode === "warm" || mode === "cancel-image") {
        const recovered = await api.inspectDevice(pool, "fixture", { expectedPackage: target.packageName });
        assert.equal(recovered.error, null); assert.ok(recovered.root);
        assert.equal(calls.filter(args => args[0] === "forward" && args[1] === "tcp:0").length,
          mode === "warm" ? 1 : 2, "reuse a healthy socket, replace only the cancelled socket");
      }
      assert.equal(requests.filter(value => value === "capture-visible").length,
        mode === "cancel-before-images" || mode === "wrong-package" ? 0 : mode === "warm" || mode === "cancel-image" ? 2 : 1);
      assert.equal(calls.filter(args => args.includes("open-session")).length, mode === "cold" ? 1 : 0);
      assert.ok(calls.every(args => !args.includes("sessionTiming:b:true")));
    } finally {
      await pool.dispose();
      const forwards = calls.filter(args => args[0] === "forward" && args[1] === "tcp:0").length;
      assert.equal(calls.filter(args => args[0] === "forward" && args[1] === "--remove").length, forwards);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

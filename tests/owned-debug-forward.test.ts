import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { openOwnedDebugForward, type ForwardExecute } from "../electron/platform/owned-debug-forward";

// All device commands are replaced; the TCP test below only uses localhost.
function fixture() {
  const controller = new AbortController(), commands: string[][] = [];
  const mappings = new Map<string, string>([["foreign tcp:9999", "jdwp:888"]]);
  let before: ((operation: string[]) => void) | undefined;
  let after: ((operation: string[]) => void) | undefined;
  let list: (() => string) | undefined;
  const execute: ForwardExecute = async (args, timeout, signal) => {
    assert.deepEqual(args.slice(0, 2), ["-s", "fixture"]);
    assert.equal(timeout, 750); assert.equal(signal, undefined, "cleanup outlives the caller's abort");
    const operation = args.slice(2); commands.push(operation);
    assert.equal(operation[0], "forward"); assert.notEqual(operation[1], "--remove-all");
    assert.ok(!operation.includes("tcp:0"));
    before?.(operation);
    if (operation[1] === "--list")
      return list ? list() : [...mappings].map(([key, remote]) => `${key} ${remote}`).join("\n");
    const noRebind = operation[1] === "--no-rebind";
    const local = operation[noRebind || operation[1] === "--remove" ? 2 : 1];
    const key = `fixture ${local}`;
    if (operation[1] === "--remove") mappings.delete(key);
    else {
      if (noRebind && mappings.has(key)) throw Error("port collision");
      mappings.set(key, operation[noRebind ? 3 : 2]);
    }
    after?.(operation); return "";
  };
  const open = (remote = "jdwp:42", choosePort = async () => 12001) =>
    openOwnedDebugForward("fixture", remote, controller.signal, execute, choosePort);
  return { controller, commands, mappings, execute, open,
    setBefore: (hook: typeof before) => { before = hook; }, setAfter: (hook: typeof after) => { after = hook; },
    setList: (hook: typeof list) => { list = hook; } };
}

test("owned forward needs no SDK identity; JDWP, localabstract and TCP retain exact command order", async () => {
  for (const remote of ["jdwp:42", "localabstract:example.app.inspector.session", "tcp:18888"]) {
    const f = fixture(); assert.deepEqual(f.commands, []);
    const lease = await f.open(remote);
    const marker = f.commands[1][3];
    assert.match(marker, /^localabstract:inspector\.queue\.[a-f0-9-]{36}$/);
    assert.deepEqual(f.commands, [
      ["forward", "--list"], ["forward", "--no-rebind", "tcp:12001", marker],
      ["forward", "--list"], ["forward", "tcp:12001", remote], ["forward", "--list"],
    ]);
    const first = lease.close(); assert.equal(lease.close(), first);
    await Promise.all([first, lease.close()]);
    assert.deepEqual(f.commands.slice(5), [["forward", "--list"], ["forward", "--remove", "tcp:12001"], ["forward", "--list"]]);
    assert.deepEqual([...f.mappings], [["foreign tcp:9999", "jdwp:888"]]);
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  }
});

test("invalid direct targets and pre-cancellation cause no commands or port selection", async () => {
  const f = fixture(); let selections = 0;
  const choose = async () => { selections++; return 12001; };
  for (const serial of ["", "x y", null] as unknown as string[])
    await assert.rejects(openOwnedDebugForward(serial, "jdwp:42", f.controller.signal, f.execute, choose), /Invalid/);
  for (const remote of ["jdwp:0", "jdwp:-1", "jdwp:1.5", "jdwp:9007199254740992", "tcp:0", "tcp:65536", "tcp:-1", "tcp:1.5",
    "localabstract:", "localabstract:x y", null] as unknown as string[])
    await assert.rejects(openOwnedDebugForward("fixture", remote, f.controller.signal, f.execute, choose), /Invalid/);
  const reason = Error("cancel before open"); f.controller.abort(reason);
  await assert.rejects(f.open("jdwp:42", choose), error => error === reason);
  assert.equal(selections, 0); assert.deepEqual(f.commands, []);
});

test("bad ports, rejected selection and cancellation during selection never reserve", async () => {
  for (const port of [0, -1, 1.5, 65536, NaN]) {
    const f = fixture(); await assert.rejects(f.open("jdwp:42", async () => port), /Invalid owned forward port/);
    assert.deepEqual(f.commands, []);
  }
  const f = fixture(); await assert.rejects(f.open("jdwp:42", async () => { throw Error("no port"); }), /no port/);
  await assert.rejects(f.open("jdwp:42", async () => { f.controller.abort(Error("cancel selection")); return 12001; }), /cancel selection/);
  assert.deepEqual(f.commands, []);
});

test("lost creation and binding replies clean only the attributable mapping without retry", async () => {
  for (const phase of ["reservation", "binding"]) {
    const f = fixture(); f.setAfter(args => {
      if (phase === "reservation" ? args[1] === "--no-rebind" : args[1] === "tcp:12001") throw Error(`lost ${phase} reply`);
    });
    await assert.rejects(f.open(), new RegExp(`lost ${phase} reply`));
    assert.equal(f.mappings.has("fixture tcp:12001"), false);
    assert.equal(f.commands.filter(args => args[1] === "--no-rebind").length, 1);
    assert.equal(f.commands.filter(args => args[1] === "--remove").length, 1);
  }
});

test("cancellation at reservation or binding still confirms cleanup with independent commands", async () => {
  for (const phase of ["reservation", "binding"]) {
    const f = fixture(), reason = Error(`cancel ${phase}`);
    f.setAfter(args => {
      if (phase === "reservation" ? args[1] === "--no-rebind" : args[1] === "tcp:12001") f.controller.abort(reason);
    });
    await assert.rejects(f.open(), error => error === reason);
    assert.equal(f.mappings.has("fixture tcp:12001"), false);
    assert.equal(f.commands.filter(args => args[1] === "--remove").length, 1);
  }
  const f = fixture(), lease = await f.open(); f.controller.abort(Error("cancel after ready"));
  await lease.close(); assert.equal(f.mappings.has("fixture tcp:12001"), false);
});

test("existing mappings, reservation races and foreign replacements never authorize removal", async () => {
  for (const phase of ["existing", "race", "reservation", "binding", "ready"]) {
    const f = fixture(), key = "fixture tcp:12001";
    if (phase === "existing") f.mappings.set(key, "jdwp:777");
    if (phase === "race") f.setBefore(args => { if (args[1] === "--no-rebind") f.mappings.set(key, "jdwp:777"); });
    if (phase === "reservation" || phase === "binding") f.setAfter(args => {
      if (phase === "reservation" ? args[1] === "--no-rebind" : args[1] === "tcp:12001") f.mappings.set(key, "jdwp:777");
    });
    if (phase === "ready") {
      const lease = await f.open(); f.mappings.set(key, "jdwp:777");
      await assert.rejects(lease.close(), /refusing removal/);
    } else await assert.rejects(f.open(), /already in use|refusing removal/);
    assert.equal(f.mappings.get(key), "jdwp:777");
    assert.equal(f.commands.some(args => args[1] === "--remove"), false);
    assert.equal(f.mappings.get("foreign tcp:9999"), "jdwp:888");
  }
});

test("lost removal reply is verified by absence; remaining mapping is retained as a failed cleanup", async () => {
  for (const remains of [false, true]) {
    const f = fixture(), lease = await f.open();
    f.setAfter(args => {
      if (args[1] !== "--remove") return;
      if (remains) f.mappings.set("fixture tcp:12001", "jdwp:42");
      throw Error("lost removal reply");
    });
    if (remains) {
      await assert.rejects(lease.close(), /cleanup not confirmed: lost removal reply/);
      await assert.rejects(lease.close(), /cleanup not confirmed/);
    } else await lease.close();
    assert.equal(f.commands.filter(args => args[1] === "--remove").length, 1);
    assert.equal(f.mappings.has("fixture tcp:12001"), remains);
  }
});

test("malformed, ambiguous, oversized and over-count lists refuse mutation", async () => {
  for (const reply of ["fixture tcp:12001", "fixture tcp:12001 jdwp:42 extra",
    "fixture tcp:12001 jdwp:42\nfixture tcp:12001 jdwp:43", "x".repeat(8193), "中".repeat(3000),
    Array.from({ length: 129 }, (_, i) => `fixture tcp:${i + 1} jdwp:42`).join("\n"), null]) {
    const f = fixture(); f.setList(() => reply as string);
    await assert.rejects(f.open(), /Invalid|Ambiguous|limit exceeded/);
    assert.equal(f.commands.length, 1); assert.equal(f.mappings.size, 1);
  }
});

test("lost ownership read does not assume absence or erase an unverified mapping", async () => {
  const f = fixture(), lease = await f.open();
  f.setBefore(args => { if (args[1] === "--list") throw Error("ownership read failed"); });
  await assert.rejects(lease.close(), /ownership read failed/);
  assert.equal(f.commands.some(args => args[1] === "--remove"), false);
  assert.equal(f.mappings.get("fixture tcp:12001"), "jdwp:42");
});

test("invalid ownership evidence after creation reports failure instead of blindly cleaning", async () => {
  for (const reply of ["malformed", "x".repeat(8193), "fixture tcp:12001 jdwp:42\nfixture tcp:12001 jdwp:43"]) {
    const f = fixture();
    f.setAfter(args => { if (args[1] === "--no-rebind") f.setList(() => reply); });
    await assert.rejects(f.open(), /Invalid|Ambiguous/);
    assert.match(f.mappings.get("fixture tcp:12001")!, /^localabstract:inspector\.queue\./);
    assert.equal(f.commands.some(args => args[1] === "--remove" || args[1] === "tcp:12001"), false);
  }
});

test("cancellation during the initial ownership read stops before reservation", async () => {
  const f = fixture(), reason = Error("cancel initial list");
  f.setBefore(args => { if (args[1] === "--list") f.controller.abort(reason); });
  await assert.rejects(f.open(), error => error === reason);
  assert.ok(f.commands.every(args => args[1] === "--list"));
  assert.equal(f.mappings.size, 1);
});

test("unique reservations can coexist; one lease never removes the other", async () => {
  const f = fixture(), a = await f.open(), b = await f.open("jdwp:43", async () => 12002);
  const markers = f.commands.filter(args => args[1] === "--no-rebind").map(args => args[3]);
  assert.equal(new Set(markers).size, 2);
  await a.close(); assert.equal(f.mappings.get("fixture tcp:12002"), "jdwp:43");
  await b.close(); assert.equal(f.mappings.size, 1);
});

test("default port selection releases its listener for a real local TCP connection", async t => {
  const f = fixture();
  const lease = await openOwnedDebugForward("fixture", "jdwp:42", f.controller.signal, f.execute);
  t.after(lease.close);
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket)); socket.on("data", data => socket.write(data));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(lease.port, "127.0.0.1", resolve); });
  const socket = createConnection({ host: "127.0.0.1", port: lease.port }); t.after(() => socket.destroy());
  const received = new Promise<Buffer>((resolve, reject) => {
    socket.setTimeout(1000, () => reject(Error("local TCP timeout")));
    socket.once("error", reject); socket.once("data", data => resolve(data));
  });
  socket.write("local-forward-fixture"); assert.equal((await received).toString(), "local-forward-fixture");
  socket.destroy(); await lease.close();
  assert.equal(f.mappings.size, 1);
});

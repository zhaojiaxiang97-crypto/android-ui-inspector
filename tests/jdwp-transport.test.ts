import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { connectJdwp, MAX_PACKET_BYTES, requestChunk, requestJdwpCommand } from "../electron/capture/jdwp-transport";

const handshake = Buffer.from("JDWP-Handshake");
function reply(id: number, payload: Buffer, error = 0, event = false) {
  const header = Buffer.alloc(11);
  header.writeUInt32BE(11 + payload.length); header.writeUInt32BE(id, 4);
  header[8] = event ? 0 : 0x80; header.writeUInt16BE(error, 9);
  return Buffer.concat([header, payload]);
}
function chunk(type: string, data: Buffer, reportedLength = data.length) {
  const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(reportedLength, 4);
  return Buffer.concat([header, data]);
}
async function withServer(accept: (socket: Socket) => void, run: (port: number) => Promise<void>) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.setNoDelay(true); socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket)); accept(socket);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await run(address.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
function protocol(handler: (request: Buffer, socket: Socket) => void) {
  return (socket: Socket) => {
    let buffer = Buffer.alloc(0), ready = false;
    socket.on("data", bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      if (!ready) {
        if (buffer.length < handshake.length) return;
        assert.deepEqual(buffer.subarray(0, handshake.length), handshake);
        buffer = buffer.subarray(handshake.length); ready = true;
        socket.write(handshake.subarray(0, 3));
        setTimeout(() => { if (!socket.destroyed) socket.write(handshake.subarray(3)); }, 2);
      }
      while (buffer.length >= 11 && buffer.length >= buffer.readUInt32BE(0)) {
        const size = buffer.readUInt32BE(0), request = buffer.subarray(0, size);
        buffer = buffer.subarray(size); handler(request, socket);
      }
    });
  };
}

test("real TCP transport retains fragmented bytes, events, reply matching and DDMS timing", { timeout: 5000 }, async () => {
  const requests: Buffer[] = [];
  await withServer(protocol((request, socket) => {
    requests.push(request);
    const id = request.readUInt32BE(4);
    const value = id === 17
      ? Buffer.concat([reply(91, Buffer.from("event"), 0, true), reply(99, Buffer.from("unrelated")), reply(id, Buffer.from("first"))])
      : reply(id, chunk("VULW", Buffer.from("second")));
    socket.write(value.subarray(0, 7));
    setTimeout(() => { if (!socket.destroyed) socket.write(value.subarray(7)); }, 2);
  }), async port => {
    const { socket, reader } = await connectJdwp(port, AbortSignal.timeout(2000));
    try {
      const events: Buffer[] = [];
      const first = await requestJdwpCommand(socket, reader, 17, 1, 7, events, Buffer.from("a"), Buffer.from("b"));
      assert.equal(first.toString(), "first"); assert.deepEqual(events.map(data => data.toString()), ["event"]);
      const timing: number[][] = [];
      assert.equal((await requestChunk(socket, reader, 18, "VULW", Buffer.from("c"), (...values) => timing.push(values))).toString(), "second");
      assert.equal(timing.length, 1); assert.equal(timing[0][2], 6);
      assert.ok(timing[0][0] >= 0 && timing[0][1] >= 0);
      assert.equal(requests.length, 2);
      assert.deepEqual([...requests[0].subarray(9, 11)], [1, 7]);
      assert.equal(requests[0].subarray(11).toString(), "ab");
      assert.deepEqual([...requests[1].subarray(9, 11)], [199, 1]);
      assert.equal(requests[1].subarray(11, 15).toString(), "VULW");
      assert.equal(requests[1].readUInt32BE(15), 1);
    } finally { socket.destroy(); }
  });
});

test("real TCP rejects packet limits, JDWP errors and truncated replies without retry", { timeout: 5000 }, async () => {
  for (const mode of ["short", "oversized", "error", "truncated"] as const) {
    let requests = 0;
    await withServer(protocol((request, socket) => {
      requests++;
      const id = request.readUInt32BE(4);
      if (mode === "error") socket.write(reply(id, Buffer.alloc(0), 13));
      else if (mode === "truncated") socket.end(reply(id, Buffer.from("payload")).subarray(0, 13));
      else { const header = Buffer.alloc(11); header.writeUInt32BE(mode === "short" ? 10 : MAX_PACKET_BYTES + 1); socket.write(header); }
    }), async port => {
      const { socket, reader } = await connectJdwp(port, AbortSignal.timeout(1000));
      try {
        await assert.rejects(requestJdwpCommand(socket, reader, 1, 1, 7, []),
          mode === "error" ? /JDWP 1\/7: 13/ : mode === "truncated" ? /提前关闭/ : /Invalid JDWP packet size/);
        assert.equal(requests, 1);
      } finally { socket.destroy(); }
    });
  }
});

test("real TCP DDMS retains failure, length and empty-payload checks", { timeout: 5000 }, async () => {
  for (const mode of ["length", "failure", "empty", "error", "oversized"] as const) {
    await withServer(protocol((request, socket) => {
      const id = request.readUInt32BE(4);
      if (mode === "oversized") { const header = Buffer.alloc(11); header.writeUInt32BE(MAX_PACKET_BYTES + 1); socket.write(header); return; }
      socket.write(reply(id, mode === "empty" || mode === "error" ? Buffer.alloc(0)
        : chunk(mode === "failure" ? "FAIL" : "VULW", Buffer.from("data"), mode === "length" ? 5 : 4), mode === "error" ? 12 : 0));
    }), async port => {
      const { socket, reader } = await connectJdwp(port, AbortSignal.timeout(1000));
      try {
        const message = { length: /长度不一致/, failure: /无法抓取/, empty: /内容为空/, error: /请求失败：12/, oversized: /无效数据/ }[mode];
        await assert.rejects(requestChunk(socket, reader, 1, "VULW"), message);
      } finally { socket.destroy(); }
    });
  }
});

test("handshake rejects wrong peer, pre-cancel sends nothing, and stalled cancellation releases the connection", { timeout: 5000 }, async () => {
  let connected = 0;
  await withServer(socket => { connected++; socket.once("data", () => socket.end(Buffer.alloc(handshake.length))); }, async port => {
    const reason = new Error("before-connect");
    await assert.rejects(connectJdwp(port, AbortSignal.abort(reason)), error => error === reason);
    assert.equal(connected, 0);
    await assert.rejects(connectJdwp(port, AbortSignal.timeout(1000)), /未接受/);
    assert.equal(connected, 1);
  });
  const controller = new AbortController();
  let closed!: () => void;
  const peerClosed = new Promise<void>(resolve => { closed = resolve; });
  await withServer(socket => {
    socket.once("close", closed);
    socket.once("data", () => controller.abort());
  }, async port => {
    await assert.rejects(connectJdwp(port, controller.signal), { name: "AbortError" });
    await peerClosed;
  });
});

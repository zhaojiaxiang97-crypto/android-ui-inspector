const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createJdwpClient } = require('../scripts/lib/startup-stack-observer.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function reply(request, payload = Buffer.alloc(0), error = 0) {
  const b = Buffer.alloc(11 + payload.length); b.writeUInt32BE(b.length);
  b.writeUInt32BE(request.readUInt32BE(4), 4); b[8] = 0x80; b.writeUInt16BE(error, 9); payload.copy(b, 11); return b;
}
function event(id, flags = 0) {
  const b = Buffer.alloc(25); b.writeUInt32BE(b.length); b.writeUInt32BE(id, 4);
  b[8] = flags; b[9] = 64; b[10] = 100; b.write('private-event', 11); return b;
}
async function fixture(t, handler = (s, p) => s.write(reply(p)), handshake = true) {
  const sockets = new Set(), packets = [], timers = new Set();
  const later = (ms, fn) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0), first = true;
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (first) {
        if (buffer.length < 14) return; buffer = buffer.subarray(14); first = false;
        if (handshake === true) { socket.write('JDWP-'); later(5, () => { if (!socket.destroyed) socket.write('Handshake'); }); }
        else if (Buffer.isBuffer(handshake)) socket.write(handshake);
      }
      while (buffer.length >= 11) {
        const n = buffer.readUInt32BE(); if (buffer.length < n) return;
        const packet = Buffer.from(buffer.subarray(0, n)); buffer = buffer.subarray(n); packets.push(packet); handler(socket, packet, later);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const client = createJdwpClient(server.address().port, { timeoutMs: 200, handshakeMs: 100, diagnostics: true });
  t.after(async () => { client.close(); await client.closed; });
  return { client, packets, port: server.address().port };
}

test('bounded metadata distinguishes handshake, queued/flushed requests and matching fragmented replies', async t => {
  const f = await fixture(t, (socket, p, later) => {
    const b = reply(p, Buffer.from('private-reply'), p[10] === 8 ? 13 : 0);
    socket.write(b.subarray(0, 7)); later(5, () => { if (!socket.destroyed) socket.write(b.subarray(7)); });
  });
  await f.client.ready;
  assert.equal((await f.client.request(1, 7, Buffer.from('private-request'))).toString(), 'private-reply');
  await assert.rejects(f.client.request(1, 8), /error 13/);
  f.client.close(); await f.client.closed;
  const trace = f.client.diagnostics(); assert.equal(trace.clock, 'host-monotonic-relative-ms');
  assert.equal(trace.socketClosed, true); assert.equal(trace.droppedEvents, 0);
  assert.ok(trace.events.some(e => e.event === 'handshake-received' && e.bytes === 14));
  for (const event of ['request-queued', 'request-flushed', 'reply-received'])
    assert.ok(trace.events.some(e => e.event === event && e.id === 1 && e.set === 1 && e.command === 7));
  assert.ok(trace.events.some(e => e.event === 'reply-received' && e.id === 2 && e.errorCode === 13));
  assert.equal(trace.events.at(-1).event, 'socket-closed');
  assert.ok(trace.events.every((e, i, a) => Number.isFinite(e.atMs) && e.atMs >= 0 && (!i || e.atMs >= a[i - 1].atMs)));
  assert.equal(/private-request|private-reply/.test(JSON.stringify(trace)), false);
  trace.events[0].event = 'modified'; assert.notEqual(f.client.diagnostics().events[0].event, 'modified');
  trace.milestones.handshakeReceivedAtMs = -1; assert.ok(f.client.diagnostics().milestones.handshakeReceivedAtMs >= 0);
});

test('existing callers leave optional transport recording disabled', async t => {
  const f = await fixture(t); const client = createJdwpClient(f.port);
  t.after(async () => { client.close(); await client.closed; });
  await client.ready; await client.request(1, 7); assert.equal(client.diagnostics(), undefined);
});

test('200ms timeout and late unmatched reply do not satisfy a new request or cause retry', async t => {
  const f = await fixture(t, (socket, p, later) => later(p[10] === 7 ? 240 : 65,
    () => { if (!socket.destroyed) socket.write(reply(p, Buffer.from(p[10] === 7 ? 'late' : 'new'))); }));
  await f.client.ready; await assert.rejects(f.client.request(1, 7), /timeout 1\/7/);
  const before = f.client.diagnostics(), frozen = JSON.stringify(before);
  assert.equal((await f.client.request(1, 8)).toString(), 'new');
  const trace = f.client.diagnostics(); assert.equal(f.packets.length, 2);
  assert.ok(trace.events.some(e => e.event === 'request-timeout' && e.id === 1 && e.budgetMs === 200));
  assert.ok(trace.events.some(e => e.event === 'unmatched-reply' && e.id === 1));
  assert.ok(trace.events.some(e => e.event === 'reply-received' && e.id === 2));
  assert.equal(JSON.stringify(before), frozen);
  assert.equal(before.firstRequest.outcome, 'request-timeout');
  assert.equal(before.firstRequest.lateReplyAtMs, undefined);
  assert.equal(trace.firstRequest.outcome, 'request-timeout');
  assert.ok(trace.firstRequest.lateReplyAtMs >= trace.firstRequest.outcomeAtMs);
  assert.equal(trace.firstRequest.lateReplyBytes, 15);
});

test('lost response records exactly one request and its timeout, with no pause or retry', async t => {
  const f = await fixture(t, () => {}); await f.client.ready;
  await assert.rejects(f.client.request(1, 7), /timeout/);
  const trace = f.client.diagnostics(); assert.equal(f.packets.length, 1);
  assert.equal(trace.events.filter(e => e.event === 'request-queued').length, 1);
  assert.equal(trace.events.filter(e => e.event === 'request-timeout').length, 1);
  assert.equal(trace.events.some(e => e.event === 'reply-received'), false);
});

test('VM async commands with the same id are recorded but cannot satisfy a debugger reply', async t => {
  const f = await fixture(t, (socket, p) => { socket.write(event(p.readUInt32BE(4))); socket.write(event(99, 1)); socket.write(reply(p)); });
  await f.client.ready; assert.equal((await f.client.request(1, 7)).length, 0);
  const trace = f.client.diagnostics();
  assert.ok(trace.events.some(e => e.event === 'remote-command' && e.id === 1 && e.set === 64 && e.command === 100));
  assert.ok(trace.events.some(e => e.event === 'ignored-flags' && e.flags === 1));
  assert.ok(trace.events.some(e => e.event === 'reply-received' && e.id === 1));
  assert.equal(JSON.stringify(trace).includes('private-event'), false);
});

test('peer close records pending failure and actual close, not a timeout or a successful reply', async t => {
  const f = await fixture(t, socket => socket.destroy()); await f.client.ready;
  await assert.rejects(f.client.request(1, 7), /socket closed/); await f.client.closed;
  const trace = f.client.diagnostics(); assert.equal(trace.socketClosed, true);
  assert.equal(trace.firstRequest.outcome, 'request-failed');
  assert.equal(trace.firstRequest.outcomeReason, 'socket-closed');
  assert.equal(trace.firstRequest.replyBytes, undefined);
  assert.ok(trace.events.some(e => e.event === 'request-failed' && e.reason === 'socket-closed' && e.id === 1));
  assert.equal(trace.events.some(e => e.event === 'request-timeout' || e.event === 'reply-received'), false);
  const frozen = JSON.stringify(trace); await pause(20); assert.equal(JSON.stringify(trace), frozen);
});

test('handshake timeout, invalid handshake and malformed packet have separate bounded failure records', async t => {
  for (const mode of ['timeout', 'handshake', 'packet']) {
    const f = await fixture(t, socket => { const b = Buffer.alloc(11); b.writeUInt32BE(10); socket.write(b); },
      mode === 'timeout' ? false : mode === 'handshake' ? Buffer.from('invalid-14byte!') : true);
    if (mode === 'packet') { await f.client.ready; await assert.rejects(f.client.request(1, 7), /packet length/); }
    else await assert.rejects(f.client.ready, mode === 'timeout' ? /handshake timeout/ : /Invalid JDWP handshake/);
    await f.client.closed;
    assert.ok(f.client.diagnostics().events.some(e => e.event === (mode === 'timeout' ? 'handshake-timeout' : 'protocol-error')));
  }
});

test('cancellation before/after writing and rejected dispatch do not fabricate a sent request', async t => {
  const controller = new AbortController();
  const f = await fixture(t, () => controller.abort(Error('private-cancel-reason'))); await f.client.ready;
  const prior = new AbortController(); prior.abort(Error('private-prior-reason'));
  await assert.rejects(f.client.request(1, 6, undefined, { signal: prior.signal }));
  await assert.rejects(f.client.request(1, 7, undefined, { signal: controller.signal }), /private-cancel/);
  await assert.rejects(f.client.request(1, 8, undefined, { onSend: () => { throw Error('private-dispatch-reason'); } }));
  const trace = f.client.diagnostics(); assert.equal(f.packets.length, 1);
  assert.equal(trace.firstRequest.id, 1);
  assert.equal(trace.firstRequest.outcome, 'request-cancelled');
  assert.ok(trace.events.some(e => e.event === 'request-rejected' && e.reason === 'already-cancelled'));
  assert.ok(trace.events.some(e => e.event === 'request-cancelled' && e.id === 1));
  assert.ok(trace.events.some(e => e.event === 'request-rejected' && e.reason === 'dispatch-rejected' && e.id === 2));
  assert.equal(trace.events.some(e => e.event === 'request-queued' && e.id === 2), false);
  assert.equal(JSON.stringify(trace).includes('private-'), false);
});

test('64-event limit preserves first and newest events and reports dropped history explicitly', async t => {
  const f = await fixture(t, (socket, p) => socket.write(Buffer.concat([...Array.from({ length: 120 }, (_, i) => event(100 + i)), reply(p)])));
  await f.client.ready; await f.client.request(1, 7); f.client.close(); await f.client.closed;
  const trace = f.client.diagnostics(); assert.equal(trace.events.length, 64); assert.equal(trace.eventLimit, 64);
  assert.equal(trace.events[0].seq, 1); assert.equal(trace.events[0].event, 'connection-start');
  assert.equal(trace.events.at(-1).event, 'socket-closed'); assert.ok(trace.droppedEvents > 60);
  assert.equal(trace.lastSequence, trace.events.length + trace.droppedEvents);
  assert.ok(trace.events.every((e, i, a) => !i || e.seq > a[i - 1].seq));
  assert.ok(trace.milestones.handshakeReceivedAtMs >= 0); assert.ok(trace.milestones.socketClosedAtMs >= trace.milestones.handshakeReceivedAtMs);
  assert.ok(JSON.stringify(trace).length < 20000);
});

test('local close is requested separately from actual close and rejects pending work once', async t => {
  const f = await fixture(t, () => {}); await f.client.ready;
  const pending = f.client.request(1, 7).catch(error => error);
  f.client.close(); const before = f.client.diagnostics(); assert.equal(before.socketClosed, false);
  assert.ok(before.events.some(e => e.event === 'close-requested'));
  await f.client.closed; assert.match((await pending).message, /client closed/);
  assert.equal(f.client.diagnostics().socketClosed, true);
  assert.equal(f.client.diagnostics().events.filter(e => e.event === 'request-failed' && e.reason === 'client-close').length, 1);
  assert.equal(f.client.diagnostics().firstRequest.outcome, 'request-failed');
  assert.equal(f.client.diagnostics().firstRequest.outcomeReason, 'client-close');
  assert.equal(before.socketClosed, false);
});

test('invalid timeout is recorded without sending bytes or adding an outstanding request', async t => {
  const f = await fixture(t); await f.client.ready;
  await assert.rejects(f.client.request(1, 7, undefined, { timeoutMs: NaN }), /timeout/);
  await pause(10); assert.equal(f.packets.length, 0);
  assert.ok(f.client.diagnostics().events.some(e => e.event === 'request-rejected' && e.reason === 'invalid-timeout'));
  assert.equal(f.client.diagnostics().events.some(e => e.event === 'request-queued'), false);
  assert.equal(f.client.diagnostics().firstRequest, undefined);
});

test('first request summary survives more than 212 subsequent events without retaining payloads', async t => {
  const f = await fixture(t, (socket, p) => socket.write(p[10] === 7 ? reply(p, Buffer.from('private-first-reply'))
    : Buffer.concat([...Array.from({ length: 260 }, (_, i) => event(100 + i)), reply(p)])));
  await f.client.ready;
  await f.client.request(1, 7, Buffer.from('private-first-request'), { timeoutMs: 500 });
  const before = f.client.diagnostics(), frozen = JSON.stringify(before);
  await f.client.request(1, 8); f.client.close(); await f.client.closed;
  const trace = f.client.diagnostics(), first = trace.firstRequest;
  assert.equal(trace.events.length, 64); assert.ok(trace.droppedEvents > 212);
  assert.equal(trace.events.some(e => e.id === 1 && e.event === 'request-queued'), false);
  assert.equal(trace.events.some(e => e.id === 1 && e.event === 'reply-received'), false);
  assert.equal(first.id, 1); assert.equal(first.set, 1); assert.equal(first.command, 7);
  assert.equal(first.budgetMs, 500); assert.equal(first.outcome, 'reply-received');
  assert.equal(first.queuedBytes, 32); assert.equal(first.flushedBytes, 32); assert.equal(first.replyBytes, 30);
  assert.equal(first.errorCode, 0); assert.equal(first.lateReplyAtMs, undefined);
  assert.ok(first.createdAtMs >= trace.milestones.handshakeReceivedAtMs);
  assert.ok(first.queuedAtMs >= first.createdAtMs); assert.ok(first.flushedAtMs >= first.queuedAtMs);
  assert.ok(first.outcomeAtMs >= first.flushedAtMs);
  assert.deepEqual(first, before.firstRequest); assert.equal(JSON.stringify(before), frozen);
  first.outcome = 'modified'; first.queuedAtMs = -1;
  assert.equal(f.client.diagnostics().firstRequest.outcome, 'reply-received');
  assert.ok(f.client.diagnostics().firstRequest.queuedAtMs >= 0);
  assert.equal(JSON.stringify(trace).includes('private-'), false);
  assert.ok(JSON.stringify(trace).length < 20000); assert.equal(f.packets.length, 2);
});

test('only first late reply survives log eviction; timeout is never converted into success', async t => {
  const f = await fixture(t, (socket, p, later) => {
    if (p[10] === 7) {
      later(45, () => socket.write(reply(p, Buffer.from('late-one'), 13)));
      later(55, () => socket.write(reply(p, Buffer.from('late-two-longer'))));
    } else later(80, () => socket.write(Buffer.concat([...Array.from({ length: 260 }, (_, i) => event(100 + i)), reply(p)])));
  });
  await f.client.ready; await assert.rejects(f.client.request(1, 7, undefined, { timeoutMs: 20 }), /timeout/);
  const before = f.client.diagnostics(), frozen = JSON.stringify(before);
  await f.client.request(1, 8); f.client.close(); await f.client.closed;
  const trace = f.client.diagnostics(), first = trace.firstRequest;
  assert.ok(trace.droppedEvents > 212); assert.equal(first.outcome, 'request-timeout');
  assert.equal(first.outcomeAtMs, before.firstRequest.outcomeAtMs); assert.equal(first.replyBytes, undefined);
  assert.ok(first.lateReplyAtMs > first.outcomeAtMs); assert.equal(first.lateReplyBytes, 19);
  assert.equal(first.lateReplyErrorCode, 13); assert.equal(first.budgetMs, 20);
  assert.equal(JSON.stringify(before), frozen); assert.equal(before.firstRequest.lateReplyAtMs, undefined);
  const closed = JSON.stringify(trace); await pause(20); assert.equal(JSON.stringify(f.client.diagnostics()), closed);
  assert.equal(f.packets.length, 2);
});

test('first dispatch rejection has no fabricated queue/write and keeps sanitized failure only', async t => {
  const f = await fixture(t); await f.client.ready;
  await assert.rejects(f.client.request(1, 7, undefined, { onSend: () => { throw Error('private-dispatch-reason'); } }));
  const first = f.client.diagnostics().firstRequest;
  assert.equal(first.id, 1); assert.equal(first.outcome, 'request-rejected');
  assert.equal(first.outcomeReason, 'dispatch-rejected'); assert.ok(first.outcomeAtMs >= first.createdAtMs);
  assert.equal(first.queuedAtMs, undefined); assert.equal(first.flushedAtMs, undefined);
  await f.client.request(1, 8); assert.deepEqual(f.client.diagnostics().firstRequest, first);
  assert.equal(f.packets.length, 1); assert.equal(JSON.stringify(first).includes('private-'), false);
});

test('pending snapshot is isolated and cancellation stays terminal after late reply and heavy traffic', async t => {
  const controller = new AbortController();
  const f = await fixture(t, (socket, p, later) => {
    if (p[10] === 7) {
      later(10, () => controller.abort(Error('private-cancel-reason')));
      later(45, () => socket.write(reply(p)));
    } else later(70, () => socket.write(Buffer.concat([...Array.from({ length: 260 }, (_, i) => event(100 + i)), reply(p)])));
  });
  await f.client.ready;
  const pending = f.client.request(1, 7, undefined, { signal: controller.signal });
  const before = f.client.diagnostics(), frozen = JSON.stringify(before);
  assert.equal(before.firstRequest.outcome, undefined); assert.ok(before.firstRequest.queuedAtMs >= 0);
  await assert.rejects(pending, /private-cancel-reason/); await f.client.request(1, 8);
  f.client.close(); await f.client.closed;
  const trace = f.client.diagnostics(), first = trace.firstRequest;
  assert.ok(trace.droppedEvents > 212); assert.equal(first.outcome, 'request-cancelled');
  assert.ok(first.outcomeAtMs >= first.queuedAtMs); assert.ok(first.lateReplyAtMs >= first.outcomeAtMs);
  assert.equal(first.lateReplyBytes, 11); assert.equal(first.replyBytes, undefined);
  assert.equal(first.outcomeReason, undefined); assert.equal(JSON.stringify(before), frozen);
  assert.equal(JSON.stringify(trace).includes('private-'), false); assert.equal(f.packets.length, 2);
});

test('matched JDWP error and duplicate reply do not become a late timeout or overwrite the first result', async t => {
  const f = await fixture(t, (socket, p) => socket.write(Buffer.concat([reply(p, Buffer.from('private-error'), 13), reply(p)])));
  await f.client.ready; await assert.rejects(f.client.request(1, 7), /error 13/);
  const first = f.client.diagnostics().firstRequest;
  assert.equal(first.outcome, 'reply-received'); assert.equal(first.errorCode, 13);
  assert.equal(first.replyBytes, 24); assert.equal(first.lateReplyAtMs, undefined);
  assert.equal(JSON.stringify(first).includes('private-'), false); assert.equal(f.packets.length, 1);
});

test('rejection before request allocation and handshake failure do not fabricate a first transaction', async t => {
  const f = await fixture(t); await f.client.ready;
  const controller = new AbortController(); controller.abort(Error('private-prior-reason'));
  await assert.rejects(f.client.request(1, 7, undefined, { signal: controller.signal }));
  assert.equal(f.client.diagnostics().firstRequest, undefined);
  assert.equal(f.packets.length, 0);
  const broken = await fixture(t, undefined, false); await assert.rejects(broken.client.ready, /handshake timeout/);
  await broken.client.closed; assert.equal(broken.client.diagnostics().firstRequest, undefined);
});

test('socket connection error is distinct and contains only a bounded error code', async () => {
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const client = createJdwpClient(port, { diagnostics: true });
  await assert.rejects(client.ready); await client.closed;
  assert.ok(client.diagnostics().events.some(e => e.event === 'socket-error' && e.reason === 'ECONNREFUSED'));
  assert.equal(client.diagnostics().events.some(e => e.event === 'handshake-received'), false);
});

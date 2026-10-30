// Diagnostic-only helpers. No launch, install, method invocation or image capture.
const net = require('node:net');

function activityOwner(text, packageName, activityName) {
  const records = text.split(/(?=\* Hist\s+#\d+: ActivityRecord\{)/);
  const matching = records.filter(block => {
    const header = block.split('\n')[0];
    return header.includes(` ${packageName}/${activityName} `);
  });
  if (matching.length !== 1) return null;
  const block = matching[0];
  const app = block.match(/^\s*app=ProcessRecord\{\S+ (\d+):([^/\s]+)\//m);
  const record = block.match(/ActivityRecord\{(\S+)/);
  if (!app || app[2] !== packageName || !record) return null;
  return { pid: Number(app[1]), activityRecord: record[1] };
}

async function waitForOwner(read, { budgetMs = 3000, intervalMs = 100, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onObservation = () => {} } = {}) {
  const deadline = now() + budgetMs;
  while (now() < deadline) {
    const remaining = deadline - now();
    const owner = await read(remaining); // Reader must enforce this remaining budget.
    onObservation({ at: now(), owner });
    if (now() > deadline) throw Error('Activity owner read exceeded budget');
    if (owner) return owner;
    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, deadline - now()));
  }
  throw Error('Activity owner unavailable within budget');
}

function hasMainWindow(text, packageName) {
  return text.split(/Window #\d+/).some(block => {
    // Only the window's own header can establish ownership, not later IME references.
    const header = block.split('\n')[0];
    return header.includes(` u0 ${packageName}/`) && /mAttrs=\{[^\n]*\bty=BASE_APPLICATION\b/.test(block);
  });
}

async function waitForStackWindow(read, { startedAt, triggerMs = 12000, budgetMs = 15000,
  intervalMs = 1000, now = () => performance.now(), signal,
  sleep = ms => new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  }), onObservation = () => {} } = {}) {
  if (![startedAt, triggerMs, budgetMs, intervalMs].every(Number.isFinite)
      || triggerMs < 0 || budgetMs <= triggerMs || intervalMs <= 0) throw Error('Invalid stack observation budget');
  const deadline = startedAt + budgetMs;
  while (true) {
    signal?.throwIfAborted();
    const before = now();
    if (before >= deadline) throw Error('Stack window observation budget exhausted');
    // The transport must enforce the supplied remaining budget and cancellation.
    const state = await read(deadline - before, signal);
    signal?.throwIfAborted();
    const after = now();
    onObservation({ startedMs: before - startedAt, endedMs: after - startedAt, state });
    if (after >= deadline) throw Error('Stack window observation budget exhausted');
    if (typeof state?.mainWindow !== 'boolean' || !(state.focus === null || typeof state.focus === 'string')) {
      throw Error('Unknown window state; stack not admitted');
    }
    if (state.mainWindow) return { status: 'window-ready', state, observedMs: after - startedAt };
    if (state.focus !== null) throw Error('Other focused window; stack not admitted');
    // Never use a pre-threshold read as proof of the window state at 12 seconds.
    if (before - startedAt >= triggerMs) return { status: 'sample-due', state, observedMs: after - startedAt };
    await sleep(Math.min(intervalMs, Math.max(0, startedAt + triggerMs - after), deadline - after));
  }
}

function createJdwpClient(port, { timeoutMs = 1200, handshakeMs = 2000, diagnostics = false } = {}) {
  // Optional metadata only: no payloads, callbacks to external code, retries or extra waits.
  const started = diagnostics === true ? performance.now() : 0;
  const events = [], milestones = {}, startedAt = diagnostics === true ? new Date().toISOString() : undefined;
  let sequence = 0, droppedEvents = 0, transportClosed = false, firstRequest;
  const record = (event, metadata = {}) => {
    if (diagnostics !== true || transportClosed) return;
    const entry = { seq: ++sequence, atMs: performance.now() - started, event };
    for (const [key, value] of Object.entries(metadata)) {
      if ((typeof value === 'number' && Number.isFinite(value) && value >= 0) || typeof value === 'boolean') entry[key] = value;
      else if (key === 'reason' && typeof value === 'string' && /^[A-Za-z_-]{1,40}$/.test(value)) entry.reason = value;
    }
    if (event === 'socket-connected') milestones.connectedAtMs = entry.atMs;
    if (event === 'handshake-queued') milestones.handshakeQueuedAtMs = entry.atMs;
    if (event === 'handshake-flushed') milestones.handshakeFlushedAtMs = entry.atMs;
    if (event === 'handshake-received') milestones.handshakeReceivedAtMs = entry.atMs;
    if (event === 'socket-closed') milestones.socketClosedAtMs = entry.atMs;
    // Fixed scalar summary survives the ring's eviction, without retaining packets or errors.
    if (firstRequest && entry.id === firstRequest.id) {
      if (event === 'request-queued' && firstRequest.queuedAtMs === undefined) {
        firstRequest.queuedAtMs = entry.atMs; firstRequest.queuedBytes = entry.bytes;
        firstRequest.backpressure = entry.backpressure;
      }
      if (event === 'request-flushed' && firstRequest.flushedAtMs === undefined) {
        firstRequest.flushedAtMs = entry.atMs; firstRequest.flushedBytes = entry.bytes;
      }
      if (event === 'request-write-error' && firstRequest.writeErrorAtMs === undefined) firstRequest.writeErrorAtMs = entry.atMs;
      if (['reply-received', 'request-timeout', 'request-cancelled', 'request-failed', 'request-rejected'].includes(event)
          && firstRequest.outcome === undefined) {
        firstRequest.outcome = event; firstRequest.outcomeAtMs = entry.atMs;
        if (entry.reason !== undefined) firstRequest.outcomeReason = entry.reason;
        if (event === 'reply-received') { firstRequest.replyBytes = entry.bytes; firstRequest.errorCode = entry.errorCode; }
      }
      if (event === 'unmatched-reply' && firstRequest.outcome !== undefined && firstRequest.outcome !== 'reply-received'
          && firstRequest.lateReplyAtMs === undefined) {
        firstRequest.lateReplyAtMs = entry.atMs; firstRequest.lateReplyBytes = entry.bytes;
        firstRequest.lateReplyErrorCode = entry.errorCode;
      }
    }
    if (events.length === 64) { events.splice(1, 1); droppedEvents++; }
    events.push(entry);
  };
  const snapshot = () => diagnostics === true ? { clock: 'host-monotonic-relative-ms', startedAt,
    eventLimit: 64, lastSequence: sequence, droppedEvents, socketClosed: transportClosed,
    milestones: { ...milestones }, ...(firstRequest ? { firstRequest: { ...firstRequest } } : {}),
    events: events.map(event => ({ ...event })) } : undefined;
  record('connection-start', { budgetMs: handshakeMs });
  const socket = net.createConnection({ host: '127.0.0.1', port });
  let buffer = Buffer.alloc(0), handshaking = true, nextId = 1, closed = false;
  const pending = new Map();
  let readyResolve, readyReject, closedResolve;
  const closedPromise = new Promise(resolve => { closedResolve = resolve; });
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  function fail(error, reason) {
    clearTimeout(handshakeTimer);
    readyReject(error);
    for (const [id, item] of pending) {
      record('request-failed', { id, ...item.metadata, reason }); item.clear(); item.reject(error);
    }
    pending.clear();
  }
  const handshakeTimer = setTimeout(() => {
    record('handshake-timeout', { budgetMs: handshakeMs });
    fail(Error('JDWP handshake timeout'), 'handshake-timeout'); socket.destroy();
  }, handshakeMs);
  socket.on('error', error => {
    record('socket-error', { reason: typeof error.code === 'string' ? error.code : 'unknown' }); fail(error, 'socket-error');
  });
  socket.on('close', hadError => {
    closed = true; fail(Error('JDWP socket closed'), 'socket-closed');
    record('socket-closed', { hadError }); transportClosed = true; closedResolve();
  });
  const write = (packet, kind, metadata = {}) => {
    if (diagnostics !== true) { socket.write(packet); return; }
    const backpressure = !socket.write(packet, error => {
      record(error ? `${kind}-write-error` : `${kind}-flushed`, { ...metadata, bytes: Buffer.byteLength(packet), reason: error ? 'socket-write' : undefined });
    });
    record(`${kind}-queued`, { ...metadata, bytes: Buffer.byteLength(packet), backpressure });
  };
  socket.on('connect', () => { record('socket-connected'); write('JDWP-Handshake', 'handshake'); });
  socket.on('data', chunk => {
    record('bytes-received', { bytes: chunk.length });
    buffer = Buffer.concat([buffer, chunk]);
    if (handshaking) {
      if (buffer.length < 14) return;
      if (buffer.subarray(0, 14).toString() !== 'JDWP-Handshake') {
        record('protocol-error', { reason: 'invalid-handshake' });
        fail(Error('Invalid JDWP handshake'), 'invalid-handshake'); socket.destroy(); return;
      }
      buffer = buffer.subarray(14); handshaking = false;
      record('handshake-received', { bytes: 14 }); clearTimeout(handshakeTimer); readyResolve();
    }
    while (buffer.length >= 11) {
      const length = buffer.readUInt32BE(0);
      if (length < 11 || length > 8 * 1024 * 1024) {
        record('protocol-error', { reason: 'invalid-packet-length', bytes: length });
        fail(Error('Invalid JDWP packet length'), 'invalid-packet-length'); socket.destroy(); return;
      }
      if (buffer.length < length) return;
      const packet = buffer.subarray(0, length); buffer = buffer.subarray(length);
      if (packet[8] !== 0x80) {
        record(packet[8] === 0 ? 'remote-command' : 'ignored-flags', { id: packet.readUInt32BE(4),
          flags: packet[8], set: packet[9], command: packet[10], bytes: length }); continue;
      }
      const id = packet.readUInt32BE(4), item = pending.get(id);
      if (!item) {
        record('unmatched-reply', { id, bytes: length, errorCode: packet.readUInt16BE(9) });
        continue; // Late/unknown replies cannot satisfy a different request.
      }
      item.clear(); pending.delete(id);
      const error = packet.readUInt16BE(9);
      record('reply-received', { id, ...item.metadata, bytes: length, errorCode: error });
      error ? item.reject(Error(`JDWP error ${error}`)) : item.resolve(packet.subarray(11));
    }
  });
  function request(set, command, data = Buffer.alloc(0), options = {}) {
    const budget = options.timeoutMs ?? timeoutMs, signal = options.signal;
    const rejected = (reason, error) => { record('request-rejected', { set, command, reason }); return Promise.reject(error); };
    if (!Number.isFinite(budget) || budget <= 0) return rejected('invalid-timeout', Error('Invalid JDWP request timeout'));
    if (signal?.aborted) return rejected('already-cancelled', signal.reason);
    if (closed || socket.destroyed || handshaking) return rejected('not-connected', Error('JDWP not connected'));
    return new Promise((resolve, reject) => {
      const id = nextId++, packet = Buffer.alloc(11 + data.length);
      packet.writeUInt32BE(packet.length); packet.writeUInt32BE(id, 4);
      packet[9] = set; packet[10] = command; data.copy(packet, 11);
      const metadata = { set, command, budgetMs: budget };
      if (diagnostics === true && firstRequest === undefined) firstRequest = {
        id, set: packet[9], command: packet[10], budgetMs: budget, createdAtMs: performance.now() - started,
      };
      const stop = (error, event, reason) => {
        record(event, { id, ...metadata, reason }); clear(); pending.delete(id); reject(error);
      };
      const cancel = () => stop(signal.reason, 'request-cancelled');
      const timer = setTimeout(() => stop(Error(`JDWP timeout ${set}/${command}`), 'request-timeout'), budget);
      const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      pending.set(id, { resolve, reject, clear, metadata });
      signal?.addEventListener('abort', cancel, { once: true });
      try { options.onSend?.(); } catch (error) { stop(error, 'request-rejected', 'dispatch-rejected'); return; }
      try { write(packet, 'request', { id, ...metadata }); }
      catch (error) { stop(error, 'request-failed', 'socket-write'); }
    });
  }
  return { ready, request, closed: closedPromise, diagnostics: snapshot,
    close() { record('close-requested'); closed = true; fail(Error('JDWP client closed'), 'client-close'); socket.destroy(); } };
}

async function withSuspendedMain(request, main, readFrames, evidence, beforeSuspend) {
  const count = await request(11, 12, main);
  if (count.length !== 4 || count.readInt32BE() !== 0) throw Error('Main already suspended or invalid suspend count');
  // Admission failure occurs before owning a suspension, so it must not issue Resume/Dispose.
  if (beforeSuspend) await beforeSuspend();
  let frames, failure;
  evidence.pauseStartedAt = Date.now();
  try {
    // A lost reply does not prove suspend was rejected. Cleanup is still required.
    evidence.suspendRequested = true;
    await request(11, 2, main);
    frames = await readFrames();
  } catch (error) { failure = error; }
  // A transport may explicitly prove it rejected the request before writing any bytes.
  // Undefined preserves legacy adapters' conservative lost-reply recovery behavior.
  if (evidence.suspendSent === false) throw failure || Error('Suspend was not sent');
  try {
    await request(11, 3, main);
    evidence.resumeAcknowledged = true;
    const after = await request(11, 12, main);
    if (after.length !== 4 || after.readInt32BE() !== 0) throw Error('Resume count not zero');
    evidence.resumeVerified = true;
  } catch (error) {
    evidence.resumeError = error.message;
    // Do not blindly issue another resume after a lost acknowledgement.
    try { await request(1, 6); evidence.disposeAcknowledged = true; }
    catch (disposeError) { evidence.disposeError = disposeError.message; }
    failure ||= error;
  }
  evidence.pauseMs = Date.now() - evidence.pauseStartedAt;
  if (failure) throw failure;
  return frames;
}

async function withOwnedForward({ open, connect, observe, remove }, evidence) {
  let port, client;
  try {
    port = await open(); evidence.port = port;
    client = connect(port); await client.ready;
    return await observe(client);
  } finally {
    let closeFailure, closeFailed = false;
    try { client?.close(); }
    catch (error) {
      closeFailed = true; closeFailure = error;
      evidence.clientCloseError = error instanceof Error ? error.message : String(error);
    }
    if (port !== undefined) {
      try { await remove(port); evidence.forwardRemoved = true; }
      catch (error) { evidence.forwardError = error instanceof Error ? error.message : String(error); throw error; }
    }
    if (closeFailed) throw closeFailure;
  }
}

module.exports = { activityOwner, hasMainWindow, waitForOwner, waitForStackWindow, createJdwpClient, withSuspendedMain, withOwnedForward };

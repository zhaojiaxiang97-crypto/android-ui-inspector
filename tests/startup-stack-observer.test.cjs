const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { activityOwner, hasMainWindow, waitForOwner, waitForStackWindow, createJdwpClient, withSuspendedMain, withOwnedForward } = require('../scripts/lib/startup-stack-observer.cjs');
const int = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const main = Buffer.alloc(8, 1);
const block = (id, activity, app) => `* Hist #0: ActivityRecord{${id} u0 example.app/${activity} t1}\n  app=${app}\n`;

test('owner is bound to one exact Activity and its main process', () => {
  assert.deepEqual(activityOwner(block('abc', 'Home', 'ProcessRecord{z 123:example.app/u0a1}'), 'example.app', 'Home'), { pid:123, activityRecord:'abc' });
  assert.equal(activityOwner(block('abc', 'Home', 'null') + block('def', 'Other', 'ProcessRecord{z 456:example.app/u0a1}'), 'example.app', 'Home'), null);
  assert.equal(activityOwner(block('abc', 'Home', 'ProcessRecord{z 123:example.app:worker/u0a1}'), 'example.app', 'Home'), null);
  assert.equal(activityOwner(block('abc', 'Home', 'null') + block('def', 'Home', 'ProcessRecord{z 456:example.app/u0a1}'), 'example.app', 'Home'), null);
});

test('app=null can become an owner within the same bounded observation', async () => {
  let time = 0, reads = 0; const observations = [];
  const owner = { pid:123, activityRecord:'abc' };
  assert.deepEqual(await waitForOwner(async remaining => {
    assert.ok(remaining > 0); return ++reads === 3 ? owner : null;
  }, { budgetMs:250, intervalMs:100, now:()=>time, sleep:async ms=>{time+=ms;}, onObservation:x=>observations.push(x) }), owner);
  assert.equal(reads, 3); assert.equal(time, 200); assert.equal(observations.length, 3);
});

test('main window ownership uses the header, not system or splash references', () => {
  assert.equal(hasMainWindow('Window #0 Window{abc u0 example.app/Home}:\n mAttrs={(0,0) ty=BASE_APPLICATION}', 'example.app'), true);
  assert.equal(hasMainWindow('Window #0 Window{abc u0 Splash Screen example.app}:\n mAttrs={ty=APPLICATION_STARTING}', 'example.app'), false);
  assert.equal(hasMainWindow('Window #0 Window{abc u0 another.app/Home}:\n mAttrs={ty=BASE_APPLICATION}\n imeTarget=Window{def u0 example.app/Home}', 'example.app'), false);
});

test('missing owner and late owner stop at budget, without another launch', async () => {
  let time = 0, reads = 0;
  await assert.rejects(waitForOwner(async () => { reads++; return null; }, {
    budgetMs:250, intervalMs:100, now:()=>time, sleep:async ms=>{time+=ms;}
  }), /within budget/);
  assert.equal(reads, 3); assert.equal(time,250);
  await assert.rejects(waitForOwner(async () => { time+=301; return {pid:1}; }, {budgetMs:300, now:()=>time}), /exceeded budget/);
});

test('successful frame read resumes and verifies before metadata work', async () => {
  const commands=[], evidence={}; let count=0;
  const request=async(s,c)=>{commands.push(`${s}/${c}`);if(c===12)return int(count);if(c===2)count++;if(c===3)count--;return Buffer.alloc(0);};
  const frames=await withSuspendedMain(request,main,async()=>{assert.equal(count,1);return ['frame'];},evidence);
  assert.deepEqual(frames,['frame']); assert.equal(count,0); assert.equal(evidence.resumeVerified,true);
  assert.deepEqual(commands,['11/12','11/2','11/3','11/12']);
});

test('frame failure and lost suspend reply both restore own suspension', async () => {
  for(const lostSuspend of [false,true]) {
    let count=0;const evidence={};
    const request=async(s,c)=>{if(c===12)return int(count);if(c===2){count++;if(lostSuspend)throw Error('lost suspend reply');}if(c===3)count--;return Buffer.alloc(0);};
    await assert.rejects(withSuspendedMain(request,main,async()=>{throw Error('bad frames');},evidence), lostSuspend ? /lost suspend/ : /bad frames/);
    assert.equal(count,0);assert.equal(evidence.resumeVerified,true);
  }
});

test('pre-existing suspension is not resumed or disposed', async () => {
  const commands=[];
  await assert.rejects(withSuspendedMain(async(s,c)=>{commands.push(`${s}/${c}`);return int(1);},main,async()=>[],{}), /already suspended/);
  assert.deepEqual(commands,['11/12']);
});

test('lost resume reply uses dispose once, does not issue a second resume', async () => {
  const commands=[], evidence={};
  const request=async(s,c)=>{commands.push(`${s}/${c}`);if(c===12)return int(0);if(s===11&&c===3)throw Error('lost resume reply');return Buffer.alloc(0);};
  await assert.rejects(withSuspendedMain(request,main,async()=>[],evidence), /lost resume/);
  assert.equal(commands.filter(x=>x==='11/3').length,1);
  assert.equal(evidence.disposeAcknowledged,true);assert.equal(evidence.resumeVerified,undefined);
});

test('cleanup failure is explicit, not reported as resumed', async () => {
  const evidence={};
  await assert.rejects(withSuspendedMain(async(s,c)=>{if(c===12)return int(0);if(c===3||s===1)throw Error('disconnected');return Buffer.alloc(0);},main,async()=>[],evidence), /disconnected/);
  assert.equal(evidence.resumeVerified,undefined);assert.equal(evidence.disposeAcknowledged,undefined);assert.equal(evidence.disposeError,'disconnected');
});

test('owned forward is removed on handshake or observation failure; unrelated ports untouched', async () => {
  for(const stage of ['handshake','observation']) {
    const removed=[], evidence={};let closed=false;
    await assert.rejects(withOwnedForward({open:async()=>45001,connect:()=>({ready:stage==='handshake'?Promise.reject(Error('handshake')):Promise.resolve(),close:()=>{closed=true;}}),observe:async()=>{throw Error('observation');},remove:async p=>removed.push(p)},evidence), new RegExp(stage));
    assert.deepEqual(removed,[45001]);assert.equal(closed,true);assert.equal(evidence.forwardRemoved,true);
  }
});

test('no forward removal when opening failed, removal failure preserved', async () => {
  let removes=0;
  await assert.rejects(withOwnedForward({open:async()=>{throw Error('open');},remove:async()=>removes++},{}), /open/);
  assert.equal(removes,0);
  const evidence={};
  await assert.rejects(withOwnedForward({open:async()=>45001,connect:()=>({ready:Promise.resolve(),close(){}}),observe:async()=>[],remove:async()=>{throw Error('remove');}},evidence), /remove/);
  assert.equal(evidence.forwardRemoved,undefined);assert.equal(evidence.forwardError,'remove');
});

async function fakeServer(t, handler, handshake=true) {
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0), initial=true;
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(initial){if(buffer.length<14)return;buffer=buffer.subarray(14);initial=false;if(!handshake)return;socket.write('JDWP-');socket.write('Handshake');}
      while(buffer.length>=11){const n=buffer.readUInt32BE();if(buffer.length<n)return;const p=buffer.subarray(0,n);buffer=buffer.subarray(n);handler(socket,p);}
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));});
  return server.address().port;
}
function reply(packet, payload=Buffer.alloc(0), error=0) {
  const b=Buffer.alloc(11+payload.length);b.writeUInt32BE(b.length);b.writeUInt32BE(packet.readUInt32BE(4),4);b[8]=0x80;b.writeUInt16BE(error,9);payload.copy(b,11);return b;
}

test('TCP fragmented handshake and replies are decoded, protocol errors rejected', async t => {
  const port=await fakeServer(t,(socket,p)=>{const b=reply(p,int(7),p[10]===2?13:0);socket.write(b.subarray(0,5));socket.write(b.subarray(5));});
  const client=createJdwpClient(port);t.after(()=>client.close());await client.ready;
  assert.equal((await client.request(1,1)).readInt32BE(),7);
  await assert.rejects(client.request(1,2),/JDWP error 13/);
});

test('handshake timeout closes connection with a bounded failure', async t => {
  const port=await fakeServer(t,()=>{},false);const client=createJdwpClient(port,{handshakeMs:30});t.after(()=>client.close());
  await assert.rejects(client.ready,/handshake timeout/);
});

test('late timeout reply cannot satisfy the next request', async t => {
  const port=await fakeServer(t,(socket,p)=>{
    if(p[10]===1)setTimeout(()=>{if(!socket.destroyed)socket.write(reply(p,int(99)));},50);
    else setTimeout(()=>{if(!socket.destroyed)socket.write(reply(p,int(7)));},25);
  });
  const client=createJdwpClient(port,{timeoutMs:40});t.after(()=>client.close());await client.ready;
  await assert.rejects(client.request(1,1),/timeout/);
  assert.equal((await client.request(1,2)).readInt32BE(),7);
});

test('disconnect rejects pending commands and invalid packet length is bounded', async t => {
  for(const corrupt of [false,true]) {
    const port=await fakeServer(t,(socket)=>{if(!corrupt)socket.destroy();else{const b=Buffer.alloc(11);b.writeUInt32BE(10);socket.write(b);}});
    const client=createJdwpClient(port);t.after(()=>client.close());await client.ready;
    await assert.rejects(client.request(1,1),corrupt?/packet length/:/socket closed/);
  }
});

test('TCP frame failure still resumes main and removes only owned forward', async t => {
  let count=0;const commands=[],removed=[],evidence={};
  const port=await fakeServer(t,(socket,p)=>{
    const set=p[9],cmd=p[10];commands.push(`${set}/${cmd}`);
    if(set===11&&cmd===2)count++;
    if(set===11&&cmd===3)count--;
    socket.write(reply(p,cmd===12?int(count):Buffer.alloc(0),cmd===6?13:0));
  });
  await assert.rejects(withOwnedForward({open:async()=>port,connect:p=>createJdwpClient(p),remove:async p=>removed.push(p),observe:client=>withSuspendedMain(client.request,main,()=>client.request(11,6,main),evidence)},evidence), /error 13/);
  assert.equal(count,0);assert.equal(evidence.resumeVerified,true);assert.deepEqual(removed,[port]);
  assert.deepEqual(commands,['11/12','11/2','11/6','11/3','11/12']);
});

function windowClock(time = 0) {
  const clock={time};
  clock.options={startedAt:0,triggerMs:12000,budgetMs:15000,intervalMs:1000,
    now:()=>clock.time,sleep:async ms=>{clock.time+=ms;}};
  return clock;
}

const noWindow={mainWindow:false,focus:null};
test('delayed gate has no attachment before a fresh 12-second observation', async()=>{
  const clock=windowClock(2000),timeline=[];let samples=0;
  const gate=await waitForStackWindow(async remaining=>{assert.ok(remaining>0);clock.time+=25;return noWindow;},
    {...clock.options,onObservation:o=>timeline.push(o)});
  if(gate.status==='sample-due')samples++;
  assert.equal(samples,1);assert.equal(gate.status,'sample-due');
  assert.ok(timeline.at(-1).startedMs>=12000);assert.ok(gate.observedMs<15000);
  assert.ok(timeline.slice(0,-1).every(o=>o.startedMs<12000));
});

test('early main window stops without a stack, even while focus is null',async()=>{
  const clock=windowClock(),timeline=[];
  const gate=await waitForStackWindow(async()=>({mainWindow:clock.time>=3000,focus:null}),
    {...clock.options,onObservation:o=>timeline.push(o)});
  assert.equal(gate.status,'window-ready');assert.equal(gate.observedMs,3000);assert.equal(timeline.length,4);
});

test('window appearing exactly at threshold wins over stack admission',async()=>{
  const clock=windowClock(11000);
  const gate=await waitForStackWindow(async()=>({mainWindow:clock.time>=12000,focus:null}),clock.options);
  assert.equal(gate.status,'window-ready');assert.equal(gate.observedMs,12000);
});

test('query crossing threshold is followed by a new read, not reused as trigger evidence',async()=>{
  const clock=windowClock(11990),starts=[];
  const gate=await waitForStackWindow(async()=>{starts.push(clock.time);clock.time+=50;return noWindow;},clock.options);
  assert.equal(starts.length,2);assert.ok(starts[1]>=12000);assert.equal(gate.status,'sample-due');
});

test('query exhausting budget is not admitted even if it returns a window',async()=>{
  const clock=windowClock(12000);const timeline=[];
  await assert.rejects(waitForStackWindow(async remaining=>{assert.equal(remaining,3000);clock.time+=3000;return {mainWindow:true,focus:null};},
    {...clock.options,onObservation:o=>timeline.push(o)}),/budget exhausted/);
  assert.equal(timeline.length,1);
});

test('budget already exhausted does not issue a query',async()=>{
  const clock=windowClock(15000);let reads=0;
  await assert.rejects(waitForStackWindow(async()=>{reads++;return noWindow;},clock.options),/budget exhausted/);
  assert.equal(reads,0);
});

test('unreadable state or other focus never admits a stack',async()=>{
  for(const state of [{mainWindow:false},{mainWindow:'unknown',focus:null},{mainWindow:false,focus:'other.app'}]){
    const clock=windowClock(12000);let reads=0;
    await assert.rejects(waitForStackWindow(async()=>{reads++;return state;},clock.options),/not admitted/);
    assert.equal(reads,1);
  }
  const clock=windowClock(12000);
  await assert.rejects(waitForStackWindow(async()=>{throw Error('transport timeout');},clock.options),/transport timeout/);
});

test('cancellation before or during a query preserves reason and prevents sampling',async()=>{
  for(const alreadyCancelled of [false,true]){
    const clock=windowClock(12000),controller=new AbortController(),reason=Error('user cancelled');let reads=0;
    if(alreadyCancelled)controller.abort(reason);
    await assert.rejects(waitForStackWindow(async(remaining,signal)=>{
      reads++;assert.equal(signal,controller.signal);controller.abort(reason);return noWindow;
    },{...clock.options,signal:controller.signal}),e=>e===reason);
    assert.equal(reads,alreadyCancelled?0:1);
  }
});

test('cancellation during real sleep exits without another query',async()=>{
  const controller=new AbortController(),reason=Error('cancel sleep');let reads=0;
  const pending=waitForStackWindow(async()=>{reads++;setTimeout(()=>controller.abort(reason),10);return noWindow;},
    {startedAt:performance.now(),signal:controller.signal});
  await assert.rejects(pending,e=>e===reason);assert.equal(reads,1);
});

test('invalid observation settings are rejected without a query',async()=>{
  for(const override of [{triggerMs:-1},{triggerMs:15000},{intervalMs:0},{startedAt:NaN}]){
    const clock=windowClock();let reads=0;
    await assert.rejects(waitForStackWindow(async()=>{reads++;return noWindow;},{...clock.options,...override}),/Invalid/);
    assert.equal(reads,0);
  }
});

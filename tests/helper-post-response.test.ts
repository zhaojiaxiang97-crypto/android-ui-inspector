import assert from 'node:assert/strict';
import {test} from 'node:test';
import sharp from 'sharp';
import {readHelperObservation, type HelperFetch} from '../electron/capture/helper-observation';
import {helperPayload, helperPackage, helperFrame, helperToken} from './fixtures/helper-protocol';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return {promise,resolve}; };
const png = () => sharp({create:{width:10,height:20,channels:4,background:'#abcdef'}}).png().toBuffer();
const fetcher = (body: string): HelperFetch => (async () => new Response(body)) as HelperFetch;
const read = (body: string, after: () => Promise<void>, signal = new AbortController().signal) =>
  readHelperObservation(1234,helperToken,helperPackage,helperFrame,signal,fetcher(body),after);

test('post-check waits for response EOF and is joined before an observation is published',async()=>{
  const envelope=JSON.stringify(helperPayload((await png()).toString('base64'))), eof=deferred(), entered=deferred(), finish=deferred();
  let calls=0,returned=false;
  const response = new Response(new ReadableStream({async start(controller){
    controller.enqueue(new TextEncoder().encode(envelope)); await eof.promise; controller.close();
  }}));
  const work=readHelperObservation(1234,helperToken,helperPackage,helperFrame,new AbortController().signal,
    (async()=>response) as HelperFetch,async()=>{calls++;entered.resolve();await finish.promise;})
    .finally(()=>returned=true);
  await new Promise(r=>setTimeout(r,5));assert.equal(calls,0);eof.resolve();await entered.promise;
  await new Promise(r=>setTimeout(r,5));assert.equal(returned,false);finish.resolve();
  assert((await work).screenshotDataUrl);assert.equal(calls,1);
});

for(const kind of ['json','tree','png'] as const) test(`${kind} failure joins post-check and keeps capture error priority`,async()=>{
  const value=helperPayload((await png()).toString('base64'));
  if(kind==='tree')value.node_count=999;
  if(kind==='png')value.screenshot_base64=Buffer.from('not png').toString('base64');
  const body=kind==='json'?'{bad':JSON.stringify(value), entered=deferred(), finish=deferred();
  let returned=false;
  const work=read(body,async()=>{entered.resolve();await finish.promise;throw Error('post-failure');})
    .then(()=>{throw Error('invalid capture accepted');},error=>{
      assert.notEqual(error.message,'post-failure');assert.match(error.code,/helper-format|helper-evidence|helper-image/);
    }).finally(()=>returned=true);
  await entered.promise;await new Promise(r=>setTimeout(r,5));assert.equal(returned,false);
  finish.resolve();await work;
});

test('post-check failure rejects a valid capture without another read',async()=>{
  const error=Error('changed target');let calls=0;
  await assert.rejects(read(JSON.stringify(helperPayload((await png()).toString('base64'))),async()=>{calls++;throw error;}),e=>e===error);
  assert.equal(calls,1);
});

test('HTTP, size and pre-cancellation failures never launch post-check',async()=>{
  let calls=0;const after=async()=>{calls++;};
  const signal=new AbortController().signal;
  await assert.rejects(readHelperObservation(1234,helperToken,helperPackage,helperFrame,signal,
    (async()=>new Response('x',{status:500})) as HelperFetch,after));
  await assert.rejects(read('x'.repeat(32*1024*1024+1),after));
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(read('{}',after,cancelled.signal));
  assert.equal(calls,0);
});

for(const timeout of [false,true])test(`post-check joins before ${timeout?'deadline':'cancellation'} returns`,async()=>{
  const controller=new AbortController(),entered=deferred(),finish=deferred();let returned=false;
  const work=read(JSON.stringify(helperPayload((await png()).toString('base64'))),async()=>{
    entered.resolve();await finish.promise;
  },controller.signal).then(()=>{throw Error('cancel accepted');},error=>assert.equal(error,controller.signal.reason)).finally(()=>returned=true);
  await entered.promise;
  controller.abort(new DOMException('test',timeout?'TimeoutError':'AbortError'));
  await new Promise(r=>setTimeout(r,5));assert.equal(returned,false);finish.resolve();await work;
});

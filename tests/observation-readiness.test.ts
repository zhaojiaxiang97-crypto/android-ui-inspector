import assert from "node:assert/strict";
import { test } from "node:test";
import { parseObservationReadiness, waitForObservationReadiness } from "../scripts/lib/observation-readiness";

const line = (focused = true, id = 7) => `A11yWindow[AccessibilityWindowInfo[title=private, displayId=0, id=${id}, type=TYPE_APPLICATION, layer=0, bounds=Rect(0, 0 - 1080, 2400), focused=${focused}, active=${focused}, hasParent=false, transitionTime=100]]`;
const focus = "mCurrentFocus=Window{abc u0 com.example.sample/.Main}";
const ready = parseObservationReadiness(line(), focus, "com.example.sample");
test("system readiness requires unique active authorized application focus and a supported format", () => {
  assert.equal(ready.ready, true);
  assert.equal(parseObservationReadiness(line(false), focus, "com.example.sample").reason, "focus");
  assert.equal(parseObservationReadiness(line()+"\n"+line(true,8), focus, "com.example.sample").ready, false);
  assert.equal(parseObservationReadiness(line()+"\n"+line(false), focus, "com.example.sample").reason, "format");
  assert.equal(parseObservationReadiness(line(), focus, "com.other.app").reason, "foreground");
  for (const value of ["", line().replace("displayId=0","displayId=1"), line().replace("transitionTime=100", "unknown=100")])
    assert.equal(parseObservationReadiness(value, focus, "com.example.sample").ready, false);
  assert.equal(JSON.stringify(ready).includes("private"), false);
  assert.notEqual(parseObservationReadiness(line().replace("1080, 2400", "1075, 2389"), focus, "com.example.sample").signature, ready.signature);
  assert.equal(parseObservationReadiness(line().replace("bounds=Rect(0, 0 - 1080, 2400)", "bounds=unknown"), focus, "com.example.sample").ready, false);
});
test("requires consecutive stable samples and discards readiness after a gap or identity change", async () => {
  let time=0, index=0;
  const other = {...ready, signature:"a".repeat(64)};
  const sequence=[ready, {ready:false,reason:"focus" as const},ready,other,other];
  const result=await waitForObservationReadiness({signal:new AbortController().signal, now:()=>time,
    read:async()=>sequence[index++],pause:async ms=>{time+=ms;}});
  assert.equal(result.ready,true);assert.equal(result.samples,5);assert.equal(result.elapsedMs,400);
});
test("bounds samples, rejects late results, stops on read failures and cancellation", async () => {
  let time=0;
  const base={signal:new AbortController().signal,now:()=>time,pause:async(ms:number)=>{time+=ms;}};
  const exhausted=await waitForObservationReadiness({...base,maxSamples:2,read:async()=>({ready:false,reason:"focus"})});
  assert.equal(exhausted.ready,false);assert.equal(exhausted.samples,2);
  time=0;
  const late=await waitForObservationReadiness({...base,timeoutMs:200,read:async()=>{time+=200;return ready;}});
  assert.equal(late.ready,false);
  const failed=await waitForObservationReadiness({...base,read:async()=>{throw Error("secret");}});
  assert.equal(failed.reason,"read_failed");assert.equal(JSON.stringify(failed).includes("secret"),false);
  const controller=new AbortController();controller.abort();
  await assert.rejects(waitForObservationReadiness({...base,signal:controller.signal,read:async()=>{throw Error("must not run");}}));
});

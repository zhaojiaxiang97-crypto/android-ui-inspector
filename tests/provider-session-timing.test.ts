import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderSessionTiming } from "../electron/sdk/provider-session-timing";

const valid = "Result: Bundle[{result=ok, sessionTimingVersion=1, sessionCallNs=100, sessionLockWaitNs=20, sessionDispatchNs=70, sessionOpenNs=60}]";
test("startup timing parses nested nanosecond durations without deriving host residuals", () => {
  assert.deepEqual(parseProviderSessionTiming(valid), { status: "available", version: 1, callNs: 100, lockWaitNs: 20, dispatchNs: 70, openNs: 60 });
  assert.equal(parseProviderSessionTiming(valid.replace(/=\d+/g, "=0").replace("sessionTimingVersion=0", "sessionTimingVersion=1")).status, "available");
});
test("old SDK timing is unsupported, not fabricated zero", () => {
  assert.deepEqual(parseProviderSessionTiming("Result: Bundle[{result=ok, socket=sample.session}]"), { status: "unsupported" });
});
test("malformed, partial, duplicate, future or out-of-range timing is invalid", () => {
  for (const invalid of ["", valid + "\nextra", valid.replace("sessionOpenNs=60", "missing=60"),
    valid.replace("sessionTimingVersion=1", "sessionTimingVersion=2"),
    valid.replace("sessionOpenNs=60", "sessionOpenNs=-1"), valid.replace("sessionOpenNs=60", "sessionOpenNs=NaN"),
    valid.replace("sessionOpenNs=60", "sessionOpenNs=1.5"), valid.replace("sessionCallNs=100", "sessionCallNs=9007199254740992"),
    valid.replace("sessionOpenNs=60", "sessionOpenNs=71"), valid.replace("sessionCallNs=100", "sessionCallNs=89"),
    valid.replace("sessionOpenNs=60", "sessionOpenNs=60, sessionOpenNs=60")])
    assert.equal(parseProviderSessionTiming(invalid).status, "invalid", invalid);
});

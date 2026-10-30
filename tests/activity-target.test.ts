import assert from "node:assert/strict";
import { test } from "node:test";
import { foregroundTarget, targetActivitySection, parseFocusedWindowState } from "../electron/device/target";
import { activityTreeReadinessReason } from "../electron/capture/native-tree";
const component = "com.example.test/.MainActivity";
const target = foregroundTarget(`topResumedActivity=ActivityRecord{b22 u0 ${component} t2}`)!;
const dump = `TASK 1
  ACTIVITY ${component} a11 pid=(not running) userId=0
TASK 2
  ACTIVITY ${component} b22 pid=42 userId=0
    View Hierarchy:
      DecorView@abc[MainActivity]
  ACTIVITY com.example.test/.OtherActivity c33 pid=42 userId=0
    other tree
`;
test("Activity selection uses resumed instance, not an old same-name task", () => {
  assert.equal(target.activityRecordId, "b22");
  const section = targetActivitySection(dump, target);
  assert.match(section, /b22 pid=42/); assert.match(section, /DecorView@abc/);
  assert.ok(!section.includes("not running") && !section.includes("other tree"));
  assert.match(targetActivitySection(dump.replace("pid=(not running)", "pid=99"), target), /b22 pid=42/);
  assert.match(targetActivitySection(dump.replace(/ACTIVITY /g, "ACTIVITY\t"), target), /^ACTIVITY\t/);
});
test("tree readiness diagnoses system dump timeout separately from missing hierarchy", () => {
  assert.match(activityTreeReadinessReason("Failure while dumping the activity: java.io.IOException: Timeout"), /系统 dump 超时/);
  assert.match(activityTreeReadinessReason("ACTIVITY com.example.test/.MainActivity b22 pid=42\nNo tree"), /尚未提供有效 View Hierarchy/);
});
test("missing, duplicate and stopped Activity instances never choose a donor", () => {
  for (const source of [dump.replace("b22", "d44"), dump.replace("b22 pid=42", "b22 pid=(not running)"), dump + `\nACTIVITY ${component} b22 pid=43`]) {
    assert.throws(() => targetActivitySection(source, target), /实例无法唯一确认或已停止/);
  }
  const { activityRecordId, ...legacy } = target;
  assert.throws(() => targetActivitySection(dump, legacy), /实例无法唯一确认/);
  assert.match(targetActivitySection(`ACTIVITY ${component} b22 pid=42\nView Hierarchy:`, legacy), /pid=42/);
});
test("focus diagnosis separates actual null focus from ambiguity and parsing failure", () => {
  for (const [text, reason] of [["mCurrentFocus=null", "系统焦点为空"], ["mCurrentFocus=null\nmCurrentFocus=null", "不唯一"],
    ["mTopFocusedDisplayId=2\nmCurrentFocus=Window{abc u0 com.example.test/.Main}", "非主显示器"],
    ["mCurrentFocus=Window{abc u0 PopupWindow:123}", "格式无法识别"], ["no focus", "未提供焦点字段"]]) {
    const state = parseFocusedWindowState(text); assert.equal(state.focus, null); assert.ok(state.reason?.includes(reason));
  }
  assert.deepEqual(parseFocusedWindowState("mCurrentFocus=Window{abc u0 com.example.test/.Main}"), { focus: { id: "abc", packageName: "com.example.test" }, reason: null, reasonCode: null });
});

test("focus reason codes distinguish every parser rejection without changing acceptance", () => {
  for (const [source, code] of [
    ["mCurrentFocus=null", "null-focus"],
    ["mTopFocusedDisplayId=2\nmCurrentFocus=null", "non-primary-display"],
    ["Display: mDisplayId=2\nmCurrentFocus=null", "missing-primary-display"],
    ["no field", "missing-focus-field"],
    ["mCurrentFocus=null\nmCurrentFocus=null", "ambiguous-focus-field"],
    ["mCurrentFocus=Window{abc u0 PopupWindow:123}", "unrecognized-focus-format"],
  ]) {
    const parsed = parseFocusedWindowState(source);
    assert.equal(parsed.focus, null); assert.equal(parsed.reasonCode, code);
  }
});

test("primary-display null focus stays unavailable even with another app window or resumed Activity", () => {
  const output = `mTopFocusedDisplayId=0
    mResumeActivity:ActivityRecord{abc u0 com.example.test/.Main t1}
    Window{aaa u0 com.example.test/.Main}
    Display: mDisplayId=0
      mCurrentFocus=null
    Display: mDisplayId=2
      mCurrentFocus=Window{bbb u0 com.example.test/.Main}`;
  assert.match(parseFocusedWindowState(output).reason!, /系统焦点为空/);
  assert.equal(parseFocusedWindowState(output).focus, null);
  assert.deepEqual(parseFocusedWindowState(output.replace("mCurrentFocus=null", "mCurrentFocus=Window{aaa u0 com.example.test/.Main}")).focus,
    { id: "aaa", packageName: "com.example.test" });
});

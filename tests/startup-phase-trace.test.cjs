const {test} = require('node:test');
const assert = require('node:assert/strict');
const {renderStartupTraceConfig, renderStartupTraceSql, renderStartupTraceHealthSql, parseStartupTraceHealthCsv} = require("../scripts/diagnostics/startup/startup-phase-trace.cjs");

test('config is bounded and limited to one exact app, without method sampling or logs',()=>{
  const config=renderStartupTraceConfig('org.example.debug_app');
  assert.match(config,/duration_ms: 25000/);assert.match(config,/size_kb: 65536 fill_policy: DISCARD/);
  assert.match(config,/size_kb: 1024 fill_policy: DISCARD/);
  assert.equal((config.match(/buffers \{/g)||[]).length,2);
  assert.match(config,/name: "linux.process_stats" target_buffer: 1/);
  assert.match(config,/atrace_apps: "org.example.debug_app"/);
  assert.equal((config.match(/atrace_apps:/g)||[]).length,1);
  for(const event of ['sched_switch','sched_waking','task_newtask'])assert.ok(config.includes(event));
  assert.ok(!config.includes('android.log'));assert.ok(!config.includes('linux.perf'));
  assert.ok(!config.includes('upload'));assert.ok(!config.includes('atrace_apps: "*"'));
});
test('package wildcards, control characters and config injection rejected',()=>{
  for(const name of ['*','org.example.*','org.example\n','org.example"','org.example;exit','../example',null,'single']){
    assert.throws(()=>renderStartupTraceConfig(name));
  }
});
test('SQL binds numeric PID, rejects ambiguity, retains raw slices and open intervals',()=>{
  const sql=renderStartupTraceSql(12345);
  assert.ok(!sql.includes('__TARGET_PID__'));assert.match(sql,/WHERE p.pid = 12345/);
  assert.match(sql,/COUNT\(\*\) FROM process WHERE pid = 12345\) = 1/);
  assert.match(sql,/s.parent_id/);assert.match(sql,/st.dur < 0/);
  assert.ok(!sql.includes('SUM(s.dur)'));assert.match(sql,/full TRACE coverage/);
});
test('bad or injected PID rejected before SQL rendering',()=>{
  for(const pid of [0,-1,1.5,Infinity,NaN,'123 OR 1=1',2147483648]){
    assert.throws(()=>renderStartupTraceSql(pid));assert.throws(()=>renderStartupTraceHealthSql(pid));
  }
});

const header='"integrity_status","pid_matches","error_count","loss_count","buffer_loss_count","full_buffers","buffer_count"\n';
test('health query blocks info-level buffer loss and full buffers as well as errors',()=>{
  const sql=renderStartupTraceHealthSql(12345);
  for(const name of ['traced_buf_chunks_discarded','traced_buf_chunks_overwritten','traced_buf_patches_failed','long_trace_mode_bytes_overwritten'])assert.ok(sql.includes(name));
  assert.match(sql,/written.value >= capacity.value/);assert.match(sql,/pid = 12345/);
  assert.ok(renderStartupTraceSql(12345).endsWith(sql));
});
test('health parser distinguishes integrity from startup acceptance',()=>{
  assert.equal(parseStartupTraceHealthCsv(header+'"pass",1,0,0,0,0,2\n').integrityStatus,'pass');
  for(const row of ['"fail",1,1,0,0,0,1','"fail",1,0,1,0,0,1','"fail",1,0,0,1,0,1','"fail",1,0,0,0,1,1']){
    assert.equal(parseStartupTraceHealthCsv(header+row).integrityStatus,'fail');
  }
  for(const row of ['"unknown",0,0,0,0,0,1','"unknown",2,0,0,0,0,1','"unknown",1,0,0,0,0,0']){
    assert.equal(parseStartupTraceHealthCsv(header+row).integrityStatus,'unknown');
  }
});
test('health parser rejects incomplete, extra, malformed or inconsistent output',()=>{
  for(const output of ['',null,header,header+'"pass",1,1,0,0,0,1',header+'"pass",0,0,0,0,0,1',header+'"fail",1,0,0,0,0,1',header+'"pass",1,0,0,0,0,1\nextra',header+'"pass",1,-1,0,0,0,1',header+'"fail",1,9007199254740992,0,0,0,1'])assert.throws(()=>parseStartupTraceHealthCsv(output));
});

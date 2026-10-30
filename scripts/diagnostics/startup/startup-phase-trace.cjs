const fs = require('node:fs');
const path = require('node:path');

// Render only: this module never launches adb, changes settings or starts tracing.
function renderStartupTraceConfig(packageName) {
  if (typeof packageName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    throw Error('Expected an exact Android package name');
  }
  return `duration_ms: 25000
buffers { size_kb: 65536 fill_policy: DISCARD }
buffers { size_kb: 1024 fill_policy: DISCARD }
data_sources {
  config {
    name: "linux.ftrace"
    ftrace_config {
      ftrace_events: "sched/sched_switch"
      ftrace_events: "sched/sched_waking"
      ftrace_events: "sched/sched_process_exit"
      ftrace_events: "sched/sched_process_free"
      ftrace_events: "task/task_newtask"
      ftrace_events: "task/task_rename"
      atrace_categories: "am"
      atrace_categories: "wm"
      atrace_categories: "view"
      atrace_categories: "dalvik"
      atrace_categories: "res"
      atrace_apps: "${packageName}"
    }
  }
}
data_sources { config { name: "linux.process_stats" target_buffer: 1 process_stats_config { scan_all_processes_on_start: true } } }
`;
}

function renderStartupTraceSql(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) throw Error('Expected a positive process PID');
  return fs.readFileSync(path.join(__dirname, "startup-phase-trace.sql"), 'utf8').replaceAll('__TARGET_PID__', String(pid)) + '\n' + renderStartupTraceHealthSql(pid);
}
function renderStartupTraceHealthSql(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) throw Error('Expected a positive process PID');
  return fs.readFileSync(path.join(__dirname, "startup-phase-trace-health.sql"), 'utf8').replaceAll('__TARGET_PID__', String(pid));
}

// Parse the single-query integrity report, not an arbitrary multi-query CSV.
// "pass" means only integrity checks passed, never first-frame/startup success.
function parseStartupTraceHealthCsv(csv) {
  if (typeof csv !== 'string') throw Error('Missing trace health output');
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length !== 2 || lines[0] !== '"integrity_status","pid_matches","error_count","loss_count","buffer_loss_count","full_buffers","buffer_count"') throw Error('Invalid trace health output');
  const match = lines[1].match(/^"(pass|fail|unknown)",(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)$/);
  if (!match) throw Error('Invalid trace health row');
  const values = match.slice(2).map(Number);
  if (!values.every(Number.isSafeInteger)) throw Error('Invalid trace health counters');
  const [pidMatches, errorCount, lossCount, bufferLossCount, fullBuffers, bufferCount] = values;
  const expected = pidMatches !== 1 || !bufferCount ? 'unknown' : errorCount || lossCount || bufferLossCount || fullBuffers ? 'fail' : 'pass';
  if (match[1] !== expected) throw Error('Inconsistent trace health status');
  return {integrityStatus:expected,pidMatches,errorCount,lossCount,bufferLossCount,fullBuffers,bufferCount};
}
module.exports = { renderStartupTraceConfig, renderStartupTraceSql, renderStartupTraceHealthSql, parseStartupTraceHealthCsv };

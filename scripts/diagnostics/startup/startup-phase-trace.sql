-- Offline diagnostic only. PID must be bound to the same launch using external
-- Activity/PID/startTicks evidence. An ambiguous PID produces no target rows.
-- Query success is not complete trace coverage or proof of a blocking method.
CREATE PERFETTO TABLE startup_target AS
SELECT p.upid, p.pid, p.name, p.start_ts, p.end_ts FROM process p
WHERE p.pid = __TARGET_PID__
AND (SELECT COUNT(*) FROM process WHERE pid = __TARGET_PID__) = 1;

SELECT 'identity' AS section, COUNT(*) AS pid_matches FROM process WHERE pid = __TARGET_PID__;
SELECT 'target' AS section, * FROM startup_target;
SELECT 'bounds' AS section, start_ts, end_ts FROM trace_bounds;
SELECT 'health' AS section, name, severity, value FROM stats
WHERE value > 0 AND severity IN ('error', 'data_loss') ORDER BY name;
-- Central-buffer losses can have info severity; retain their raw counters.
SELECT 'buffer_health' AS section, name, idx, severity, value FROM stats
WHERE name IN ('traced_buf_buffer_size', 'traced_buf_bytes_written',
  'traced_buf_chunks_discarded', 'traced_buf_chunks_overwritten',
  'traced_buf_patches_failed', 'long_trace_mode_bytes_overwritten')
ORDER BY name, idx;

-- Names are inspected, not guessed into fixed Application/Activity phases.
-- Nested parent/child wall times are not additive. Open slices retain dur=-1.
SELECT 'main_slices' AS section, s.id, s.parent_id, s.ts, s.dur, s.name,
t.tid, s.track_id FROM slice s
JOIN thread_track tt ON tt.id = s.track_id
JOIN thread t ON t.utid = tt.utid
JOIN startup_target p ON p.upid = t.upid
WHERE t.tid = p.pid ORDER BY s.ts;

SELECT 'main_states' AS section, st.ts, st.dur, st.state, st.blocked_function
FROM thread_state st JOIN thread t ON t.utid = st.utid
JOIN startup_target p ON p.upid = t.upid
WHERE t.tid = p.pid ORDER BY st.ts;

-- This is full TRACE coverage, not launch-to-first-frame elapsed time.
SELECT 'main_state_totals' AS section, st.state, SUM(st.dur) AS closed_nanos,
COUNT(*) AS intervals FROM thread_state st JOIN thread t ON t.utid = st.utid
JOIN startup_target p ON p.upid = t.upid
WHERE t.tid = p.pid AND st.dur > 0 GROUP BY st.state;

SELECT 'main_open_states' AS section, COUNT(*) AS count
FROM thread_state st JOIN thread t ON t.utid = st.utid
JOIN startup_target p ON p.upid = t.upid
WHERE t.tid = p.pid AND st.dur < 0;

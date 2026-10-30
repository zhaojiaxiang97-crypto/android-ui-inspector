-- Local-only Perfetto analysis. Requires exactly one complete InspectorPipeline.
-- Slice durations for different names may be nested: never sum them as wall time.
CREATE PERFETTO TABLE inspector_pipeline AS
SELECT s.id, s.ts, s.dur, s.track_id, t.utid, t.tid, p.pid, p.name AS process_name
FROM slice s JOIN thread_track tt ON tt.id = s.track_id
JOIN thread t ON t.utid = tt.utid JOIN process p ON p.upid = t.upid
WHERE s.name = 'InspectorPipeline';

CREATE PERFETTO TABLE inspector_captures AS
SELECT s.id, s.ts, s.dur, s.track_id, t.utid, t.tid, p.pid
FROM slice s JOIN thread_track tt ON tt.id = s.track_id
JOIN thread t ON t.utid = tt.utid JOIN process p ON p.upid = t.upid
JOIN inspector_pipeline pipeline ON pipeline.pid = p.pid
WHERE s.name = 'InspectorCapture' AND s.ts >= pipeline.ts
AND s.dur > 0 AND s.ts + s.dur <= pipeline.ts + pipeline.dur;

SELECT 'pipeline' AS section, pid, tid, process_name, ts, dur FROM inspector_pipeline;
SELECT 'captures' AS section, COUNT(*) AS count, MIN(tid) AS tid_min, MAX(tid) AS tid_max,
SUM(dur) AS total_ns, MIN(ts) AS first_ts, MAX(ts + dur) AS last_ts FROM inspector_captures;

-- Clip each scheduler interval to each non-overlapping UI capture marker.
SELECT 'capture_thread_states' AS section, st.state,
SUM(MIN(st.ts + st.dur, c.ts + c.dur) - MAX(st.ts, c.ts)) AS total_ns,
COUNT(*) AS intervals, st.blocked_function
FROM thread_state st JOIN inspector_captures c ON st.utid = c.utid
AND st.ts < c.ts + c.dur AND st.dur > 0 AND st.ts + st.dur > c.ts
GROUP BY st.state, st.blocked_function ORDER BY total_ns DESC;

SELECT 'main_capture_slices' AS section, s.name, COUNT(*) AS count, SUM(s.dur) AS total_ns
FROM slice s JOIN inspector_captures c ON s.track_id = c.track_id
AND s.ts >= c.ts AND s.dur > 0 AND s.ts + s.dur <= c.ts + c.dur AND s.id != c.id
GROUP BY s.name ORDER BY total_ns DESC LIMIT 30;

SELECT 'render_thread_slices' AS section, t.tid, s.name, COUNT(*) AS count, SUM(s.dur) AS total_ns
FROM slice s JOIN thread_track tt ON tt.id = s.track_id
JOIN thread t ON t.utid = tt.utid JOIN process p ON p.upid = t.upid
JOIN inspector_pipeline pipeline ON pipeline.pid = p.pid
WHERE t.name = 'RenderThread' AND s.ts >= pipeline.ts AND s.dur > 0
AND s.ts + s.dur <= pipeline.ts + pipeline.dur
GROUP BY t.tid, s.name ORDER BY total_ns DESC LIMIT 30;

SELECT 'trace_errors' AS section, name, severity, value FROM stats
WHERE value != 0 AND severity IN ('data_loss', 'error') ORDER BY name;

-- Machine-readable tail for bounded evidence validation; raw tables above remain available.
SELECT json_object(
  'pipelines', (SELECT json_group_array(json_object('pid', pid, 'tid', tid, 'ts', ts, 'dur', dur,
    'processName', process_name)) FROM inspector_pipeline),
  'captures', (SELECT json_object('count', COUNT(*), 'tidMin', MIN(tid), 'tidMax', MAX(tid),
    'totalNanos', SUM(dur), 'firstTs', MIN(ts), 'lastTs', MAX(ts + dur)) FROM inspector_captures),
  'overlappingCapturePairs', (SELECT COUNT(*) FROM inspector_captures a JOIN inspector_captures b
    ON a.id < b.id AND a.ts < b.ts + b.dur AND b.ts < a.ts + a.dur),
  'states', (SELECT json_group_array(json_object('state', state, 'nanos', total_ns)) FROM (
    SELECT st.state, SUM(MIN(st.ts + st.dur, c.ts + c.dur) - MAX(st.ts, c.ts)) AS total_ns
    FROM thread_state st JOIN inspector_captures c ON st.utid = c.utid
    AND st.ts < c.ts + c.dur AND st.dur > 0 AND st.ts + st.dur > c.ts GROUP BY st.state)),
  'errors', (SELECT json_group_array(json_object('name', name, 'severity', severity, 'value', value))
    FROM stats WHERE value != 0 AND severity IN ('data_loss', 'error'))
) AS evidence_json;

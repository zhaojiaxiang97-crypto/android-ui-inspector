-- Single report for machine consumption. No known error is silently allowlisted.
-- Integrity pass is not a first-frame, full-duration or performance acceptance.
SELECT CASE
  WHEN pid_matches != 1 OR buffer_count = 0 THEN 'unknown'
  WHEN error_count > 0 OR loss_count > 0 OR buffer_loss_count > 0 OR full_buffers > 0 THEN 'fail'
  ELSE 'pass'
END AS integrity_status, pid_matches, error_count, loss_count,
buffer_loss_count, full_buffers, buffer_count
FROM (
  SELECT
    (SELECT COUNT(*) FROM process WHERE pid = __TARGET_PID__) AS pid_matches,
    (SELECT COUNT(*) FROM stats WHERE severity = 'error' AND value > 0) AS error_count,
    (SELECT COUNT(*) FROM stats WHERE severity = 'data_loss' AND value > 0) AS loss_count,
    (SELECT COUNT(*) FROM stats WHERE value > 0 AND name IN (
      'traced_buf_chunks_discarded', 'traced_buf_chunks_overwritten',
      'traced_buf_patches_failed', 'long_trace_mode_bytes_overwritten'
    )) AS buffer_loss_count,
    (SELECT COUNT(*) FROM stats capacity JOIN stats written ON capacity.idx = written.idx
      WHERE capacity.name = 'traced_buf_buffer_size' AND capacity.value > 0
      AND written.name = 'traced_buf_bytes_written' AND written.value >= capacity.value) AS full_buffers,
    CASE WHEN
      (SELECT COUNT(*) FROM stats capacity JOIN stats written ON capacity.idx = written.idx
        WHERE capacity.name = 'traced_buf_buffer_size' AND capacity.value > 0
        AND written.name = 'traced_buf_bytes_written' AND written.value >= 0)
      = (SELECT COUNT(*) FROM stats WHERE name = 'traced_buf_buffer_size' AND value > 0)
    THEN (SELECT COUNT(*) FROM stats WHERE name = 'traced_buf_buffer_size' AND value > 0)
    ELSE 0 END AS buffer_count
);

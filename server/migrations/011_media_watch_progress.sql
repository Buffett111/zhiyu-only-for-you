ALTER TABLE media_events ADD COLUMN duration_seconds integer CHECK(duration_seconds BETWEEN 0 AND 31536000);
ALTER TABLE media_events ADD COLUMN progress_percent float8 CHECK(progress_percent BETWEEN 0 AND 100);
ALTER TABLE media_events ADD COLUMN resume_seconds integer CHECK(resume_seconds BETWEEN 0 AND 31536000);
-- Adapted from urTube's day-precision estimate: progress/position, bounded by
-- video length and ten minutes. A duration-only fallback is explicitly labeled.
-- This is an estimate, never a claim that the full video was actually watched.
ALTER TABLE media_events ADD COLUMN estimated_seconds integer GENERATED ALWAYS AS (
 CASE WHEN actual_seconds IS NOT NULL THEN actual_seconds
 WHEN precision='day' AND COALESCE(resume_seconds,duration_seconds) IS NOT NULL
 THEN floor(least(COALESCE(greatest(resume_seconds,duration_seconds*progress_percent/100),duration_seconds),duration_seconds,600))::integer
 ELSE NULL END
) STORED;

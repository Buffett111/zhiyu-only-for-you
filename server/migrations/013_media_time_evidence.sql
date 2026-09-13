-- Recompute derived estimates only; all captured original values are retained.
-- A video length alone is not evidence of how long the user watched it.
ALTER TABLE media_events DROP COLUMN estimated_seconds;
ALTER TABLE media_events ADD COLUMN estimated_seconds integer GENERATED ALWAYS AS (
 CASE WHEN actual_seconds IS NOT NULL THEN actual_seconds
 WHEN precision='day' AND (resume_seconds IS NOT NULL OR (duration_seconds IS NOT NULL AND progress_percent IS NOT NULL))
 THEN floor(least(greatest(resume_seconds,duration_seconds*progress_percent/100),duration_seconds,600))::integer
 ELSE NULL END
) STORED;

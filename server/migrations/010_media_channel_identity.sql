-- Re-verify the small initial handle-key cache using stable public channel IDs.
-- Existing watch events and reviewed classifications remain untouched.
UPDATE media_video_metadata SET retry_after=now() WHERE channel_key LIKE 'https://www.youtube.com/@%';

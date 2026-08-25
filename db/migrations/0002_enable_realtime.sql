-- Lets Supabase Realtime broadcast changes on task_state to subscribers.
-- Without this, updates land in Postgres but nobody watching the table
-- (the future frontend, or the test subscriber script) ever hears about it.
alter publication supabase_realtime add table task_state;

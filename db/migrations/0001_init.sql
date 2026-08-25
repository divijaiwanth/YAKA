-- Yaka core schema: the single source of truth for task/transaction state
-- and the observability log. Everything else (idempotency, webhooks,
-- realtime resume) reads/writes through these two tables.

create table if not exists task_state (
    task_id     uuid primary key default gen_random_uuid(),
    user_id     uuid not null references auth.users(id),
    thread_id   uuid not null,               -- chat thread this task belongs to; async
                                              -- updates resume by pushing to this thread
    agent       text not null,               -- which expert agent owns this task,
                                              -- e.g. 'payment-failure-investigation'
    status      text not null default 'pending'
                check (status in ('pending', 'in_progress', 'waiting_external', 'resolved', 'failed')),
    payload     jsonb not null default '{}', -- task-specific data (e.g. razorpay payment id,
                                              -- investigation findings so far)
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create index if not exists task_state_thread_id_idx on task_state (thread_id);
create index if not exists task_state_user_id_idx on task_state (user_id);
create index if not exists task_state_status_idx on task_state (status);

-- keep updated_at current on every write, so Supabase Realtime subscribers
-- (and anyone debugging) can trust it without every writer remembering to set it
create or replace function set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists task_state_set_updated_at on task_state;
create trigger task_state_set_updated_at
    before update on task_state
    for each row
    execute function set_updated_at();


create table if not exists tool_call_log (
    id          uuid primary key default gen_random_uuid(),
    task_id     uuid references task_state(task_id),
    agent       text not null,
    tool        text not null,               -- MCP tool name, e.g. 'fetch_payment'
    args        jsonb not null default '{}',
    args_hash   text not null,                -- same hash the Redis idempotency
                                               -- check uses: hash(task_id + tool + args)
    status      text not null
                check (status in ('success', 'error', 'blocked_idempotent', 'blocked_pending_confirmation')),
    latency_ms  integer,
    result      jsonb,                        -- tool result, or error detail on failure
    created_at  timestamptz not null default now()
);

create index if not exists tool_call_log_task_id_idx on tool_call_log (task_id);
create index if not exists tool_call_log_args_hash_idx on tool_call_log (args_hash);
create index if not exists tool_call_log_created_at_idx on tool_call_log (created_at);

-- RLS is off for both tables for now: the backend talks to Supabase with the
-- service role key (server-side only, never shipped to the client), so RLS
-- isn't load-bearing yet. Turn it on when the client ever queries these
-- tables directly instead of going through FastAPI.

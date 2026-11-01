-- Atomic AirNow hour reservation.
--
-- A pooled query() cannot hold a lock across round trips, so the lock, the
-- clock, the count, and the insert are one function. The window matches
-- airNowBudget: (called_at - 1 hour, called_at]. A call exactly one hour old
-- is outside it. Ok and error rows both count. At the ceiling the function
-- inserts nothing. The in-flight row is error/airnow_reserved until the
-- attempt finishes.
--
-- The stamp is clock_timestamp() after the advisory lock, and that same value
-- is the count window and the inserted called_at. now() is frozen at
-- transaction start, so a transaction that started earlier can still miss a
-- row this lock waited on. p_called_at is ignored: a stamp taken before the
-- lock can reserve out of order and let the hour reach 501.

create or replace function airnow_reserve(
  p_id text,
  p_called_at timestamptz,
  p_limit integer
) returns text
language plpgsql
as $fn$
declare
  n integer;
  v_called_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('upstream_call'), hashtext('airnow'));
  v_called_at := clock_timestamp();
  if p_limit is null or p_limit < 1 then
    return null;
  end if;
  select count(*)::int into n
    from upstream_call
   where source = 'airnow'
     and called_at > v_called_at - interval '1 hour'
     and called_at <= v_called_at;
  if n >= p_limit then
    return null;
  end if;
  insert into upstream_call
    (id, source, endpoint_kind, called_at, outcome, error_code, points)
  values
    (p_id, 'airnow', 'airnow_current', v_called_at, 'error', 'airnow_reserved', null);
  return p_id;
end;
$fn$;

-- Atomic AirNow hour reservation.
--
-- A pooled query() cannot hold a lock across round trips, so the lock, the
-- count, and the insert are one function. The window matches airNowBudget:
-- (called_at - 1 hour, called_at]. A call exactly one hour old is outside it.
-- Ok and error rows both count. At the ceiling the function inserts nothing.
-- The in-flight row is error/airnow_reserved until the attempt finishes.

create or replace function airnow_reserve(
  p_id text,
  p_called_at timestamptz,
  p_limit integer
) returns text
language plpgsql
as $fn$
declare
  n integer;
begin
  perform pg_advisory_xact_lock(hashtext('upstream_call'), hashtext('airnow'));
  if p_limit is null or p_limit < 1 then
    return null;
  end if;
  select count(*)::int into n
    from upstream_call
   where source = 'airnow'
     and called_at > p_called_at - interval '1 hour'
     and called_at <= p_called_at;
  if n >= p_limit then
    return null;
  end if;
  insert into upstream_call
    (id, source, endpoint_kind, called_at, outcome, error_code, points)
  values
    (p_id, 'airnow', 'airnow_current', p_called_at, 'error', 'airnow_reserved', null);
  return p_id;
end;
$fn$;

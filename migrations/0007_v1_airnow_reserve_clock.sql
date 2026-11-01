-- Replace airnow_reserve on databases that already applied 0006.
--
-- Applied migration files do not run again. 0006 originally counted and
-- inserted with the caller's p_called_at, which was captured before the
-- lock. A later stamp could reserve first, and an earlier stamp still
-- passed called_at <= p_called_at, so the hour could reach 501.
--
-- The body matches 0006 as of this fix: clock_timestamp() after the lock is
-- both the window and the inserted called_at. p_called_at is ignored.

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

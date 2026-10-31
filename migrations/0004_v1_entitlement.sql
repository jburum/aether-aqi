-- One entitlement row per user. No row means Free.
--
-- Pro is tier 'pro' and either state 'grace', or state 'active' with
-- expires_at still in the future. Expired and revoked are not Pro.
-- The app reads that same rule in src/lib/v1/entitlements.ts.
-- There is no App Store key and no Apple call in this migration.
--
-- Saved places stay capped at 5. Free can add only the first. A downgrade
-- does not delete rows; the trigger refuses a new insert past the free slot.
-- The hard cap is checked first, so a sixth place is still the cap error.

create table if not exists entitlement (
  user_id text primary key,
  tier text not null,
  product text not null,
  source text not null,
  expires_at timestamptz not null,
  state text not null,
  updated_at timestamptz not null default now(),
  constraint entitlement_tier_chk check (tier = 'pro'),
  constraint entitlement_product_chk check (product in ('monthly', 'yearly')),
  constraint entitlement_source_chk check (source = 'storekit'),
  constraint entitlement_state_chk check (state in ('active', 'grace', 'expired', 'revoked'))
);

-- Matches effectiveEntitlement: grace, or active while expires_at is ahead.
create or replace function saved_place_user_is_pro(p_user_id text, p_now timestamptz)
returns boolean
language sql
stable
as $fn$
  select exists (
    select 1
      from entitlement
     where user_id = p_user_id
       and tier = 'pro'
       and (
         state = 'grace'
         or (state = 'active' and expires_at > p_now)
       )
  );
$fn$;

-- Replaces the week-1 cap function. The trigger on saved_place already calls it.
-- 5 stays first so a full list still reports the cap, including after a downgrade.
create or replace function saved_place_enforce_cap()
returns trigger
language plpgsql
as $fn$
declare
  n integer;
begin
  perform saved_place_lock_user(new.user_id);
  select count(*)::int into n from saved_place where user_id = new.user_id;
  if n >= 5 then
    raise exception 'saved places cap is 5';
  end if;
  if n >= 1 and not saved_place_user_is_pro(new.user_id, statement_timestamp()) then
    raise exception 'saved places beyond 1 require pro';
  end if;
  return new;
end;
$fn$;

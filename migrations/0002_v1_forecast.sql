-- v1 week-1 forecast store.
--
-- The corrected forecast and the official AirNow reading live in different
-- tables so one column cannot hold both numbers. The view only reads them
-- side by side. PurpleAir is not a source: spend is not approved.
-- Cap of 5 saved places matches MAX_SAVED_PLACES in src/lib/v1/rules.ts.

create table if not exists saved_place (
  id text primary key,
  user_id text not null,
  name text not null,
  latitude double precision not null,
  longitude double precision not null,
  valley text,
  alert_at integer,
  position integer not null,
  created_at timestamptz not null default now(),
  constraint saved_place_id_user_key unique (id, user_id),
  constraint saved_place_name_chk check (char_length(name) between 1 and 120),
  constraint saved_place_lat_chk check (latitude >= -90 and latitude <= 90),
  constraint saved_place_lon_chk check (longitude >= -180 and longitude <= 180),
  constraint saved_place_alert_chk check (
    alert_at is null or (alert_at >= 0 and alert_at <= 500)
  )
);

create index if not exists saved_place_user_idx on saved_place (user_id, position);

-- One transaction-scoped lock per user. Held until commit, so the next
-- statement's count sees rows the waiter was blocked behind. Re-taken by the
-- trigger in the same transaction (advisory xact locks stack).
create or replace function saved_place_lock_user(p_user_id text)
returns void
language plpgsql
as $fn$
begin
  perform pg_advisory_xact_lock(hashtext('saved_place'), hashtext(p_user_id));
end;
$fn$;

create or replace function saved_place_enforce_cap()
returns trigger
language plpgsql
as $fn$
begin
  perform saved_place_lock_user(new.user_id);
  if (select count(*) from saved_place where user_id = new.user_id) >= 5 then
    raise exception 'saved places cap is 5';
  end if;
  return new;
end;
$fn$;

drop trigger if exists saved_place_cap on saved_place;
create trigger saved_place_cap
  before insert on saved_place
  for each row
  execute function saved_place_enforce_cap();

-- App path: lock, count, and insert are one transaction. p_cap is
-- MAX_SAVED_PLACES. The trigger above is the backstop for raw inserts.
create or replace function saved_place_add(
  p_id text,
  p_user_id text,
  p_name text,
  p_latitude double precision,
  p_longitude double precision,
  p_valley text,
  p_alert_at integer,
  p_cap integer
) returns saved_place
language plpgsql
as $fn$
declare
  n integer;
  pos integer;
  row saved_place;
begin
  perform saved_place_lock_user(p_user_id);
  select count(*)::int, coalesce(max(position), 0)::int
    into n, pos
    from saved_place
    where user_id = p_user_id;
  if n >= p_cap then
    raise exception 'saved places cap is 5';
  end if;
  insert into saved_place
    (id, user_id, name, latitude, longitude, valley, alert_at, position)
  values
    (p_id, p_user_id, p_name, p_latitude, p_longitude, p_valley, p_alert_at, pos + 1)
  returning * into row;
  return row;
end;
$fn$;

create table if not exists forecast_issued (
  id text primary key,
  place_id text not null,
  user_id text not null,
  source text not null,
  issued_at timestamptz not null,
  valid_for timestamptz not null,
  horizon text not null,
  spatial_scale text not null,
  confidence text not null,
  corrected_aqi integer not null,
  pollutant text,
  created_at timestamptz not null default now(),
  constraint forecast_place_user_fk
    foreign key (place_id, user_id) references saved_place (id, user_id) on delete cascade,
  constraint forecast_source_chk check (source in ('noaa_smoke', 'noaa_aqf', 'regional')),
  constraint forecast_horizon_chk check (
    horizon in ('day_1_2_valley', 'day_3_7_noaa_aqf', 'day_3_7_regional_low_confidence')
  ),
  constraint forecast_scale_chk check (spatial_scale in ('valley', 'regional')),
  constraint forecast_confidence_chk check (confidence in ('valley', 'model', 'low')),
  constraint forecast_aqi_chk check (corrected_aqi >= 0 and corrected_aqi <= 500),
  constraint forecast_pollutant_chk check (
    pollutant is null or char_length(pollutant) between 1 and 40
  ),
  constraint forecast_issue_unique unique (place_id, source, issued_at, valid_for),
  constraint forecast_day12_chk check (
    horizon <> 'day_1_2_valley'
    or (source = 'noaa_smoke' and spatial_scale = 'valley' and confidence = 'valley')
  ),
  constraint forecast_aqf_chk check (
    horizon <> 'day_3_7_noaa_aqf'
    or (source = 'noaa_aqf' and spatial_scale = 'regional' and confidence = 'model')
  ),
  constraint forecast_regional_chk check (
    horizon <> 'day_3_7_regional_low_confidence'
    or (source = 'regional' and spatial_scale = 'regional' and confidence = 'low')
  ),
  constraint forecast_window_chk check (
    valid_for >= issued_at
    and valid_for <= issued_at + interval '168 hours'
    and (
      (valid_for <= issued_at + interval '48 hours' and horizon = 'day_1_2_valley')
      or (
        valid_for > issued_at + interval '48 hours'
        and horizon <> 'day_1_2_valley'
      )
    )
  )
);

create index if not exists forecast_issued_place_valid_idx
  on forecast_issued (place_id, valid_for);

-- Official AirNow only. No corrected_aqi column on this table.
create table if not exists official_reading (
  id text primary key,
  place_id text not null,
  user_id text not null,
  source text not null default 'airnow',
  observed_at timestamptz not null,
  official_aqi integer not null,
  official_raw text not null,
  preliminary boolean not null,
  attribution text not null,
  created_at timestamptz not null default now(),
  constraint official_place_user_fk
    foreign key (place_id, user_id) references saved_place (id, user_id) on delete cascade,
  constraint official_source_chk check (source = 'airnow'),
  constraint official_aqi_chk check (official_aqi >= 0 and official_aqi <= 500),
  constraint official_raw_chk check (official_raw ~ '^[0-9]{1,3}$'),
  constraint official_prelim_chk check (preliminary = true),
  constraint official_attr_chk check (
    attribution like '%AirNow%' and char_length(attribution) > 20
  ),
  constraint official_hour_unique unique (place_id, observed_at)
);

create index if not exists official_reading_place_observed_idx
  on official_reading (place_id, observed_at);

-- Read-only pair. Inserts go to the base tables, never through this view.
create or replace view forecast_beside_observed as
select
  f.id as forecast_id,
  f.user_id,
  f.place_id,
  p.name as place_name,
  f.source as forecast_source,
  f.issued_at,
  f.valid_for,
  f.horizon,
  f.spatial_scale,
  f.confidence,
  f.corrected_aqi,
  f.pollutant,
  o.id as observation_id,
  o.official_aqi,
  o.official_raw,
  o.preliminary as official_preliminary,
  o.attribution as official_attribution,
  o.observed_at,
  o.source as official_source
from forecast_issued f
join saved_place p on p.id = f.place_id and p.user_id = f.user_id
left join official_reading o
  on o.place_id = f.place_id
 and o.user_id = f.user_id
 and o.observed_at = f.valid_for;

-- Week-1 push log. platform and sender stay 'test': no APNs key and no paid vendor.
create table if not exists push_device (
  id text primary key,
  user_id text not null,
  token text not null,
  platform text not null,
  created_at timestamptz not null default now(),
  constraint push_platform_chk check (platform = 'test'),
  constraint push_token_chk check (char_length(token) between 8 and 200),
  constraint push_device_token_unique unique (user_id, token)
);

create index if not exists push_device_user_idx on push_device (user_id);

create table if not exists push_delivery (
  id text primary key,
  user_id text not null,
  device_id text not null references push_device (id) on delete cascade,
  place_id text,
  forecast_id text,
  payload jsonb not null,
  status text not null,
  sender text not null,
  provider_id text,
  created_at timestamptz not null default now(),
  constraint push_status_chk check (status in ('sent', 'failed')),
  constraint push_sender_chk check (sender = 'test')
);

create index if not exists push_delivery_user_idx on push_delivery (user_id, created_at);

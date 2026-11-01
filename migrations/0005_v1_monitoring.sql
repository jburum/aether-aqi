-- Upstream call ledger for phase-4 monitoring.
--
-- One row per outbound NOAA, AirNow, or PurpleAir attempt. PurpleAir rows
-- store the points that attempt would cost. They do not store a URL, a key,
-- a user, or a place. This migration does not call any upstream host.

create table if not exists upstream_call (
  id text primary key,
  source text not null,
  endpoint_kind text not null,
  called_at timestamptz not null,
  outcome text not null,
  error_code text,
  points integer,
  constraint upstream_source_chk check (source in ('noaa', 'airnow', 'purpleair')),
  constraint upstream_outcome_chk check (outcome in ('ok', 'error')),
  constraint upstream_kind_chk check (
    endpoint_kind in (
      'hrrr_smoke_ascii',
      'aqf_ascii',
      'hrrr_stability_grib',
      'noaa_other',
      'airnow_current',
      'purpleair_sensors',
      'purpleair_history'
    )
  ),
  constraint upstream_error_chk check (
    (
      outcome = 'ok'
      and error_code is null
    )
    or (
      outcome = 'error'
      and error_code is not null
      and error_code ~ '^[a-z0-9_]{1,64}$'
    )
  ),
  constraint upstream_points_chk check (
    (
      source = 'purpleair'
      and points is not null
      and points >= 1
    )
    or (
      source <> 'purpleair'
      and points is null
    )
  ),
  constraint upstream_kind_source_chk check (
    (source = 'noaa' and endpoint_kind in (
      'hrrr_smoke_ascii', 'aqf_ascii', 'hrrr_stability_grib', 'noaa_other'
    ))
    or (source = 'airnow' and endpoint_kind = 'airnow_current')
    or (source = 'purpleair' and endpoint_kind in ('purpleair_sensors', 'purpleair_history'))
  )
);

create index if not exists upstream_call_called_idx on upstream_call (called_at);

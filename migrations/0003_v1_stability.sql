-- HRRR near-surface stability for the winter inversion alert.
--
-- Temperature is Kelvin, as NOMADS reports it. Wind is the 10 m speed in m/s.
-- Lead time stops at 48 hours, the same cut as the smoke model. No API key.

create table if not exists stability_issued (
  id text primary key,
  place_id text not null,
  user_id text not null,
  source text not null default 'noaa_hrrr',
  issued_at timestamptz not null,
  valid_for timestamptz not null,
  tmp_2m_k double precision not null,
  tmp_80m_k double precision not null,
  wind_10m_ms double precision not null,
  created_at timestamptz not null default now(),
  constraint stability_place_user_fk
    foreign key (place_id, user_id) references saved_place (id, user_id) on delete cascade,
  constraint stability_source_chk check (source = 'noaa_hrrr'),
  constraint stability_temp_chk check (
    tmp_2m_k >= 180 and tmp_2m_k <= 330
    and tmp_80m_k >= 180 and tmp_80m_k <= 330
  ),
  constraint stability_wind_chk check (wind_10m_ms >= 0 and wind_10m_ms <= 100),
  constraint stability_window_chk check (
    valid_for >= issued_at
    and valid_for <= issued_at + interval '48 hours'
  ),
  constraint stability_issue_unique unique (place_id, issued_at, valid_for)
);

create index if not exists stability_issued_place_valid_idx
  on stability_issued (place_id, valid_for);

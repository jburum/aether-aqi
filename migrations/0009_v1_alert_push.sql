-- One Pro push per alert episode.
--
-- push_delivery is one forecast hour for one test device. An episode spans
-- many hours and is not a forecast id, so that table cannot dedup an episode
-- without colliding with POST /api/v1/push/deliver.
-- A sent row is not sent again. A failed row is retried on the next run.
-- sender stays 'test'. No APNs key. This file is not applied to production
-- by the branch that adds it.

create table if not exists alert_push (
  id text primary key,
  user_id text not null,
  place_id text not null,
  kind text not null,
  episode_start timestamptz not null,
  forecast_id text,
  payload jsonb not null,
  status text not null,
  sender text not null,
  provider_id text,
  error_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alert_push_place_user_fk
    foreign key (place_id, user_id) references saved_place (id, user_id) on delete cascade,
  constraint alert_push_kind_chk check (kind in ('smoke', 'inversion', 'ozone')),
  constraint alert_push_status_chk check (status in ('sent', 'failed')),
  constraint alert_push_sender_chk check (sender = 'test'),
  constraint alert_push_error_chk check (
    error_text is null or char_length(error_text) <= 500
  ),
  constraint alert_push_episode_unique unique (user_id, place_id, kind, episode_start)
);

create index if not exists alert_push_user_idx on alert_push (user_id, created_at);

-- Official AirNow pollutant, so alerts can tell PM2.5 from ozone.
--
-- Nullable on purpose. Rows already stored stay null, and null is still
-- unknown to readAlerts. PM10 and every other ParameterName stay null.
-- No backfill. Existing columns and constraints are unchanged.

alter table official_reading
  add column parameter text;

alter table official_reading
  add constraint official_parameter_chk
    check (parameter is null or parameter in ('PM2.5', 'O3'));

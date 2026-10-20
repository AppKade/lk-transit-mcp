// Generated from 001_init.sql content; kept as a TS string so it bundles on any runtime.
export default `-- Plain Postgres (no PostGIS): the network is small; nearby search uses a lat/lon bounding box + haversine in SQL.
-- Every feed-content table is keyed by feed_version_id so a new feed is staged without touching the active one.

CREATE TABLE providers (
  id                     text PRIMARY KEY,
  name                   text NOT NULL,
  timezone               text NOT NULL,
  active_feed_version_id bigint
);

CREATE TABLE feed_versions (
  id            bigserial PRIMARY KEY,
  provider_id   text NOT NULL REFERENCES providers (id),
  status        text NOT NULL CHECK (status IN ('staged', 'active', 'rejected', 'retired')),
  checksum      text NOT NULL,
  label         text NOT NULL,                 -- human/LLM-readable version, e.g. 2026-10-20T03:00Z-ab12cd
  source_key    text NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz,
  calendar_start date,
  calendar_end   date,
  counts        jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation    jsonb NOT NULL DEFAULT '{}'::jsonb,
  archive_key   text
);
CREATE INDEX feed_versions_provider_status ON feed_versions (provider_id, status);
CREATE UNIQUE INDEX feed_versions_provider_checksum ON feed_versions (provider_id, checksum) WHERE status <> 'rejected';

ALTER TABLE providers
  ADD CONSTRAINT providers_active_fv FOREIGN KEY (active_feed_version_id) REFERENCES feed_versions (id);

CREATE TABLE stops (
  feed_version_id   bigint NOT NULL REFERENCES feed_versions (id) ON DELETE CASCADE,
  stop_id           text NOT NULL,
  name              text NOT NULL,
  lat               double precision NOT NULL,
  lon               double precision NOT NULL,
  code              text,
  description       text,
  zone_id           text,
  location_type     int NOT NULL DEFAULT 0,
  parent_station    text,
  wheelchair_boarding int,
  PRIMARY KEY (feed_version_id, stop_id)
);
CREATE INDEX stops_geo ON stops (feed_version_id, lat, lon);

CREATE TABLE routes (
  feed_version_id bigint NOT NULL REFERENCES feed_versions (id) ON DELETE CASCADE,
  route_id        text NOT NULL,
  agency_id       text,
  short_name      text,
  long_name       text,
  route_type      int NOT NULL,
  color           text,
  text_color      text,
  PRIMARY KEY (feed_version_id, route_id)
);
CREATE INDEX routes_short_name ON routes (feed_version_id, lower(short_name));

CREATE TABLE trips (
  feed_version_id bigint NOT NULL REFERENCES feed_versions (id) ON DELETE CASCADE,
  trip_id         text NOT NULL,
  route_id        text NOT NULL,
  service_id      text NOT NULL,
  headsign        text,
  short_name      text,
  direction_id    int,
  shape_id        text,
  wheelchair_accessible int,
  PRIMARY KEY (feed_version_id, trip_id)
);
CREATE INDEX trips_route ON trips (feed_version_id, route_id, direction_id);

CREATE TABLE stop_times (
  feed_version_id bigint NOT NULL REFERENCES feed_versions (id) ON DELETE CASCADE,
  trip_id         text NOT NULL,
  stop_sequence   int NOT NULL,
  stop_id         text NOT NULL,
  arrival_sec     int,            -- seconds since service-day start; may exceed 86400
  departure_sec   int,
  pickup_type     int,
  drop_off_type   int,
  PRIMARY KEY (feed_version_id, trip_id, stop_sequence)
);
CREATE INDEX stop_times_stop ON stop_times (feed_version_id, stop_id, departure_sec);

CREATE TABLE calendars (
  feed_version_id bigint NOT NULL REFERENCES feed_versions (id) ON DELETE CASCADE,
  service_id      text NOT NULL,
  monday boolean NOT NULL, tuesday boolean NOT NULL, wednesday boolean NOT NULL, thursday boolean NOT NULL,
  friday boolean NOT NULL, saturday boolean NOT NULL, sunday boolean NOT NULL,
  start_date date NOT NULL,
  end_date   date NOT NULL,
  PRIMARY KEY (feed_version_id, service_id)
);

CREATE TABLE calendar_dates (
  feed_version_id bigint NOT NULL REFERENCES feed_versions (id) ON DELETE CASCADE,
  service_id      text NOT NULL,
  date            date NOT NULL,
  exception_type  int NOT NULL CHECK (exception_type IN (1, 2)),
  PRIMARY KEY (feed_version_id, service_id, date)
);

CREATE TABLE shapes (
  feed_version_id bigint NOT NULL REFERENCES feed_versions (id) ON DELETE CASCADE,
  shape_id        text NOT NULL,
  seq             int NOT NULL,
  lat             double precision NOT NULL,
  lon             double precision NOT NULL,
  PRIMARY KEY (feed_version_id, shape_id, seq)
);
`;

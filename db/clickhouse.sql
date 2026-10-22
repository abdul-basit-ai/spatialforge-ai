-- SpatialForge append-only event stream (Aiven ClickHouse). Applied by `npm run db:migrate`.
-- dag_version lets error rates be grouped by instruction version.
CREATE TABLE IF NOT EXISTS spatial_events (
  event_id UUID DEFAULT generateUUIDv4(),
  session_id String,
  sequence UInt32,
  event_type LowCardinality(String),
  scenario_id LowCardinality(String),
  operator_code LowCardinality(String),
  dag_version LowCardinality(String) DEFAULT '1.0',
  mode LowCardinality(String),
  source LowCardinality(String),
  part_id LowCardinality(String),
  target_id LowCardinality(String),
  rotation Nullable(Int32),
  payload String,
  at DateTime64(3, 'UTC'),
  inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (scenario_id, operator_code, session_id, sequence);

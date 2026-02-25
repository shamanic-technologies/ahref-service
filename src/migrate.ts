import { Pool } from "pg";

const MIGRATION_SQL = `
DO $$ BEGIN
  CREATE TYPE ahref_data_type AS ENUM ('authority', 'traffic');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS apify_ahref (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url_input TEXT NOT NULL,
  domain TEXT NOT NULL,
  data_captured_at TIMESTAMPTZ NOT NULL,
  data_type ahref_data_type NOT NULL,
  mode TEXT,
  raw_data JSONB NOT NULL,
  authority_domain_rating INTEGER,
  authority_url_rating INTEGER,
  authority_backlinks INTEGER,
  authority_refdomains INTEGER,
  authority_dofollow_backlinks INTEGER,
  authority_dofollow_refdomains INTEGER,
  traffic_monthly_avg INTEGER,
  cost_monthly_avg BIGINT,
  traffic_history JSONB,
  traffic_top_pages JSONB,
  traffic_top_countries JSONB,
  traffic_top_keywords JSONB,
  overall_search_traffic BIGINT,
  overall_search_traffic_history JSONB,
  overall_search_traffic_value BIGINT,
  overall_search_traffic_value_history JSONB,
  overall_search_traffic_by_country JSONB,
  traffic_by_country JSONB,
  overall_search_traffic_keywords JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ahref_outlets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id UUID NOT NULL,
  apify_ahref_id UUID NOT NULL REFERENCES apify_ahref(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ahref_outlets_outlet ON ahref_outlets(outlet_id);
CREATE INDEX IF NOT EXISTS idx_ahref_outlets_apify ON ahref_outlets(apify_ahref_id);

-- View: v_outlets_domain_rating_to_update
CREATE OR REPLACE VIEW v_outlets_domain_rating_to_update AS
WITH outlet_dr_searches AS (
  SELECT aho.outlet_id,
    aa.authority_domain_rating,
    aa.data_captured_at,
    row_number() OVER (PARTITION BY aho.outlet_id ORDER BY aa.data_captured_at DESC) AS search_rank
  FROM ahref_outlets aho
  JOIN apify_ahref aa ON aho.apify_ahref_id = aa.id
  WHERE aa.data_type = 'authority'
), latest_dr_search AS (
  SELECT outlet_id,
    authority_domain_rating AS latest_dr,
    data_captured_at AS latest_search_date
  FROM outlet_dr_searches WHERE search_rank = 1
), latest_valid_dr AS (
  SELECT DISTINCT ON (outlet_id) outlet_id,
    authority_domain_rating AS latest_valid_dr,
    data_captured_at AS latest_valid_dr_date
  FROM outlet_dr_searches
  WHERE authority_domain_rating IS NOT NULL
  ORDER BY outlet_id, search_rank
), dr_update_status AS (
  SELECT DISTINCT aho.outlet_id,
    CASE
      WHEN lds.outlet_id IS NULL THEN true
      WHEN lvd.outlet_id IS NULL AND lds.latest_search_date < (now() - '1 mon'::interval) THEN true
      WHEN lvd.latest_valid_dr_date < (now() - '1 year'::interval) THEN true
      ELSE false
    END AS dr_to_update,
    CASE
      WHEN lds.outlet_id IS NULL THEN 'No DR fetched yet'
      WHEN lvd.outlet_id IS NULL AND lds.latest_search_date < (now() - '1 mon'::interval) THEN 'DR fetch to retry'
      WHEN lvd.latest_valid_dr_date < (now() - '1 year'::interval) THEN 'DR outdated'
      WHEN lvd.latest_valid_dr_date >= (now() - '1 year'::interval) THEN 'DR exists < 1 year'
      WHEN lvd.outlet_id IS NULL AND lds.latest_search_date >= (now() - '1 mon'::interval) THEN 'DR attempt < 1 month'
      ELSE NULL
    END AS dr_update_reason,
    lds.latest_search_date,
    lvd.latest_valid_dr,
    lvd.latest_valid_dr_date
  FROM ahref_outlets aho
  LEFT JOIN latest_dr_search lds ON aho.outlet_id = lds.outlet_id
  LEFT JOIN latest_valid_dr lvd ON aho.outlet_id = lvd.outlet_id
)
SELECT outlet_id,
  dr_to_update,
  dr_update_reason,
  latest_search_date AS dr_latest_search_date,
  latest_valid_dr,
  latest_valid_dr_date,
  CASE WHEN dr_to_update THEN true ELSE false END AS needs_update
FROM dr_update_status;

-- View: v_outlets_low_domain_rating
CREATE OR REPLACE VIEW v_outlets_low_domain_rating AS
SELECT *,
  CASE
    WHEN latest_valid_dr IS NULL THEN NULL
    WHEN latest_valid_dr < 10 THEN true
    ELSE false
  END AS has_low_domain_rating
FROM v_outlets_domain_rating_to_update
ORDER BY dr_latest_search_date DESC NULLS LAST;
`;

export const runMigrations = async (pool: Pool): Promise<void> => {
  console.log("Running migrations...");
  await pool.query(MIGRATION_SQL);
  console.log("Migrations complete.");
};

// CLI entry point
if (require.main === module) {
  const { Pool: PgPool } = require("pg");
  const pool = new PgPool({ connectionString: process.env.AHREF_SERVICE_DATABASE_URL });
  runMigrations(pool)
    .then(() => pool.end())
    .catch((err: unknown) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

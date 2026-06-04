import { Pool } from "pg";

/**
 * Migration is idempotent and DOMAIN-KEYED. It NEVER drops, truncates, or
 * deletes the apify_ahref data table — that table holds the valuable scraped
 * DR/traffic ratings and is the cache. Only the obsolete outlet link table and
 * outlet-keyed views are dropped (neither holds any rating data; the ratings
 * live in apify_ahref).
 */
const MIGRATION_SQL = `
DO $$ BEGIN
  CREATE TYPE ahref_data_type AS ENUM ('authority', 'traffic');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Data / cache table. Append-only history; the cache is "latest row per domain".
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

-- Optional org/user identity columns for traceability (ingestion leaves NULL).
ALTER TABLE apify_ahref ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE apify_ahref ADD COLUMN IF NOT EXISTS user_id UUID;

-- Domain is the cache key. Index it (plus the per-domain "latest authority"
-- access path used by the views).
CREATE INDEX IF NOT EXISTS idx_apify_ahref_domain ON apify_ahref(domain);
CREATE INDEX IF NOT EXISTS idx_apify_ahref_domain_authority
  ON apify_ahref(domain, data_captured_at DESC)
  WHERE data_type = 'authority';

-- Drop the obsolete outlet coupling. Views first (they reference the link
-- table), then the link table. apify_ahref is untouched.
DROP VIEW IF EXISTS v_outlets_low_domain_rating;
DROP VIEW IF EXISTS v_outlets_domain_rating_to_update;
DROP TABLE IF EXISTS ahref_outlets;

-- View: v_domains_domain_rating_to_update (domain-keyed)
CREATE OR REPLACE VIEW v_domains_domain_rating_to_update AS
WITH domain_dr_searches AS (
  SELECT aa.domain,
    aa.authority_domain_rating,
    aa.data_captured_at,
    row_number() OVER (PARTITION BY aa.domain ORDER BY aa.data_captured_at DESC) AS search_rank
  FROM apify_ahref aa
  WHERE aa.data_type = 'authority'
), latest_dr_search AS (
  SELECT domain,
    authority_domain_rating AS latest_dr,
    data_captured_at AS latest_search_date
  FROM domain_dr_searches WHERE search_rank = 1
), latest_valid_dr AS (
  SELECT DISTINCT ON (domain) domain,
    authority_domain_rating AS latest_valid_dr,
    data_captured_at AS latest_valid_dr_date
  FROM domain_dr_searches
  WHERE authority_domain_rating IS NOT NULL
  ORDER BY domain, search_rank
), dr_update_status AS (
  SELECT DISTINCT dds.domain,
    CASE
      WHEN lds.domain IS NULL THEN true
      WHEN lvd.domain IS NULL AND lds.latest_search_date < (now() - '1 mon'::interval) THEN true
      WHEN lvd.latest_valid_dr_date < (now() - '1 year'::interval) THEN true
      ELSE false
    END AS dr_to_update,
    CASE
      WHEN lds.domain IS NULL THEN 'No DR fetched yet'
      WHEN lvd.domain IS NULL AND lds.latest_search_date < (now() - '1 mon'::interval) THEN 'DR fetch to retry'
      WHEN lvd.latest_valid_dr_date < (now() - '1 year'::interval) THEN 'DR outdated'
      WHEN lvd.latest_valid_dr_date >= (now() - '1 year'::interval) THEN 'DR exists < 1 year'
      WHEN lvd.domain IS NULL AND lds.latest_search_date >= (now() - '1 mon'::interval) THEN 'DR attempt < 1 month'
      ELSE NULL
    END AS dr_update_reason,
    lds.latest_search_date,
    lvd.latest_valid_dr,
    lvd.latest_valid_dr_date
  FROM domain_dr_searches dds
  LEFT JOIN latest_dr_search lds ON dds.domain = lds.domain
  LEFT JOIN latest_valid_dr lvd ON dds.domain = lvd.domain
)
SELECT domain,
  dr_to_update,
  dr_update_reason,
  latest_search_date AS dr_latest_search_date,
  latest_valid_dr,
  latest_valid_dr_date,
  CASE WHEN dr_to_update THEN true ELSE false END AS needs_update
FROM dr_update_status;

-- View: v_domains_low_domain_rating (domain-keyed)
CREATE OR REPLACE VIEW v_domains_low_domain_rating AS
SELECT *,
  CASE
    WHEN latest_valid_dr IS NULL THEN NULL
    WHEN latest_valid_dr < 10 THEN true
    ELSE false
  END AS has_low_domain_rating
FROM v_domains_domain_rating_to_update
ORDER BY dr_latest_search_date DESC NULLS LAST;
`;

/**
 * AI-visibility (Ahrefs Brand-Radar) extends the SAME domain-keyed cache table
 * with a new `data_type` and three normalized columns. raw_data already
 * preserves the full upstream payload (bronze). The competitors column stores
 * the fully-resolved list (brandId resolved at ingest — brandId is GLOBAL in
 * brand-service, so it is valid for every org reading the cache).
 *
 * `ALTER TYPE ... ADD VALUE` runs as its own statement, separate from the
 * statements that USE the new value (the partial index + view), because a new
 * enum value added via ALTER TYPE cannot be used in the same transaction.
 */
const AI_VISIBILITY_MIGRATION_SQL = `
ALTER TABLE apify_ahref ADD COLUMN IF NOT EXISTS ai_mentions_total INTEGER;
ALTER TABLE apify_ahref ADD COLUMN IF NOT EXISTS ai_mentions_by_engine JSONB;
ALTER TABLE apify_ahref ADD COLUMN IF NOT EXISTS ai_top_competitors JSONB;

CREATE INDEX IF NOT EXISTS idx_apify_ahref_domain_ai_visibility
  ON apify_ahref(domain, data_captured_at DESC)
  WHERE data_type = 'ai_visibility';

-- View: latest AI-visibility row per domain (the cache read path).
CREATE OR REPLACE VIEW v_domains_ai_visibility_latest AS
SELECT DISTINCT ON (domain)
  domain,
  data_captured_at,
  ai_mentions_total,
  ai_mentions_by_engine,
  ai_top_competitors,
  raw_data
FROM apify_ahref
WHERE data_type = 'ai_visibility'
ORDER BY domain, data_captured_at DESC;
`;

export const runMigrations = async (pool: Pool): Promise<void> => {
  console.log("[ahref-service] Running migrations...");
  await pool.query(MIGRATION_SQL);
  await pool.query(
    `ALTER TYPE ahref_data_type ADD VALUE IF NOT EXISTS 'ai_visibility';`
  );
  await pool.query(AI_VISIBILITY_MIGRATION_SQL);
  console.log("[ahref-service] Migrations complete.");
};

// CLI entry point
if (require.main === module) {
  const { Pool: PgPool } = require("pg");
  const pool = new PgPool({ connectionString: process.env.AHREF_SERVICE_DATABASE_URL });
  runMigrations(pool)
    .then(() => pool.end())
    .catch((err: unknown) => {
      console.error("[ahref-service] Migration failed:", err);
      process.exit(1);
    });
}

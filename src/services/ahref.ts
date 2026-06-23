import { Pool } from "pg";
import { z } from "zod";
import { updateDomainRatingBodySchema } from "../schemas/apify-ahref";
import { normalizeDomain } from "../lib/domain";
import { assessTrafficPlausibility } from "../lib/traffic-plausibility";

/** Retry-eligibility cooldown for an implausible (invalidated) traffic snapshot. */
export const IMPLAUSIBLE_RESCRAPE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

type UpdateDomainRatingBody = z.infer<typeof updateDomainRatingBodySchema>;

/**
 * DR status for a set of domains. Domains MUST already be normalized by the
 * caller (route layer normalizes query input). Domains with no row in the view
 * (never fetched) get a default "needs update" response.
 */
export const getDrStatus = async (pool: Pool, domains: string[]) => {
  if (domains.length === 0) return [];

  const placeholders = domains.map((_, i) => `$${i + 1}`).join(",");
  const result = await pool.query(
    `SELECT domain, dr_to_update, dr_update_reason, dr_latest_search_date,
            latest_valid_dr, latest_valid_dr_date, needs_update
     FROM v_domains_domain_rating_to_update
     WHERE domain = ANY(ARRAY[${placeholders}]::text[])`,
    domains
  );

  const foundDomains = new Set(result.rows.map((r) => r.domain));

  const rows = result.rows.map(mapDrRow);

  // For domains not found in the view, return default "needs update" response.
  for (const domain of domains) {
    if (!foundDomains.has(domain)) {
      rows.push({
        domain,
        drToUpdate: true,
        drUpdateReason: "No DR fetched yet",
        drLatestSearchDate: null,
        latestValidDr: null,
        latestValidDrDate: null,
        needsUpdate: true,
      });
    }
  }

  return rows;
};

export const getDrStale = async (pool: Pool) => {
  const result = await pool.query(
    `SELECT domain, dr_to_update, dr_update_reason, dr_latest_search_date,
            latest_valid_dr, latest_valid_dr_date, needs_update
     FROM v_domains_domain_rating_to_update
     WHERE needs_update = true`
  );
  return result.rows.map(mapDrRow);
};

export const getLowDomainRating = async (pool: Pool) => {
  const result = await pool.query(
    `SELECT domain, dr_to_update, dr_update_reason, dr_latest_search_date,
            latest_valid_dr, latest_valid_dr_date, needs_update, has_low_domain_rating
     FROM v_domains_low_domain_rating
     WHERE has_low_domain_rating = true`
  );
  return result.rows.map((row) => ({
    ...mapDrRow(row),
    hasLowDomainRating: row.has_low_domain_rating,
  }));
};

/**
 * Ingest scraped Ahrefs data, keyed by normalized domain. This is a platform
 * ingestion path (the scraping worker hits the /internal tier), so there is no
 * org/user identity to attribute — org_id/user_id stay NULL.
 *
 * The data row in apify_ahref is append-only history; the cache is "the latest
 * row per domain". No existing rows are ever mutated or deleted.
 */
export const updateDomainRating = async (
  pool: Pool,
  body: UpdateDomainRatingBody
) => {
  const domain = normalizeDomain(body.domain);

  const insertResult = await pool.query(
    `INSERT INTO apify_ahref (
      url_input, domain, data_captured_at, data_type, mode, raw_data,
      authority_domain_rating, authority_url_rating, authority_backlinks,
      authority_refdomains, authority_dofollow_backlinks, authority_dofollow_refdomains,
      traffic_monthly_avg, cost_monthly_avg, traffic_history, traffic_top_pages,
      traffic_top_countries, traffic_top_keywords, overall_search_traffic,
      overall_search_traffic_history, overall_search_traffic_value,
      overall_search_traffic_value_history, overall_search_traffic_by_country,
      traffic_by_country, overall_search_traffic_keywords
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
    RETURNING id`,
    [
      body.urlInput ?? "",
      domain,
      body.dataCapturedAt,
      body.dataType,
      body.mode ?? null,
      JSON.stringify(body.rawData),
      body.authorityDomainRating ?? null,
      body.authorityUrlRating ?? null,
      body.authorityBacklinks ?? null,
      body.authorityRefdomains ?? null,
      body.authorityDofollowBacklinks ?? null,
      body.authorityDofollowRefdomains ?? null,
      body.trafficMonthlyAvg ?? null,
      body.costMonthlyAvg ?? null,
      body.trafficHistory ? JSON.stringify(body.trafficHistory) : null,
      body.trafficTopPages ? JSON.stringify(body.trafficTopPages) : null,
      body.trafficTopCountries ? JSON.stringify(body.trafficTopCountries) : null,
      body.trafficTopKeywords ? JSON.stringify(body.trafficTopKeywords) : null,
      body.overallSearchTraffic ?? null,
      body.overallSearchTrafficHistory
        ? JSON.stringify(body.overallSearchTrafficHistory)
        : null,
      body.overallSearchTrafficValue ?? null,
      body.overallSearchTrafficValueHistory
        ? JSON.stringify(body.overallSearchTrafficValueHistory)
        : null,
      body.overallSearchTrafficByCountry
        ? JSON.stringify(body.overallSearchTrafficByCountry)
        : null,
      body.trafficByCountry ? JSON.stringify(body.trafficByCountry) : null,
      body.overallSearchTrafficKeywords
        ? JSON.stringify(body.overallSearchTrafficKeywords)
        : null,
    ]
  );

  const id = insertResult.rows[0].id as string;

  // Promote a traffic bronze row into the silver layer (monthly organic series
  // + rich current snapshot). Authority rows have no silver projection.
  if (body.dataType === "traffic") {
    await promoteTrafficSilver(pool, {
      domain,
      bronzeId: id,
      dataCapturedAt: body.dataCapturedAt,
      trafficMonthlyAvg: body.trafficMonthlyAvg ?? null,
      costMonthlyAvg: body.costMonthlyAvg ?? null,
      trafficHistory: body.trafficHistory,
      topPages: body.trafficTopPages ?? null,
      topCountries: body.trafficTopCountries ?? null,
      topKeywords: body.trafficTopKeywords ?? null,
    });
  }

  return { id, domain };
};

interface TrafficSilverInput {
  domain: string;
  bronzeId: string;
  dataCapturedAt: string;
  trafficMonthlyAvg: number | null;
  costMonthlyAvg: number | null;
  trafficHistory: unknown;
  topPages: unknown;
  topCountries: unknown;
  topKeywords: unknown;
}

/**
 * Deterministically project a traffic bronze row into the silver layer
 * (no LLM — structured JSON). Two upserts, both idempotent:
 *  - `domain_traffic_snapshot`: the rich current values for this scrape
 *    (deduped on the capture timestamp). Tagged with a plausibility verdict so a
 *    partial / empty scrape (a number with no page evidence) is invalidated, not
 *    surfaced as success — see `assessTrafficPlausibility`.
 *  - `domain_traffic_monthly`: one row per (domain, month) exploded from
 *    `trafficHistory`, last-write-wins by the bronze `data_captured_at` so an
 *    older scrape never clobbers a month a newer scrape already wrote. SKIPPED
 *    for an implausible scrape.
 */
export const promoteTrafficSilver = async (
  pool: Pool,
  input: TrafficSilverInput
): Promise<void> => {
  const { implausible, reason } = assessTrafficPlausibility({
    trafficMonthlyAvg: input.trafficMonthlyAvg,
    topPages: input.topPages,
  });

  await pool.query(
    `INSERT INTO domain_traffic_snapshot (
      domain, data_captured_at, traffic_monthly_avg, traffic_value_monthly_avg,
      top_pages, top_countries, top_keywords, source_bronze_id,
      traffic_implausible, traffic_implausible_reason
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (domain, data_captured_at) DO UPDATE SET
      traffic_monthly_avg = EXCLUDED.traffic_monthly_avg,
      traffic_value_monthly_avg = EXCLUDED.traffic_value_monthly_avg,
      top_pages = EXCLUDED.top_pages,
      top_countries = EXCLUDED.top_countries,
      top_keywords = EXCLUDED.top_keywords,
      source_bronze_id = EXCLUDED.source_bronze_id,
      traffic_implausible = EXCLUDED.traffic_implausible,
      traffic_implausible_reason = EXCLUDED.traffic_implausible_reason,
      last_rebuilt_at = CURRENT_TIMESTAMP`,
    [
      input.domain,
      input.dataCapturedAt,
      input.trafficMonthlyAvg,
      input.costMonthlyAvg,
      input.topPages != null ? JSON.stringify(input.topPages) : null,
      input.topCountries != null ? JSON.stringify(input.topCountries) : null,
      input.topKeywords != null ? JSON.stringify(input.topKeywords) : null,
      input.bronzeId,
      implausible,
      reason,
    ]
  );

  // An implausible scrape's monthly series is wrong-scoped too — do not promote
  // it into silver. The bronze row keeps the full payload for audit.
  if (implausible) return;

  const history = Array.isArray(input.trafficHistory)
    ? (input.trafficHistory as Array<{ date?: unknown; organic?: unknown }>)
    : [];

  for (const point of history) {
    if (typeof point?.date !== "string") continue;
    const organic =
      typeof point.organic === "number" && Number.isFinite(point.organic)
        ? Math.trunc(point.organic)
        : null;
    await pool.query(
      `INSERT INTO domain_traffic_monthly (
        domain, month, organic_traffic, source_bronze_id, data_captured_at
      ) VALUES ($1, date_trunc('month', $2::date), $3, $4, $5)
      ON CONFLICT (domain, month) DO UPDATE SET
        organic_traffic = EXCLUDED.organic_traffic,
        source_bronze_id = EXCLUDED.source_bronze_id,
        data_captured_at = EXCLUDED.data_captured_at,
        last_rebuilt_at = CURRENT_TIMESTAMP
      WHERE EXCLUDED.data_captured_at >= domain_traffic_monthly.data_captured_at`,
      [input.domain, point.date, organic, input.bronzeId, input.dataCapturedAt]
    );
  }
};

const toIsoOrNull = (v: unknown): string | null => {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
};

const toMonthString = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v);

/**
 * Read the traffic silver/gold for a set of domains. Domains MUST already be
 * normalized by the caller. Returns the latest rich snapshot plus the full
 * ascending monthly organic series per domain; a never-scraped domain comes
 * back with `hasData:false` and an empty series (pure read — no spend).
 */
export const getTrafficHistory = async (pool: Pool, domains: string[]) => {
  if (domains.length === 0) return [];

  const placeholders = domains.map((_, i) => `$${i + 1}`).join(",");

  const latest = await pool.query(
    `SELECT domain, data_captured_at, traffic_monthly_avg, traffic_value_monthly_avg,
            top_pages, top_countries, top_keywords,
            traffic_implausible, traffic_implausible_reason
     FROM v_domain_traffic_latest
     WHERE domain = ANY(ARRAY[${placeholders}]::text[])`,
    domains
  );

  const monthly = await pool.query(
    `SELECT domain, month, organic_traffic
     FROM domain_traffic_monthly
     WHERE domain = ANY(ARRAY[${placeholders}]::text[])
     ORDER BY domain, month ASC`,
    domains
  );

  const latestByDomain = new Map<string, Record<string, unknown>>();
  for (const r of latest.rows) latestByDomain.set(r.domain as string, r);

  const monthlyByDomain = new Map<
    string,
    Array<{ month: string; organicTraffic: number | null }>
  >();
  for (const r of monthly.rows) {
    const arr = monthlyByDomain.get(r.domain as string) ?? [];
    arr.push({
      month: toMonthString(r.month),
      organicTraffic: r.organic_traffic as number | null,
    });
    monthlyByDomain.set(r.domain as string, arr);
  }

  return domains.map((domain) => {
    const snap = latestByDomain.get(domain);
    const series = monthlyByDomain.get(domain) ?? [];
    // An implausible (invalidated) latest snapshot is NOT trustworthy: surface
    // it as an explicit "no reliable data" signal (null value + empty series +
    // hasData:false) so the consumer never shows a silently-wrong tiny number,
    // and so the worker re-scrapes it (after a cooldown). The flag + reason are
    // exposed so a caller can distinguish "never scraped" from "scrape rejected".
    const implausible = Boolean(snap?.traffic_implausible);
    return {
      domain,
      hasData: implausible ? false : Boolean(snap) || series.length > 0,
      latestDataCapturedAt: toIsoOrNull(snap?.data_captured_at),
      trafficMonthlyAvg: implausible
        ? null
        : (snap?.traffic_monthly_avg as number | null) ?? null,
      trafficValueMonthlyAvg: implausible
        ? null
        : (snap?.traffic_value_monthly_avg as number | null) ?? null,
      topPages: implausible ? null : snap?.top_pages ?? null,
      topCountries: implausible ? null : snap?.top_countries ?? null,
      topKeywords: implausible ? null : snap?.top_keywords ?? null,
      monthlyOrganicTraffic: implausible ? [] : series,
      trafficImplausible: implausible,
      trafficImplausibleReason: implausible
        ? (snap?.traffic_implausible_reason as string | null) ?? null
        : null,
    };
  });
};

const mapDrRow = (row: Record<string, unknown>) => ({
  domain: row.domain as string,
  drToUpdate: row.dr_to_update as boolean,
  drUpdateReason: row.dr_update_reason as string | null,
  drLatestSearchDate: row.dr_latest_search_date
    ? (row.dr_latest_search_date as Date).toISOString()
    : null,
  latestValidDr: row.latest_valid_dr as number | null,
  latestValidDrDate: row.latest_valid_dr_date
    ? (row.latest_valid_dr_date as Date).toISOString()
    : null,
  needsUpdate: row.needs_update as boolean,
});

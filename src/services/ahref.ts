import { Pool } from "pg";
import { z } from "zod";
import { updateDomainRatingBodySchema } from "../schemas/apify-ahref";

type UpdateDomainRatingBody = z.infer<typeof updateDomainRatingBodySchema>;

export const getDrStatus = async (pool: Pool, outletIds: string[]) => {
  if (outletIds.length === 0) return [];

  const placeholders = outletIds.map((_, i) => `$${i + 1}`).join(",");
  const result = await pool.query(
    `SELECT outlet_id, dr_to_update, dr_update_reason, dr_latest_search_date,
            latest_valid_dr, latest_valid_dr_date, needs_update
     FROM v_outlets_domain_rating_to_update
     WHERE outlet_id = ANY(ARRAY[${placeholders}]::uuid[])`,
    outletIds
  );

  const foundIds = new Set(result.rows.map((r) => r.outlet_id));

  const rows = result.rows.map(mapDrRow);

  // For outlet IDs not found in the view, return default "needs update" response
  for (const id of outletIds) {
    if (!foundIds.has(id)) {
      rows.push({
        outletId: id,
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
    `SELECT outlet_id, dr_to_update, dr_update_reason, dr_latest_search_date,
            latest_valid_dr, latest_valid_dr_date, needs_update
     FROM v_outlets_domain_rating_to_update
     WHERE needs_update = true`
  );
  return result.rows.map(mapDrRow);
};

export const getLowDomainRating = async (pool: Pool) => {
  const result = await pool.query(
    `SELECT outlet_id, dr_to_update, dr_update_reason, dr_latest_search_date,
            latest_valid_dr, latest_valid_dr_date, needs_update, has_low_domain_rating
     FROM v_outlets_low_domain_rating
     WHERE has_low_domain_rating = true`
  );
  return result.rows.map((row) => ({
    ...mapDrRow(row),
    hasLowDomainRating: row.has_low_domain_rating,
  }));
};

export const updateDomainRating = async (
  pool: Pool,
  outletId: string,
  body: UpdateDomainRatingBody
) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Insert into apify_ahref
    const insertResult = await client.query(
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
        body.domain ?? "",
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

    const apifyAhrefId = insertResult.rows[0].id;

    // Upsert ahref_outlets link
    await client.query(
      `INSERT INTO ahref_outlets (outlet_id, apify_ahref_id)
       VALUES ($1, $2)`,
      [outletId, apifyAhrefId]
    );

    await client.query("COMMIT");

    return { id: apifyAhrefId, outletId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const mapDrRow = (row: Record<string, unknown>) => ({
  outletId: row.outlet_id as string,
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

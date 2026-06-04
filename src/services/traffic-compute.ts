import { Pool } from "pg";
import type { OrgContext } from "../middleware/org-context";
import { normalizeDomain } from "../lib/domain";
import { getTrafficHistory, updateDomainRating } from "./ahref";
import { runTrafficScrape, type ApifyTrafficResult } from "./apify";
import { getPlatformKey } from "./key";
import { authorize } from "./billing";
import { addCost, closeRun, createChildRun, setCostStatus } from "./runs";

/** Byte-equal to the costs-service catalog row. Mismatch ⇒ runs-service 422. */
const COST_NAME = "apify-ahrefs-result";
const APIFY_PROVIDER = "apify";
const CALLER = {
  service: "ahref-service",
  method: "POST",
  path: "/orgs/domains/traffic-compute",
};

const mapResultToBody = (r: ApifyTrafficResult) => ({
  domain: r.domain,
  dataType: "traffic" as const,
  dataCapturedAt: new Date().toISOString(),
  urlInput: r.domain,
  mode: r.mode ?? "domain",
  rawData: r.raw,
  trafficMonthlyAvg: r.trafficMonthlyAvg,
  costMonthlyAvg: r.costMonthlyAvg,
  trafficHistory: r.trafficHistory,
  trafficTopPages: r.topPages,
  trafficTopCountries: r.topCountries,
  trafficTopKeywords: r.topKeywords,
});

/**
 * Compute traffic for a set of domains by scraping the Ahrefs traffic overview
 * via Apify, persisting each result into bronze, and projecting it into silver.
 * Same metered order as DR compute: PROVISION → AUTHORIZE → EXECUTE →
 * ACTUALIZE/CANCEL, fail-loud at every step (route → 502). The Apify result
 * unit is uniform across search types, so it declares the same
 * `apify-ahrefs-result` cost as the DR path.
 *
 * Traffic is global reference data (not org-scoped); org attribution lives on
 * the run + cost, not on the persisted rows.
 */
export const computeTraffic = async (pool: Pool, domains: string[], ctx: OrgContext) => {
  // Normalize + dedupe so www/non-www and casing collapse to one key. Throws on
  // an unusable domain (→ 400 at the route).
  const normalized = [...new Set(domains.map(normalizeDomain))];

  const runId = await createChildRun("traffic-compute", ctx);
  let provisionCostId: string | null = null;

  try {
    // 1. PROVISION — worst-case quantity from inputs (1 result per domain).
    provisionCostId = await addCost(
      runId,
      {
        costName: COST_NAME,
        costSource: "org",
        quantity: normalized.length,
        status: "provisioned",
        idempotencyKey: `ahref:traffic-compute:${runId}:provision`,
      },
      ctx
    );

    // 2. AUTHORIZE — Apify is a platform key, so the org's balance must cover it.
    await authorize(
      [{ costName: COST_NAME, quantity: normalized.length }],
      `ahref-service traffic scrape (${normalized.length} domains)`,
      runId,
      ctx
    );

    // 3. EXECUTE — resolve the platform Apify key, then run the scrape.
    const apifyToken = await getPlatformKey(APIFY_PROVIDER, CALLER);
    const { results, chargedResults } = await runTrafficScrape(apifyToken, normalized);

    // Persist each scraped row into bronze; silver promotion runs inside
    // updateDomainRating for traffic rows.
    for (const r of results) {
      await updateDomainRating(pool, mapResultToBody(r));
    }

    // 4. ACTUALIZE — bill the real charged result count, cancel the hold.
    await addCost(
      runId,
      {
        costName: COST_NAME,
        costSource: "org",
        quantity: chargedResults > 0 ? chargedResults : normalized.length,
        status: "actual",
        idempotencyKey: `ahref:traffic-compute:${runId}:actual`,
      },
      ctx
    );
    await setCostStatus(runId, provisionCostId, "cancelled", ctx);

    await closeRun(runId, "completed", ctx);

    // Read the freshly-persisted traffic back from silver/gold for the response.
    return await getTrafficHistory(pool, normalized);
  } catch (err) {
    // Cleanup is best-effort; the original error is what fails the request loud.
    if (provisionCostId) {
      try {
        await setCostStatus(runId, provisionCostId, "cancelled", ctx);
      } catch (cleanupErr) {
        console.error(
          `[ahref-service] failed to cancel provisioned cost ${provisionCostId} for run ${runId}:`,
          cleanupErr
        );
      }
    }
    try {
      await closeRun(runId, "failed", ctx);
    } catch (cleanupErr) {
      console.error(`[ahref-service] failed to close run ${runId} as failed:`, cleanupErr);
    }
    throw err;
  }
};

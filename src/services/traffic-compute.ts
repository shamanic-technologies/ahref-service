import { Pool } from "pg";
import type { OrgContext } from "../middleware/org-context";
import { normalizeDomain } from "../lib/domain";
import { getTrafficHistory, updateDomainRating } from "./ahref";
import { runTrafficScrape, type ApifyTrafficResult } from "./apify";
import { getPlatformKey } from "./key";
import { authorize } from "./billing";
import { addCost, closeRun, createChildRun, setCostStatus } from "./runs";
import {
  enqueueDomainMetricJobs,
  scheduleDomainMetricWorker,
  type DomainMetricJob,
} from "./domain-metric-jobs";

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
const executeTrafficCompute = async (
  pool: Pool,
  domains: string[],
  ctx: OrgContext
) => {
  // Normalize + dedupe so www/non-www and casing collapse to one key. Throws on
  // an unusable domain (→ 400 at the route).
  const normalized = [...new Set(domains.map(normalizeDomain))];
  if (normalized.length === 0) return;

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

const processOrgTrafficJobs = async (pool: Pool, jobs: DomainMetricJob[]) => {
  if (jobs.length === 0) return;

  const domains = [...new Set(jobs.map((job) => job.domain))];
  const before = await getTrafficHistory(pool, domains);
  const domainsToScrape = [
    ...new Set(
      before.filter((status) => !status.hasData).map((status) => status.domain)
    ),
  ];
  if (domainsToScrape.length === 0) return;

  const first = jobs[0];
  await executeTrafficCompute(pool, domainsToScrape, {
    orgId: first.orgId,
    userId: first.userId,
    runId: first.parentRunId,
  });
};

/**
 * Request a traffic refresh without holding the HTTP caller open for Apify.
 * The response remains the existing traffic read shape; domains with no saved
 * traffic are queued and become visible after the background worker persists
 * the bronze + silver rows.
 */
export const computeTraffic = async (
  pool: Pool,
  domains: string[],
  ctx: OrgContext
) => {
  const normalized = [...new Set(domains.map(normalizeDomain))];
  const before = await getTrafficHistory(pool, normalized);
  const domainsToQueue = [
    ...new Set(before.filter((status) => !status.hasData).map((status) => status.domain)),
  ];

  if (domainsToQueue.length > 0) {
    await enqueueDomainMetricJobs(pool, "traffic", domainsToQueue, ctx);
    scheduleDomainMetricWorker(pool, "traffic", ctx.orgId, (jobs) =>
      processOrgTrafficJobs(pool, jobs)
    );
  }

  return before;
};

import { Pool } from "pg";
import type { OrgContext } from "../middleware/org-context";
import { normalizeDomain } from "../lib/domain";
import { getDrStatus, updateDomainRating } from "./ahref";
import { runDrScrape, type ApifyDrResult } from "./apify";
import { getPlatformKey, type CallerInfo } from "./key";
import { authorize } from "./billing";
import {
  addCost,
  addPlatformCost,
  closePlatformRun,
  closeRun,
  createChildRun,
  createPlatformRun,
  setCostStatus,
} from "./runs";

/** Byte-equal to the costs-service catalog row. Mismatch ⇒ runs-service 422. */
const COST_NAME = "apify-ahrefs-result";
const APIFY_PROVIDER = "apify";
const CALLER = {
  service: "ahref-service",
  method: "POST",
  path: "/orgs/domains/dr-compute",
};
const PLATFORM_CALLER = {
  service: "ahref-service",
  method: "POST",
  path: "/internal/domains/dr-compute",
};

const mapResultToBody = (r: ApifyDrResult) => ({
  domain: r.domain,
  dataType: "authority" as const,
  dataCapturedAt: new Date().toISOString(),
  urlInput: r.domain,
  mode: r.mode ?? "domain",
  rawData: r.raw,
  authorityDomainRating: r.domainRating,
  authorityBacklinks: r.backlinks,
  authorityRefdomains: r.refdomains,
  authorityDofollowBacklinks: r.dofollowBacklinks,
  authorityDofollowRefdomains: r.dofollowRefdomains,
});

const scrapeAndPersistDr = async (
  pool: Pool,
  domains: string[],
  caller: CallerInfo
) => {
  const apifyToken = await getPlatformKey(APIFY_PROVIDER, caller);
  const { results, chargedResults } = await runDrScrape(apifyToken, domains);

  for (const r of results) {
    await updateDomainRating(pool, mapResultToBody(r));
  }

  return chargedResults > 0 ? chargedResults : domains.length;
};

/**
 * Compute DR for a set of domains by scraping Ahrefs via Apify, then persisting
 * the result into the cache. Declares cost in the strict order required for any
 * metered spend: PROVISION → AUTHORIZE → EXECUTE → ACTUALIZE/CANCEL. Every step
 * is fail-loud; on any failure the provisioned hold is cancelled, the run is
 * closed `failed`, and the error propagates (route → 502).
 *
 * DR is global reference data (not org-scoped), so the persisted rating row
 * carries no org_id — the org attribution lives on the run + cost.
 */
export const computeDr = async (pool: Pool, domains: string[], ctx: OrgContext) => {
  // Normalize + dedupe so www/non-www and casing collapse to one key. Throws on
  // an unusable domain (→ 400 at the route).
  const normalized = [...new Set(domains.map(normalizeDomain))];

  const runId = await createChildRun("dr-compute", ctx);
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
        idempotencyKey: `ahref:dr-compute:${runId}:provision`,
      },
      ctx
    );

    // 2. AUTHORIZE — Apify is a platform key, so the org's balance must cover it.
    await authorize(
      [{ costName: COST_NAME, quantity: normalized.length }],
      `ahref-service DR scrape (${normalized.length} domains)`,
      runId,
      ctx
    );

    // 3. EXECUTE — resolve the platform Apify key, then run the scrape.
    const chargedQuantity = await scrapeAndPersistDr(pool, normalized, CALLER);

    // 4. ACTUALIZE — bill the real charged result count, cancel the hold.
    await addCost(
      runId,
      {
        costName: COST_NAME,
        costSource: "org",
        quantity: chargedQuantity,
        status: "actual",
        idempotencyKey: `ahref:dr-compute:${runId}:actual`,
      },
      ctx
    );
    await setCostStatus(runId, provisionCostId, "cancelled", ctx);

    await closeRun(runId, "completed", ctx);

    // Read the freshly-persisted DR back from the cache for the response.
    return await getDrStatus(pool, normalized);
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

/**
 * Internal/platform DR trigger for backend services that only have service auth.
 * This route computes only missing/stale domains according to ahref-service's
 * domain-keyed cache view; fresh cached domains are returned without a scrape.
 *
 * Platform runs have no org balance to authorize. They still fail loud and
 * record ahref-owned platform cost on the platform run once the Apify scrape
 * returns the charged result count.
 */
export const computeMissingPlatformDr = async (pool: Pool, domains: string[]) => {
  const normalized = [...new Set(domains.map(normalizeDomain))];
  const before = await getDrStatus(pool, normalized);
  const domainsToScrape = [
    ...new Set(before.filter((status) => status.needsUpdate).map((status) => status.domain)),
  ];

  if (domainsToScrape.length === 0) {
    return before;
  }

  const runId = await createPlatformRun("platform-dr-compute");

  try {
    const chargedQuantity = await scrapeAndPersistDr(pool, domainsToScrape, PLATFORM_CALLER);

    await addPlatformCost(runId, {
      costName: COST_NAME,
      costSource: "platform",
      quantity: chargedQuantity,
      status: "actual",
    });

    await closePlatformRun(runId, "completed");

    return await getDrStatus(pool, normalized);
  } catch (err) {
    try {
      await closePlatformRun(runId, "failed");
    } catch (cleanupErr) {
      console.error(`[ahref-service] failed to close platform run ${runId} as failed:`, cleanupErr);
    }
    throw err;
  }
};

import { Pool } from "pg";
import type { OrgContext } from "../middleware/org-context";
import { normalizeDomain } from "../lib/domain";
import { runAiVisibilityScrape, type ApifyAiVisibilityResult } from "./apify";
import { resolveBrandsByDomain } from "./brand";
import { getPlatformKey } from "./key";
import { authorize } from "./billing";
import { addCost, closeRun, createChildRun, setCostStatus } from "./runs";

/** Byte-equal to the costs-service catalog row. Same Apify actor as DR, so the
 * AI-visibility scrape bills under the SAME cost name (one result per call). */
const COST_NAME = "apify-ahrefs-result";
const APIFY_PROVIDER = "apify";
const CALLER = {
  service: "ahref-service",
  method: "POST",
  path: "/orgs/domains/ai-visibility",
};

/** Cache freshness window. 6 days, so a weekly (7-day) consumer cadence always
 * triggers a fresh scrape rather than returning stale data. */
const TTL_MS = 6 * 24 * 60 * 60 * 1000;

/** Max competitor brands resolved + returned, by citation count (top N). */
const TOP_COMPETITORS = 10;

export interface MentionsByEngine {
  engine: string;
  mentions: number;
}

export interface TopCompetitor {
  brandId: string;
  brand: string | null;
  domain: string | null;
  citations: number;
}

export interface AiVisibilityResponse {
  domain: string;
  snapshotDate: string | null;
  fetchedFromCache: boolean;
  mentionsTotal: number;
  mentionsByEngine: MentionsByEngine[];
  topCompetitors: TopCompetitor[];
  raw: Record<string, unknown>;
}

/** Lean cached snapshot — the read-only GET shape: the POST success shape minus
 * the scrape-only fields (`fetchedFromCache`, `raw`). */
export interface AiVisibilityCachedResponse {
  domain: string;
  snapshotDate: string | null;
  mentionsTotal: number;
  mentionsByEngine: MentionsByEngine[];
  topCompetitors: TopCompetitor[];
}

/**
 * Stable lower-snake-case engine key from the actor's model name.
 * `Chatgpt` → `chatgpt`, `GoogleAIOverviews` → `google_ai_overviews`,
 * `GoogleAIMode` → `google_ai_mode`.
 */
export const toEngineKey = (model: string): string =>
  model
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

/** Safe normalization for matching competitor domains; falls back to the raw
 * lowercased string if the upstream domain is not a clean hostname. */
const safeNormalize = (domain: string): string => {
  try {
    return normalizeDomain(domain);
  } catch {
    return domain.trim().toLowerCase();
  }
};

const toIso = (d: Date | string): Date => (d instanceof Date ? d : new Date(d));

const snapshotDateOf = (capturedAt: Date | string): string =>
  toIso(capturedAt).toISOString().slice(0, 10);

/**
 * Resolve the top-N cited competitor domains to global brand identities via
 * brand-service. Competitors brand-service cannot resolve (omitted from its
 * response) are excluded + logged — they are upstream data-quality junk, not a
 * failure of this request (brand-service infra errors fail loud in the client).
 */
const resolveTopCompetitors = async (
  result: ApifyAiVisibilityResult
): Promise<TopCompetitor[]> => {
  const ranked = result.topCitedDomains
    .filter((c) => c.domain)
    .sort((a, b) => b.citations - a.citations)
    .slice(0, TOP_COMPETITORS);

  if (ranked.length === 0) return [];

  const resolved = await resolveBrandsByDomain(ranked.map((c) => c.domain));
  const byNorm = new Map(resolved.map((r) => [safeNormalize(r.domain ?? ""), r]));

  const competitors: TopCompetitor[] = [];
  for (const c of ranked) {
    const match = byNorm.get(safeNormalize(c.domain));
    if (!match) {
      console.warn(
        `[ahref-service] competitor domain "${c.domain}" not resolved by brand-service — excluding`
      );
      continue;
    }
    competitors.push({
      brandId: match.brandId,
      brand: match.name,
      domain: match.domain ?? c.domain,
      citations: c.citations,
    });
  }
  return competitors;
};

interface AiVisibilityRow {
  data_captured_at: Date | string;
  ai_mentions_total: number | null;
  ai_mentions_by_engine: MentionsByEngine[] | null;
  ai_top_competitors: TopCompetitor[] | null;
  raw_data: Record<string, unknown> | null;
}

/** Latest AI-visibility row for a domain, or null if never scraped. */
const readLatest = async (
  pool: Pool,
  domain: string
): Promise<AiVisibilityRow | null> => {
  const result = await pool.query(
    `SELECT data_captured_at, ai_mentions_total, ai_mentions_by_engine,
            ai_top_competitors, raw_data
     FROM v_domains_ai_visibility_latest
     WHERE domain = $1`,
    [domain]
  );
  return (result.rows[0] as AiVisibilityRow | undefined) ?? null;
};

const isFresh = (capturedAt: Date | string): boolean =>
  Date.now() - toIso(capturedAt).getTime() < TTL_MS;

interface AiVisibilityCachedRow {
  domain: string;
  data_captured_at: Date | string;
  ai_mentions_total: number | null;
  ai_mentions_by_engine: MentionsByEngine[] | null;
  ai_top_competitors: TopCompetitor[] | null;
}

/**
 * Read the latest cached Brand-Radar AI-visibility snapshot for a set of
 * domains. Domains MUST already be normalized by the caller. This is a PURE
 * read of `v_domains_ai_visibility_latest`:
 *   - NO freshness gate — returns the latest snapshot even if stale (the POST
 *     owns the on-demand refresh); a stale read never triggers a scrape.
 *   - NO Apify scrape, NO cost declaration, NO authorize, NO brand resolve.
 * A never-scraped domain comes back absent-shaped (snapshotDate null, zero
 * mentions, empty arrays) — never a 404, never omitted from the array.
 */
export const getAiVisibilityCached = async (
  pool: Pool,
  domains: string[]
): Promise<AiVisibilityCachedResponse[]> => {
  if (domains.length === 0) return [];

  const placeholders = domains.map((_, i) => `$${i + 1}`).join(",");
  const result = await pool.query(
    `SELECT domain, data_captured_at, ai_mentions_total, ai_mentions_by_engine,
            ai_top_competitors
     FROM v_domains_ai_visibility_latest
     WHERE domain = ANY(ARRAY[${placeholders}]::text[])`,
    domains
  );

  const byDomain = new Map<string, AiVisibilityCachedRow>();
  for (const row of result.rows as AiVisibilityCachedRow[]) {
    byDomain.set(row.domain, row);
  }

  return domains.map((domain) => {
    const row = byDomain.get(domain);
    if (!row) {
      return {
        domain,
        snapshotDate: null,
        mentionsTotal: 0,
        mentionsByEngine: [],
        topCompetitors: [],
      };
    }
    return {
      domain,
      snapshotDate: snapshotDateOf(row.data_captured_at),
      mentionsTotal: row.ai_mentions_total ?? 0,
      mentionsByEngine: row.ai_mentions_by_engine ?? [],
      topCompetitors: row.ai_top_competitors ?? [],
    };
  });
};

/** Persist one AI-visibility snapshot (append-only history; cache = latest row). */
const insertSnapshot = async (
  pool: Pool,
  domain: string,
  capturedAt: Date,
  mentionsTotal: number,
  mentionsByEngine: MentionsByEngine[],
  topCompetitors: TopCompetitor[],
  raw: Record<string, unknown>
): Promise<void> => {
  await pool.query(
    `INSERT INTO apify_ahref (
       url_input, domain, data_captured_at, data_type, raw_data,
       ai_mentions_total, ai_mentions_by_engine, ai_top_competitors
     ) VALUES ($1,$2,$3,'ai_visibility',$4,$5,$6,$7)`,
    [
      domain,
      domain,
      capturedAt.toISOString(),
      JSON.stringify(raw),
      mentionsTotal,
      JSON.stringify(mentionsByEngine),
      JSON.stringify(topCompetitors),
    ]
  );
};

/**
 * Get-or-refresh the Ahrefs Brand-Radar AI-visibility stats for a domain.
 *
 * Returns the cached snapshot when fresh (< TTL); otherwise scrapes via Apify
 * under the strict cost order (PROVISION → AUTHORIZE → EXECUTE → ACTUALIZE /
 * CANCEL), resolves competitor brand identities, persists, and returns. Every
 * step is fail-loud — any scrape / brand-service failure propagates (→ 502),
 * so an upstream failure is distinguishable from a true zero-mention result.
 */
export const getOrComputeAiVisibility = async (
  pool: Pool,
  domainInput: string,
  ctx: OrgContext
): Promise<AiVisibilityResponse> => {
  // Throws on an unusable domain (→ 400 at the route).
  const domain = normalizeDomain(domainInput);

  const cached = await readLatest(pool, domain);
  if (cached && isFresh(cached.data_captured_at)) {
    return {
      domain,
      snapshotDate: snapshotDateOf(cached.data_captured_at),
      fetchedFromCache: true,
      mentionsTotal: cached.ai_mentions_total ?? 0,
      mentionsByEngine: cached.ai_mentions_by_engine ?? [],
      topCompetitors: cached.ai_top_competitors ?? [],
      raw: cached.raw_data ?? {},
    };
  }

  const runId = await createChildRun("ai-visibility", ctx);
  let provisionCostId: string | null = null;

  try {
    // 1. PROVISION — one Apify result per call.
    provisionCostId = await addCost(
      runId,
      {
        costName: COST_NAME,
        costSource: "org",
        quantity: 1,
        status: "provisioned",
        idempotencyKey: `ahref:ai-visibility:${runId}:provision`,
      },
      ctx
    );

    // 2. AUTHORIZE — Apify is a platform key, so the org's balance must cover it.
    await authorize(
      [{ costName: COST_NAME, quantity: 1 }],
      `ahref-service AI-visibility scrape (${domain})`,
      runId,
      ctx
    );

    // 3. EXECUTE — resolve the platform Apify key, scrape, resolve competitors.
    const apifyToken = await getPlatformKey(APIFY_PROVIDER, CALLER);
    const { result, chargedResults } = await runAiVisibilityScrape(apifyToken, domain);

    const mentionsByEngine = result.citationsByModel.map((m) => ({
      engine: toEngineKey(m.model),
      mentions: m.count,
    }));
    const topCompetitors = await resolveTopCompetitors(result);

    const capturedAt = new Date();
    await insertSnapshot(
      pool,
      domain,
      capturedAt,
      result.mentionsTotal,
      mentionsByEngine,
      topCompetitors,
      result.raw
    );

    // 4. ACTUALIZE — bill the real charged result count, cancel the hold.
    await addCost(
      runId,
      {
        costName: COST_NAME,
        costSource: "org",
        quantity: chargedResults > 0 ? chargedResults : 1,
        status: "actual",
        idempotencyKey: `ahref:ai-visibility:${runId}:actual`,
      },
      ctx
    );
    await setCostStatus(runId, provisionCostId, "cancelled", ctx);
    await closeRun(runId, "completed", ctx);

    return {
      domain,
      snapshotDate: snapshotDateOf(capturedAt),
      fetchedFromCache: false,
      mentionsTotal: result.mentionsTotal,
      mentionsByEngine,
      topCompetitors,
      raw: result.raw,
    };
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

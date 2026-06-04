/**
 * Apify client for the Ahrefs scrape. Actor: pro100chok/ahrefs-seo-tools
 * (id pC8gsptNv2RwJm0QE), PAY_PER_EVENT ($0.005/result). We only request the
 * `website_authority` search type for now (DR + backlink/refdomain counts);
 * traffic / AI-visibility are additional searchTypes priced the same per result
 * and can be added later under the same cost name.
 */

const APIFY_BASE_URL = "https://api.apify.com";
const ACTOR_ID = "pC8gsptNv2RwJm0QE";
const RESULT_EVENT = "apify-default-dataset-item";

const START_WAIT_SECS = 60; // Apify caps waitForFinish at 60s per call.
const POLL_INTERVAL_MS = 4_000;
const MAX_WAIT_MS = 180_000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ApifyDrResult {
  domain: string;
  mode?: string;
  domainRating: number | null;
  backlinks: number | null;
  refdomains: number | null;
  dofollowBacklinks: number | null;
  dofollowRefdomains: number | null;
  raw: Record<string, unknown>;
}

export interface ApifyDrRun {
  results: ApifyDrResult[];
  /** Number of billable result events Apify charged (for cost actualization). */
  chargedResults: number;
}

interface ApifyRunData {
  id: string;
  status: string;
  defaultDatasetId: string;
  chargedEventCounts?: Record<string, number>;
}

const apifyFetch = async (
  url: string,
  token: string,
  init?: { method?: string; body?: unknown }
): Promise<unknown> => {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new Error(
      `[ahref-service] Apify request ${url} fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[ahref-service] Apify request ${url} failed (${res.status}): ${text}`);
  }
  return res.json();
};

const toNullableInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

interface ApifyRunOutcome {
  items: Array<Record<string, unknown>>;
  /** Number of billable result events Apify charged (for cost actualization). */
  chargedResults: number;
}

/**
 * Run the Ahrefs actor with the given input body and block until it finishes
 * (synchronous compute). Throws on any non-success run status — fail-loud, no
 * partial/silent success. Shared by every searchType (DR, traffic, ...); only
 * the input body and the per-result mapping differ.
 */
const runActorScrape = async (
  token: string,
  body: Record<string, unknown>
): Promise<ApifyRunOutcome> => {
  const startResp = (await apifyFetch(
    `${APIFY_BASE_URL}/v2/acts/${ACTOR_ID}/runs?waitForFinish=${START_WAIT_SECS}`,
    token,
    { method: "POST", body }
  )) as { data: ApifyRunData };

  let run = startResp.data;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (!TERMINAL.has(run.status)) {
    if (Date.now() > deadline) {
      throw new Error(`[ahref-service] Apify run ${run.id} did not finish within ${MAX_WAIT_MS}ms`);
    }
    await sleep(POLL_INTERVAL_MS);
    const polled = (await apifyFetch(
      `${APIFY_BASE_URL}/v2/acts/${ACTOR_ID}/runs/${run.id}`,
      token
    )) as { data: ApifyRunData };
    run = polled.data;
  }

  if (run.status !== "SUCCEEDED") {
    throw new Error(`[ahref-service] Apify run ${run.id} ended with status ${run.status}`);
  }

  const items = (await apifyFetch(
    `${APIFY_BASE_URL}/v2/datasets/${run.defaultDatasetId}/items?clean=true`,
    token
  )) as Array<Record<string, unknown>>;

  const chargedResults = run.chargedEventCounts?.[RESULT_EVENT] ?? items.length;

  return { items, chargedResults };
};

/**
 * Scrape domain authority (DR) for the given normalized domains.
 */
export const runDrScrape = async (token: string, domains: string[]): Promise<ApifyDrRun> => {
  const { items, chargedResults } = await runActorScrape(token, {
    searchType: "website_authority",
    urls: domains,
    mode: "domain",
  });

  const results: ApifyDrResult[] = items.map((it) => ({
    domain: String(it.domain ?? ""),
    mode: typeof it.mode === "string" ? it.mode : undefined,
    domainRating: toNullableInt(it.domainRating),
    backlinks: toNullableInt(it.backlinks),
    refdomains: toNullableInt(it.refdomains),
    dofollowBacklinks: toNullableInt(it.dofollowBacklinks),
    dofollowRefdomains: toNullableInt(it.dofollowRefdomains),
    raw: it,
  }));

  return { results, chargedResults };
};

export interface ApifyTrafficHistoryPoint {
  date: string;
  organic: number | null;
}

export interface ApifyTrafficResult {
  domain: string;
  mode?: string;
  /** Current monthly organic-traffic estimate. */
  trafficMonthlyAvg: number | null;
  /** Current monthly organic-traffic value ($, Ahrefs units). No history. */
  costMonthlyAvg: number | null;
  /** Month-by-month organic-traffic series ([{date, organic}]). */
  trafficHistory: ApifyTrafficHistoryPoint[] | null;
  topPages: unknown;
  topCountries: unknown;
  topKeywords: unknown;
  raw: Record<string, unknown>;
}

export interface ApifyTrafficRun {
  results: ApifyTrafficResult[];
  chargedResults: number;
}

const toNullableBigint = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

/**
 * Scrape the traffic overview (monthly organic traffic + value + history + top
 * pages/keywords/countries) for the given normalized domains.
 */
export const runTrafficScrape = async (
  token: string,
  domains: string[]
): Promise<ApifyTrafficRun> => {
  const { items, chargedResults } = await runActorScrape(token, {
    searchType: "traffic_overview",
    urls: domains,
    mode: "domain",
  });

  const results: ApifyTrafficResult[] = items.map((it) => ({
    domain: String(it.domain ?? ""),
    mode: typeof it.mode === "string" ? it.mode : undefined,
    trafficMonthlyAvg: toNullableBigint(it.trafficMonthlyAvg),
    costMonthlyAvg: toNullableBigint(it.costMonthlyAvg),
    trafficHistory: Array.isArray(it.trafficHistory)
      ? (it.trafficHistory as ApifyTrafficHistoryPoint[])
      : null,
    topPages: it.topPages ?? null,
    topCountries: it.topCountries ?? null,
    topKeywords: it.topKeywords ?? null,
    raw: it,
  }));

  return { results, chargedResults };
};

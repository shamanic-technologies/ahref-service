import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

// Downstream config is read lazily at request time — set before any request.
process.env.RUNS_SERVICE_URL = "http://runs.test";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.BILLING_SERVICE_URL = "http://billing.test";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.KEY_SERVICE_URL = "http://key.test";
process.env.KEY_SERVICE_API_KEY = "key-key";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "brand-key";

import { createApp } from "../src/app";
import { setMockResult, clearMocks } from "./setup";
import { toEngineKey } from "../src/services/ai-visibility";

const API_KEY = "test-api-key";
const app = createApp({ apiKey: API_KEY });

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VIEW = "v_domains_ai_visibility_latest";

const withOrg = (req: request.Test) =>
  req.set("x-api-key", API_KEY).set("x-org-id", ORG_ID).set("x-run-id", RUN_ID);

interface Call {
  method: string;
  url: string;
}
let calls: Call[];

interface Overrides {
  authorizeSufficient?: boolean;
  provisionStatus?: number;
  keyStatus?: number;
  apifyRunStatus?: string;
  datasetItems?: Array<Record<string, unknown>>;
  brandStatus?: number;
  brandsResponse?: Array<{ brandId: string; domain: string | null; name: string | null }>;
}
let overrides: Overrides;

const makeRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const defaultItem = (): Record<string, unknown> => ({
  searchType: "ai_visibility",
  brand: "example.com",
  totalAiCitations: 1234,
  citationsByModel: [
    { model: "Chatgpt", count: 800 },
    { model: "GoogleAIOverviews", count: 434 },
  ],
  topCitedDomains: [
    { domain: "acme.com", mentions: 512 },
    { domain: "backlinko.com", mentions: 100 },
  ],
});

const defaultBrands = () => [
  { brandId: "brand-acme", domain: "acme.com", name: "Acme" },
  { brandId: "brand-back", domain: "backlinko.com", name: "Backlinko" },
];

beforeEach(() => {
  clearMocks();
  calls = [];
  overrides = {};

  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });

    // Apify
    if (url.includes("api.apify.com")) {
      if (url.includes("/datasets/")) {
        return makeRes(200, overrides.datasetItems ?? [defaultItem()]);
      }
      return makeRes(201, {
        data: {
          id: "apify-run-1",
          status: overrides.apifyRunStatus ?? "SUCCEEDED",
          defaultDatasetId: "ds-1",
          chargedEventCounts: { "apify-default-dataset-item": 1 },
        },
      });
    }

    // brand-service resolve-by-domain
    if (url.includes("/internal/brands/resolve-by-domain")) {
      if (overrides.brandStatus && overrides.brandStatus >= 400) {
        return makeRes(overrides.brandStatus, { error: "brand-service boom" });
      }
      return makeRes(200, { brands: overrides.brandsResponse ?? defaultBrands() });
    }

    // billing authorize
    if (url.includes("customer_balance/authorize")) {
      return makeRes(200, {
        sufficient: overrides.authorizeSufficient ?? true,
        balance_cents: "100000",
        required_cents: "50",
      });
    }

    // key-service platform decrypt
    if (url.includes("/keys/platform/")) {
      if (overrides.keyStatus && overrides.keyStatus >= 400) {
        return makeRes(overrides.keyStatus, { error: "platform key not found" });
      }
      return makeRes(200, { provider: "apify", key: "apify-token-xyz" });
    }

    // runs-service cost PATCH (status update) — must precede the run PATCH check
    if (url.includes("/costs/") && method === "PATCH") {
      return makeRes(200, {});
    }
    // runs-service cost POST (provision / actual)
    if (url.endsWith("/costs") && method === "POST") {
      if (overrides.provisionStatus && overrides.provisionStatus >= 400) {
        return makeRes(overrides.provisionStatus, { error: "Unknown cost name" });
      }
      return makeRes(201, { costs: [{ id: "cost-1" }] });
    }
    // runs-service close run PATCH
    if (/\/v1\/runs\/[^/]+$/.test(url) && method === "PATCH") {
      return makeRes(200, {});
    }
    // runs-service create run POST
    if (url.endsWith("/v1/runs") && method === "POST") {
      return makeRes(201, { id: "own-run-1" });
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const idxOf = (pred: (c: Call) => boolean) => calls.findIndex(pred);
const apifyRunCall = (c: Call) =>
  c.url.includes("api.apify.com") && !c.url.includes("/datasets/");
const provisionCall = (c: Call) => c.url.endsWith("/costs") && c.method === "POST";
const authorizeCall = (c: Call) => c.url.includes("customer_balance/authorize");
const brandResolveCall = (c: Call) => c.url.includes("/internal/brands/resolve-by-domain");

const freshRow = (overrides: Record<string, unknown> = {}) => ({
  data_captured_at: new Date(),
  ai_mentions_total: 999,
  ai_mentions_by_engine: [{ engine: "chatgpt", mentions: 999 }],
  ai_top_competitors: [
    { brandId: "cached-brand", brand: "Cached", domain: "cached.com", citations: 42 },
  ],
  raw_data: { cached: true },
  ...overrides,
});

describe("toEngineKey", () => {
  it("maps actor model names to lower-snake-case stable keys", () => {
    expect(toEngineKey("Chatgpt")).toBe("chatgpt");
    expect(toEngineKey("Gemini")).toBe("gemini");
    expect(toEngineKey("Perplexity")).toBe("perplexity");
    expect(toEngineKey("Copilot")).toBe("copilot");
    expect(toEngineKey("GoogleAIOverviews")).toBe("google_ai_overviews");
    expect(toEngineKey("GoogleAIMode")).toBe("google_ai_mode");
  });
});

describe("POST /orgs/domains/ai-visibility", () => {
  it("400 when domain is missing", async () => {
    const res = await withOrg(request(app).post("/orgs/domains/ai-visibility").send({}));
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it("400 for an invalid domain", async () => {
    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "not a domain" })
    );
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it("cache hit (fresh): returns cached, no scrape / cost / brand calls", async () => {
    setMockResult(VIEW, [freshRow()]);

    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );

    expect(res.status).toBe(200);
    expect(res.body.fetchedFromCache).toBe(true);
    expect(res.body.domain).toBe("example.com");
    expect(res.body.mentionsTotal).toBe(999);
    expect(res.body.mentionsByEngine).toEqual([{ engine: "chatgpt", mentions: 999 }]);
    expect(res.body.topCompetitors[0].brandId).toBe("cached-brand");
    expect(res.body.raw).toEqual({ cached: true });
    // No external calls at all on a cache hit.
    expect(calls.length).toBe(0);
  });

  it("cache miss: scrapes, resolves competitors, persists, returns fresh", async () => {
    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );

    expect(res.status).toBe(200);
    expect(res.body.fetchedFromCache).toBe(false);
    expect(res.body.mentionsTotal).toBe(1234);
    expect(res.body.mentionsByEngine).toEqual([
      { engine: "chatgpt", mentions: 800 },
      { engine: "google_ai_overviews", mentions: 434 },
    ]);
    expect(res.body.topCompetitors).toEqual([
      { brandId: "brand-acme", brand: "Acme", domain: "acme.com", citations: 512 },
      { brandId: "brand-back", brand: "Backlinko", domain: "backlinko.com", citations: 100 },
    ]);
    expect(res.body.raw.searchType).toBe("ai_visibility");

    // Full cost lifecycle + brand resolve ran.
    expect(idxOf((c) => c.url.endsWith("/v1/runs") && c.method === "POST")).toBeGreaterThanOrEqual(0);
    expect(idxOf((c) => c.url.includes("/keys/platform/"))).toBeGreaterThanOrEqual(0);
    expect(idxOf(apifyRunCall)).toBeGreaterThanOrEqual(0);
    expect(idxOf(brandResolveCall)).toBeGreaterThanOrEqual(0);
    expect(calls.filter(provisionCall).length).toBe(2); // provision + actual
    expect(idxOf((c) => c.url.includes("/costs/") && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
  });

  it("stale cache triggers a fresh scrape", async () => {
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days > 6d TTL
    setMockResult(VIEW, [freshRow({ data_captured_at: old })]);

    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );

    expect(res.status).toBe(200);
    expect(res.body.fetchedFromCache).toBe(false);
    expect(idxOf(apifyRunCall)).toBeGreaterThanOrEqual(0);
  });

  it("declares cost in order: PROVISION → AUTHORIZE → EXECUTE(apify)", async () => {
    await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );
    const provisionIdx = idxOf(provisionCall);
    const authorizeIdx = idxOf(authorizeCall);
    const apifyIdx = idxOf(apifyRunCall);
    expect(provisionIdx).toBeGreaterThanOrEqual(0);
    expect(provisionIdx).toBeLessThan(authorizeIdx);
    expect(authorizeIdx).toBeLessThan(apifyIdx);
  });

  it("true zero (0 citations) returns 200 — distinguishable from failure", async () => {
    overrides.datasetItems = [
      {
        searchType: "ai_visibility",
        brand: "example.com",
        totalAiCitations: 0,
        citationsByModel: [],
        topCitedDomains: [],
      },
    ];

    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );

    expect(res.status).toBe(200);
    expect(res.body.mentionsTotal).toBe(0);
    expect(res.body.mentionsByEngine).toEqual([]);
    expect(res.body.topCompetitors).toEqual([]);
    // No brand resolve when there are no competitors.
    expect(idxOf(brandResolveCall)).toBe(-1);
  });

  it("excludes competitors brand-service does not resolve", async () => {
    overrides.brandsResponse = [{ brandId: "brand-acme", domain: "acme.com", name: "Acme" }];

    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );

    expect(res.status).toBe(200);
    expect(res.body.topCompetitors).toEqual([
      { brandId: "brand-acme", brand: "Acme", domain: "acme.com", citations: 512 },
    ]);
  });

  it("snapshotDate reflects the extraction date", async () => {
    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );
    expect(res.status).toBe(200);
    expect(res.body.snapshotDate).toBe(new Date().toISOString().slice(0, 10));
  });

  it("502 when authorize is insufficient — no Apify call, hold cancelled", async () => {
    overrides.authorizeSufficient = false;
    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );
    expect(res.status).toBe(502);
    expect(idxOf(apifyRunCall)).toBe(-1);
    expect(idxOf((c) => c.url.includes("/costs/") && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
  });

  it("502 when provision fails (422 unknown cost) — no authorize, no Apify", async () => {
    overrides.provisionStatus = 422;
    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );
    expect(res.status).toBe(502);
    expect(idxOf(authorizeCall)).toBe(-1);
    expect(idxOf(apifyRunCall)).toBe(-1);
  });

  it("502 when the Apify run fails — hold cancelled, run closed failed", async () => {
    overrides.apifyRunStatus = "FAILED";
    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );
    expect(res.status).toBe(502);
    expect(idxOf((c) => c.url.includes("/costs/") && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
  });

  it("502 when the platform Apify key is missing (404) — no Apify run", async () => {
    overrides.keyStatus = 404;
    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );
    expect(res.status).toBe(502);
    expect(idxOf(apifyRunCall)).toBe(-1);
  });

  it("502 when brand-service fails (5xx) — fail loud, run closed failed", async () => {
    overrides.brandStatus = 500;
    const res = await withOrg(
      request(app).post("/orgs/domains/ai-visibility").send({ domain: "example.com" })
    );
    expect(res.status).toBe(502);
    // Scrape happened, brand resolve was attempted, then it failed loud.
    expect(idxOf(apifyRunCall)).toBeGreaterThanOrEqual(0);
    expect(idxOf(brandResolveCall)).toBeGreaterThanOrEqual(0);
  });
});

const cachedRow = (overrides: Record<string, unknown> = {}) => ({
  domain: "example.com",
  data_captured_at: new Date(),
  ai_mentions_total: 555,
  ai_mentions_by_engine: [{ engine: "chatgpt", mentions: 555 }],
  ai_top_competitors: [
    { brandId: "cached-brand", brand: "Cached", domain: "cached.com", citations: 42 },
  ],
  ...overrides,
});

describe("GET /orgs/domains/ai-visibility (read-only cache)", () => {
  it("cache hit: returns lean snapshot, zero side effects (no scrape/cost/brand)", async () => {
    setMockResult(VIEW, [cachedRow()]);

    const res = await withOrg(
      request(app).get("/orgs/domains/ai-visibility?domains=example.com")
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    const el = res.body[0];
    expect(el.domain).toBe("example.com");
    expect(el.snapshotDate).toBe(new Date().toISOString().slice(0, 10));
    expect(el.mentionsTotal).toBe(555);
    expect(el.mentionsByEngine).toEqual([{ engine: "chatgpt", mentions: 555 }]);
    expect(el.topCompetitors[0].brandId).toBe("cached-brand");
    // Lean shape: scrape-only fields are dropped.
    expect(el).not.toHaveProperty("fetchedFromCache");
    expect(el).not.toHaveProperty("raw");
    // Pure read — NO scrape / cost / authorize / brand-resolve HTTP at all.
    expect(calls.length).toBe(0);
  });

  it("uncached domain: absent-shaped element, no scrape, 200 (not 404)", async () => {
    // No mock row set → the view returns no rows for this domain.
    const res = await withOrg(
      request(app).get("/orgs/domains/ai-visibility?domains=never-seen.com")
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        domain: "never-seen.com",
        snapshotDate: null,
        mentionsTotal: 0,
        mentionsByEngine: [],
        topCompetitors: [],
      },
    ]);
    expect(calls.length).toBe(0);
  });

  it("stale snapshot is still returned (no freshness gate, no scrape)", async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30d ≫ 6d POST TTL
    setMockResult(VIEW, [cachedRow({ data_captured_at: old })]);

    const res = await withOrg(
      request(app).get("/orgs/domains/ai-visibility?domains=example.com")
    );

    expect(res.status).toBe(200);
    expect(res.body[0].snapshotDate).toBe(old.toISOString().slice(0, 10));
    expect(res.body[0].mentionsTotal).toBe(555);
    // A stale snapshot must NOT trigger a refresh on the read path.
    expect(calls.length).toBe(0);
  });

  it("multi-domain csv → array preserving order, mix of cached + absent", async () => {
    setMockResult(VIEW, [cachedRow({ domain: "example.com" })]);

    const res = await withOrg(
      request(app).get("/orgs/domains/ai-visibility?domains=example.com,unseen.com")
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].domain).toBe("example.com");
    expect(res.body[0].mentionsTotal).toBe(555);
    expect(res.body[1].domain).toBe("unseen.com");
    expect(res.body[1].snapshotDate).toBeNull();
    expect(res.body[1].mentionsTotal).toBe(0);
    expect(res.body[1].mentionsByEngine).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("400 when the domains query param is missing", async () => {
    const res = await withOrg(request(app).get("/orgs/domains/ai-visibility"));
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it("normalizes + dedupes www/casing to a single key", async () => {
    setMockResult(VIEW, [cachedRow({ domain: "example.com" })]);

    const res = await withOrg(
      request(app).get(
        "/orgs/domains/ai-visibility?domains=Example.com,www.example.com"
      )
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].domain).toBe("example.com");
    expect(calls.length).toBe(0);
  });
});

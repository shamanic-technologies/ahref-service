import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

// Downstream service config is read lazily by the clients at request time, so
// set it before any request is handled.
process.env.RUNS_SERVICE_URL = "http://runs.test";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.BILLING_SERVICE_URL = "http://billing.test";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.KEY_SERVICE_URL = "http://key.test";
process.env.KEY_SERVICE_API_KEY = "key-key";

import { createApp } from "../src/app";
import {
  setMockResult,
  clearMocks,
  getMockPool,
  getInsertApifyId,
  getMetricJobs,
} from "./setup";
import {
  resetDomainMetricWorkersForTest,
  setDomainMetricWorkerAutoStartForTest,
  waitForDomainMetricWorkersForTest,
} from "../src/services/domain-metric-jobs";

const API_KEY = "test-api-key";
const app = createApp({ apiKey: API_KEY });

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LATEST_VIEW = "v_domain_traffic_latest";
const MONTHLY_TABLE = "domain_traffic_monthly";

const withOrg = (req: request.Test) =>
  req.set("x-api-key", API_KEY).set("x-org-id", ORG_ID).set("x-run-id", RUN_ID);
const internal = (req: request.Test) => req.set("x-api-key", API_KEY);

// Two-month organic history, mirrors the real traffic_overview output shape.
const TRAFFIC_HISTORY = [
  { date: "2026-01-01", organic: 5820145 },
  { date: "2026-02-01", organic: 4505125 },
];

const snapshotRow = (domain: string) => ({
  domain,
  data_captured_at: new Date("2026-06-04T00:00:00Z"),
  traffic_monthly_avg: 4274823,
  traffic_value_monthly_avg: 625363650,
  top_pages: [{ url: "https://example.com/blog", traffic: 266617, share: 11.35 }],
  top_countries: [{ country: "US", share: 54.29 }],
  top_keywords: [{ keyword: "example", position: 2, traffic: 546000 }],
});

const monthlyRows = (domain: string) =>
  TRAFFIC_HISTORY.map((p) => ({
    domain,
    month: p.date,
    organic_traffic: p.organic,
  }));

interface Call {
  method: string;
  url: string;
  body?: unknown;
}
let calls: Call[];

interface Overrides {
  authorizeSufficient?: boolean;
  apifyRunStatus?: string | (() => string);
}
let overrides: Overrides;

const makeRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

beforeEach(() => {
  clearMocks();
  calls = [];
  overrides = {};

  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });

    // Apify
    if (url.includes("api.apify.com")) {
      if (url.includes("/datasets/")) {
        return makeRes(200, [
          {
            searchType: "traffic_overview",
            domain: "example.com",
            mode: "domain",
            trafficMonthlyAvg: 4274823,
            costMonthlyAvg: 625363650,
            trafficHistory: TRAFFIC_HISTORY,
            topPages: [{ url: "https://example.com/blog", traffic: 266617, share: 11.35 }],
            topCountries: [{ country: "US", share: 54.29 }],
            topKeywords: [{ keyword: "example", position: 2, traffic: 546000 }],
          },
        ]);
      }
      return makeRes(201, {
        data: {
          id: "apify-run-1",
          status:
            typeof overrides.apifyRunStatus === "function"
              ? overrides.apifyRunStatus()
              : overrides.apifyRunStatus ?? "SUCCEEDED",
          defaultDatasetId: "ds-1",
          chargedEventCounts: { "apify-default-dataset-item": 1 },
        },
      });
    }

    if (url.includes("customer_balance/authorize")) {
      return makeRes(200, {
        sufficient: overrides.authorizeSufficient ?? true,
        balance_cents: "100000",
        required_cents: "50",
      });
    }

    if (url.includes("/keys/platform/")) {
      return makeRes(200, { provider: "apify", key: "apify-token-xyz" });
    }

    if (url.includes("/costs/") && method === "PATCH") return makeRes(200, {});
    if (url.endsWith("/costs") && method === "POST") return makeRes(201, { costs: [{ id: "cost-1" }] });
    if (/\/v1\/runs\/[^/]+$/.test(url) && method === "PATCH") return makeRes(200, {});
    if (url.endsWith("/v1/runs") && method === "POST") return makeRes(201, { id: "own-run-1" });

    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  resetDomainMetricWorkersForTest();
  vi.restoreAllMocks();
});

const idxOf = (pred: (c: Call) => boolean) => calls.findIndex(pred);
const apifyRunCall = (c: Call) => c.url.includes("api.apify.com") && !c.url.includes("/datasets/");
const provisionCall = (c: Call) => c.url.endsWith("/costs") && c.method === "POST";
const authorizeCall = (c: Call) => c.url.includes("customer_balance/authorize");
const queryTexts = () => getMockPool().query.mock.calls.map((c: unknown[]) => c[0] as string);

describe("POST /orgs/domains/traffic-compute", () => {
  it("400 when domains is missing", async () => {
    const res = await withOrg(request(app).post("/orgs/domains/traffic-compute").send({}));
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it("returns existing traffic without queuing vendor work", async () => {
    setMockResult(LATEST_VIEW, [snapshotRow("example.com")]);
    setMockResult(MONTHLY_TABLE, monthlyRows("example.com"));

    const res = await withOrg(
      request(app).post("/orgs/domains/traffic-compute").send({ domains: ["example.com"] })
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].domain).toBe("example.com");
    expect(res.body[0].hasData).toBe(true);
    expect(res.body[0].trafficMonthlyAvg).toBe(4274823);
    expect(res.body[0].trafficValueMonthlyAvg).toBe(625363650);
    expect(res.body[0].monthlyOrganicTraffic).toEqual([
      { month: "2026-01-01", organicTraffic: 5820145 },
      { month: "2026-02-01", organicTraffic: 4505125 },
    ]);
    expect(getMetricJobs()).toHaveLength(0);
    expect(idxOf(apifyRunCall)).toBe(-1);
  });

  it("queues missing traffic and returns promptly with the current read shape", async () => {
    setDomainMetricWorkerAutoStartForTest(false);

    const res = await withOrg(
      request(app).post("/orgs/domains/traffic-compute").send({ domains: ["example.com"] })
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        domain: "example.com",
        hasData: false,
        latestDataCapturedAt: null,
        trafficMonthlyAvg: null,
        trafficValueMonthlyAvg: null,
        topPages: null,
        topCountries: null,
        topKeywords: null,
        monthlyOrganicTraffic: [],
        trafficImplausible: false,
        trafficImplausibleReason: null,
      },
    ]);
    expect(getMetricJobs()).toHaveLength(1);
    expect(idxOf(apifyRunCall)).toBe(-1);
  });

  it("returns promptly without entering Apify when the underlying run would exceed the old 180s wait window", async () => {
    setDomainMetricWorkerAutoStartForTest(false);
    overrides.apifyRunStatus = "RUNNING";

    const res = await withOrg(
      request(app).post("/orgs/domains/traffic-compute").send({ domains: ["example.com"] })
    );

    expect(res.status).toBe(200);
    expect(res.body[0].hasData).toBe(false);
    expect(getMetricJobs()[0].status).toBe("pending");
    expect(idxOf(apifyRunCall)).toBe(-1);
  });

  it("coalesces repeated missing traffic requests for the same org/domain", async () => {
    setDomainMetricWorkerAutoStartForTest(false);

    await withOrg(
      request(app).post("/orgs/domains/traffic-compute").send({ domains: ["Example.com"] })
    );
    await withOrg(
      request(app).post("/orgs/domains/traffic-compute").send({ domains: ["www.example.com"] })
    );

    expect(getMetricJobs()).toHaveLength(1);
    expect(getMetricJobs()[0]).toMatchObject({
      org_id: ORG_ID,
      metric: "traffic",
      domain: "example.com",
      status: "pending",
    });
    expect(idxOf(apifyRunCall)).toBe(-1);
  });

  it("background worker scrapes traffic_overview, persists, and promotes silver", async () => {
    const res = await withOrg(
      request(app).post("/orgs/domains/traffic-compute").send({ domains: ["example.com"] })
    );
    await waitForDomainMetricWorkersForTest();

    expect(res.status).toBe(200);
    expect(getMetricJobs()[0].status).toBe("succeeded");

    // The actor was driven with the traffic_overview search type, scoped to
    // SUBDOMAINS so a www-canonical apex (wsj.com→www.wsj.com) is captured.
    const apifyRun = calls.find(apifyRunCall);
    expect((apifyRun!.body as { searchType: string }).searchType).toBe("traffic_overview");
    expect((apifyRun!.body as { mode: string }).mode).toBe("subdomains");

    // Full cost lifecycle ran.
    expect(idxOf((c) => c.url.endsWith("/v1/runs") && c.method === "POST")).toBeGreaterThanOrEqual(0);
    expect(idxOf((c) => c.url.includes("/keys/platform/"))).toBeGreaterThanOrEqual(0);
    expect(calls.filter(provisionCall).length).toBe(2); // provision + actual
    expect(idxOf((c) => c.url.includes("/costs/") && c.method === "PATCH")).toBeGreaterThanOrEqual(0);

    // Bronze + silver were written.
    expect(queryTexts().some((t) => t.includes("INSERT INTO apify_ahref"))).toBe(true);
    expect(queryTexts().some((t) => t.includes("INSERT INTO domain_traffic_snapshot"))).toBe(true);
    expect(queryTexts().filter((t) => t.includes("INSERT INTO domain_traffic_monthly")).length).toBe(2);
  });

  it("declares background cost in order: PROVISION → AUTHORIZE → EXECUTE(apify)", async () => {
    const res = await withOrg(
      request(app).post("/orgs/domains/traffic-compute").send({ domains: ["example.com"] })
    );
    await waitForDomainMetricWorkersForTest();

    expect(res.status).toBe(200);
    const provisionIdx = idxOf(provisionCall);
    const authorizeIdx = idxOf(authorizeCall);
    const apifyIdx = idxOf(apifyRunCall);
    expect(provisionIdx).toBeGreaterThanOrEqual(0);
    expect(provisionIdx).toBeLessThan(authorizeIdx);
    expect(authorizeIdx).toBeLessThan(apifyIdx);
  });

  it("does not fail the caller when background authorize is insufficient", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    overrides.authorizeSufficient = false;

    const res = await withOrg(
      request(app).post("/orgs/domains/traffic-compute").send({ domains: ["example.com"] })
    );
    await waitForDomainMetricWorkersForTest();

    expect(res.status).toBe(200);
    expect(getMetricJobs()[0].status).toBe("failed");
    expect(errorSpy).toHaveBeenCalled();
    expect(idxOf(apifyRunCall)).toBe(-1);
    expect(idxOf((c) => c.url.includes("/costs/") && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
  });

  it("does not fail the caller when the background Apify run fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    overrides.apifyRunStatus = "FAILED";

    const res = await withOrg(
      request(app).post("/orgs/domains/traffic-compute").send({ domains: ["example.com"] })
    );
    await waitForDomainMetricWorkersForTest();

    expect(res.status).toBe(200);
    expect(getMetricJobs()[0].status).toBe("failed");
    expect(errorSpy).toHaveBeenCalled();
    expect(idxOf((c) => c.url.includes("/costs/") && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
    expect(idxOf((c) => /\/v1\/runs\/[^/]+$/.test(c.url) && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
  });
});

describe("POST /internal/domains/domain-rating (traffic → silver promotion)", () => {
  beforeEach(() => clearMocks());

  it("promotes a traffic ingest into snapshot + one monthly row per history point", async () => {
    const res = await internal(
      request(app)
        .post("/internal/domains/domain-rating")
        .send({
          domain: "example.com",
          dataType: "traffic",
          dataCapturedAt: "2026-06-04T00:00:00Z",
          rawData: { searchType: "traffic_overview" },
          trafficMonthlyAvg: 4274823,
          costMonthlyAvg: 625363650,
          trafficHistory: TRAFFIC_HISTORY,
          trafficTopPages: [{ url: "https://example.com/blog", traffic: 266617 }],
        })
    );
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(getInsertApifyId());

    const texts = queryTexts();
    expect(texts.some((t) => t.includes("INSERT INTO apify_ahref"))).toBe(true);
    expect(texts.some((t) => t.includes("INSERT INTO domain_traffic_snapshot"))).toBe(true);
    expect(texts.filter((t) => t.includes("INSERT INTO domain_traffic_monthly")).length).toBe(2);
  });

  it("does NOT promote silver for an authority ingest", async () => {
    const res = await internal(
      request(app)
        .post("/internal/domains/domain-rating")
        .send({
          domain: "example.com",
          dataType: "authority",
          dataCapturedAt: "2026-06-04T00:00:00Z",
          rawData: { dr: 45 },
          authorityDomainRating: 45,
        })
    );
    expect(res.status).toBe(201);
    const texts = queryTexts();
    expect(texts.some((t) => t.includes("domain_traffic_snapshot"))).toBe(false);
    expect(texts.some((t) => t.includes("domain_traffic_monthly"))).toBe(false);
  });
});

describe("traffic plausibility guard (silver promotion)", () => {
  beforeEach(() => clearMocks());

  const DR_QUERY_KEY = "authority_domain_rating IS NOT NULL";
  const snapshotInsertCall = () =>
    getMockPool().query.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("INSERT INTO domain_traffic_snapshot")
    );
  const monthlyInserts = () =>
    queryTexts().filter((t) => t.includes("INSERT INTO domain_traffic_monthly"));

  it("flags a positive figure with no ranking-page evidence and skips the monthly series", async () => {
    const res = await internal(
      request(app)
        .post("/internal/domains/domain-rating")
        .send({
          domain: "ft.com",
          dataType: "traffic",
          dataCapturedAt: "2026-06-09T00:00:00Z",
          rawData: { searchType: "traffic_overview" },
          trafficMonthlyAvg: 196,
          costMonthlyAvg: 4710,
          trafficHistory: TRAFFIC_HISTORY,
          trafficTopPages: [],
        })
    );
    expect(res.status).toBe(201);

    const insert = snapshotInsertCall();
    const values = insert![1] as unknown[];
    expect(values[8]).toBe(true); // traffic_implausible
    expect(String(values[9])).toContain("no ranking-page evidence");
    // Wrong-scope months are NOT promoted into silver.
    expect(monthlyInserts()).toHaveLength(0);
  });

  it("flags organic traffic incoherent with a high domain authority (DR cross-check)", async () => {
    // wsj.com signature: DR 92 but only 4,802 monthly organic, with non-empty
    // top pages (so only the authority rule can catch it).
    setMockResult(DR_QUERY_KEY, [{ authority_domain_rating: 92 }]);

    const res = await internal(
      request(app)
        .post("/internal/domains/domain-rating")
        .send({
          domain: "wsj.com",
          dataType: "traffic",
          dataCapturedAt: "2026-06-09T00:00:00Z",
          rawData: { searchType: "traffic_overview" },
          trafficMonthlyAvg: 4802,
          costMonthlyAvg: 921818,
          trafficHistory: TRAFFIC_HISTORY,
          trafficTopPages: [{ url: "https://wsj.com/subscribe", traffic: 4174, share: 91.4 }],
        })
    );
    expect(res.status).toBe(201);

    const values = snapshotInsertCall()![1] as unknown[];
    expect(values[8]).toBe(true);
    expect(String(values[9])).toContain("DR 92");
    expect(monthlyInserts()).toHaveLength(0);
  });

  it("stores a real high-traffic scrape as plausible (DR known, traffic coherent)", async () => {
    setMockResult(DR_QUERY_KEY, [{ authority_domain_rating: 93 }]);

    const res = await internal(
      request(app)
        .post("/internal/domains/domain-rating")
        .send({
          domain: "edition.cnn.com",
          dataType: "traffic",
          dataCapturedAt: "2026-06-09T00:00:00Z",
          rawData: { searchType: "traffic_overview" },
          trafficMonthlyAvg: 3289936,
          costMonthlyAvg: 69835384,
          trafficHistory: TRAFFIC_HISTORY,
          trafficTopPages: [{ url: "https://edition.cnn.com/", traffic: 8035, share: 1.8 }],
        })
    );
    expect(res.status).toBe(201);

    const values = snapshotInsertCall()![1] as unknown[];
    expect(values[8]).toBe(false);
    expect(values[9]).toBeNull();
    expect(monthlyInserts()).toHaveLength(2);
  });
});

describe("GET /orgs/domains/traffic-history", () => {
  beforeEach(() => clearMocks());

  it("returns 400 when domains is missing", async () => {
    const res = await withOrg(request(app).get("/orgs/domains/traffic-history"));
    expect(res.status).toBe(400);
  });

  it("returns latest snapshot + ascending monthly series for a known domain", async () => {
    setMockResult(LATEST_VIEW, [snapshotRow("example.com")]);
    setMockResult(MONTHLY_TABLE, monthlyRows("example.com"));

    const res = await withOrg(
      request(app).get("/orgs/domains/traffic-history?domains=example.com")
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].domain).toBe("example.com");
    expect(res.body[0].hasData).toBe(true);
    expect(res.body[0].trafficMonthlyAvg).toBe(4274823);
    expect(res.body[0].monthlyOrganicTraffic).toHaveLength(2);
    expect(res.body[0].monthlyOrganicTraffic[0]).toEqual({
      month: "2026-01-01",
      organicTraffic: 5820145,
    });
  });

  it("surfaces an implausible latest snapshot as no-reliable-data (nulled value + flag)", async () => {
    setMockResult(LATEST_VIEW, [
      {
        ...snapshotRow("wsj.com"),
        traffic_monthly_avg: 4802,
        traffic_implausible: true,
        traffic_implausible_reason: "organic traffic incoherent with domain authority (DR 92, under 5000 monthly organic)",
      },
    ]);
    setMockResult(MONTHLY_TABLE, monthlyRows("wsj.com"));

    const res = await withOrg(
      request(app).get("/orgs/domains/traffic-history?domains=wsj.com")
    );
    expect(res.status).toBe(200);
    expect(res.body[0].hasData).toBe(false);
    expect(res.body[0].trafficMonthlyAvg).toBeNull();
    expect(res.body[0].trafficValueMonthlyAvg).toBeNull();
    expect(res.body[0].monthlyOrganicTraffic).toEqual([]);
    expect(res.body[0].trafficImplausible).toBe(true);
    expect(res.body[0].trafficImplausibleReason).toContain("DR 92");
    // The capture timestamp is retained so the worker can apply its re-scrape cooldown.
    expect(res.body[0].latestDataCapturedAt).not.toBeNull();
  });

  it("returns hasData:false + empty series for a never-scraped domain", async () => {
    const res = await withOrg(
      request(app).get("/orgs/domains/traffic-history?domains=unknown.com")
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].domain).toBe("unknown.com");
    expect(res.body[0].hasData).toBe(false);
    expect(res.body[0].monthlyOrganicTraffic).toEqual([]);
    expect(res.body[0].trafficMonthlyAvg).toBeNull();
  });

  it("normalizes www/apex to the same key and dedupes", async () => {
    setMockResult(LATEST_VIEW, [snapshotRow("example.com")]);
    setMockResult(MONTHLY_TABLE, monthlyRows("example.com"));

    const res = await withOrg(
      request(app).get(
        "/orgs/domains/traffic-history?domains=www.example.com,example.com,EXAMPLE.com"
      )
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].domain).toBe("example.com");
  });
});

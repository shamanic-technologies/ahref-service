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
import { setMockResult, clearMocks } from "./setup";

const API_KEY = "test-api-key";
const app = createApp({ apiKey: API_KEY });

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const DR_VIEW = "v_domains_domain_rating_to_update";

const withOrg = (req: request.Test) =>
  req.set("x-api-key", API_KEY).set("x-org-id", ORG_ID).set("x-run-id", RUN_ID);

const drRow = (domain: string, overrides: Record<string, unknown> = {}) => ({
  domain,
  dr_to_update: false,
  dr_update_reason: "DR exists < 1 year",
  dr_latest_search_date: new Date("2026-06-03T00:00:00Z"),
  latest_valid_dr: 45,
  latest_valid_dr_date: new Date("2026-06-03T00:00:00Z"),
  needs_update: false,
  ...overrides,
});

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

  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });

    // Apify
    if (url.includes("api.apify.com")) {
      if (url.includes("/datasets/")) {
        return makeRes(200, [
          {
            domain: "example.com",
            mode: "domain",
            searchType: "website_authority",
            domainRating: 45,
            backlinks: 10,
            refdomains: 5,
            dofollowBacklinks: 8,
            dofollowRefdomains: 4,
          },
        ]);
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

describe("POST /orgs/domains/dr-compute", () => {
  it("400 when domains is missing", async () => {
    const res = await withOrg(request(app).post("/orgs/domains/dr-compute").send({}));
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it("400 for an invalid domain", async () => {
    const res = await withOrg(
      request(app).post("/orgs/domains/dr-compute").send({ domains: ["not a domain"] })
    );
    expect(res.status).toBe(400);
    // normalize throws before any run/cost is created.
    expect(calls.length).toBe(0);
  });

  it("happy path: scrapes, persists, returns DR", async () => {
    setMockResult(DR_VIEW, [drRow("example.com")]);

    const res = await withOrg(
      request(app).post("/orgs/domains/dr-compute").send({ domains: ["example.com"] })
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].domain).toBe("example.com");
    expect(res.body[0].latestValidDr).toBe(45);

    // Full cost lifecycle ran: create run, provision (POST costs), authorize,
    // key decrypt, apify run + dataset, actual (POST costs), cancel hold (PATCH
    // costs), close run (PATCH run).
    expect(idxOf((c) => c.url.endsWith("/v1/runs") && c.method === "POST")).toBeGreaterThanOrEqual(0);
    expect(idxOf((c) => c.url.includes("/keys/platform/"))).toBeGreaterThanOrEqual(0);
    expect(idxOf(apifyRunCall)).toBeGreaterThanOrEqual(0);
    expect(calls.filter(provisionCall).length).toBe(2); // provision + actual
    expect(idxOf((c) => c.url.includes("/costs/") && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
    expect(idxOf((c) => /\/v1\/runs\/[^/]+$/.test(c.url) && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
  });

  it("declares cost in order: PROVISION → AUTHORIZE → EXECUTE(apify)", async () => {
    setMockResult(DR_VIEW, [drRow("example.com")]);
    await withOrg(
      request(app).post("/orgs/domains/dr-compute").send({ domains: ["example.com"] })
    );
    const provisionIdx = idxOf(provisionCall);
    const authorizeIdx = idxOf(authorizeCall);
    const apifyIdx = idxOf(apifyRunCall);
    expect(provisionIdx).toBeGreaterThanOrEqual(0);
    expect(provisionIdx).toBeLessThan(authorizeIdx);
    expect(authorizeIdx).toBeLessThan(apifyIdx);
  });

  it("502 when authorize is insufficient — no Apify call, hold cancelled", async () => {
    overrides.authorizeSufficient = false;
    const res = await withOrg(
      request(app).post("/orgs/domains/dr-compute").send({ domains: ["example.com"] })
    );
    expect(res.status).toBe(502);
    expect(idxOf(apifyRunCall)).toBe(-1);
    // provisioned hold cancelled + run closed failed
    expect(idxOf((c) => c.url.includes("/costs/") && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
    expect(idxOf((c) => /\/v1\/runs\/[^/]+$/.test(c.url) && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
  });

  it("502 when provision fails (422 unknown cost) — no authorize, no Apify", async () => {
    overrides.provisionStatus = 422;
    const res = await withOrg(
      request(app).post("/orgs/domains/dr-compute").send({ domains: ["example.com"] })
    );
    expect(res.status).toBe(502);
    expect(idxOf(authorizeCall)).toBe(-1);
    expect(idxOf(apifyRunCall)).toBe(-1);
  });

  it("502 when the Apify run fails — hold cancelled, run closed failed", async () => {
    overrides.apifyRunStatus = "FAILED";
    const res = await withOrg(
      request(app).post("/orgs/domains/dr-compute").send({ domains: ["example.com"] })
    );
    expect(res.status).toBe(502);
    expect(idxOf((c) => c.url.includes("/costs/") && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
    expect(idxOf((c) => /\/v1\/runs\/[^/]+$/.test(c.url) && c.method === "PATCH")).toBeGreaterThanOrEqual(0);
  });

  it("502 when the platform Apify key is missing (404) — no Apify run", async () => {
    overrides.keyStatus = 404;
    const res = await withOrg(
      request(app).post("/orgs/domains/dr-compute").send({ domains: ["example.com"] })
    );
    expect(res.status).toBe(502);
    expect(idxOf(apifyRunCall)).toBe(-1);
  });
});

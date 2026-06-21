import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

// Downstream service config is read lazily by the clients at request time.
process.env.RUNS_SERVICE_URL = "http://runs.test";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.BILLING_SERVICE_URL = "http://billing.test";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.KEY_SERVICE_URL = "http://key.test";
process.env.KEY_SERVICE_API_KEY = "key-key";

import { createApp } from "../src/app";
import { buildServiceHeaders } from "../src/services/headers";
import { setMockResult, clearMocks } from "./setup";
import {
  resetDomainMetricWorkersForTest,
  waitForDomainMetricWorkersForTest,
} from "../src/services/domain-metric-jobs";

const API_KEY = "test-api-key";
const app = createApp({ apiKey: API_KEY });

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const AUDIENCE_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const DR_VIEW = "v_domains_domain_rating_to_update";

// ---------------------------------------------------------------------------
// Unit — buildServiceHeaders forwards x-audience-id to INTERNAL services only.
// (Vendor calls — Ahrefs, Apify — build headers inline and never use this
// builder, so the internal tracking block can never leak to a third party.)
// ---------------------------------------------------------------------------
describe("buildServiceHeaders — audience attribution forward", () => {
  it("forwards x-audience-id when present in the context", () => {
    const headers = buildServiceHeaders("k", {
      orgId: ORG_ID,
      runId: RUN_ID,
      audienceId: AUDIENCE_ID,
    });
    expect(headers["x-audience-id"]).toBe(AUDIENCE_ID);
  });

  it("omits x-audience-id entirely when absent (never sends 'undefined'/'null')", () => {
    const headers = buildServiceHeaders("k", { orgId: ORG_ID, runId: RUN_ID });
    expect("x-audience-id" in headers).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end — the async worker path is the hard case: the inbound header must
// survive the request→job-row→worker boundary and reach runs-service on the
// run/cost egress. This is the regression that prevents the ~97%-unattributed
// bucket from coming back for dr/traffic compute.
// ---------------------------------------------------------------------------
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}
let calls: Call[];

const makeRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const drRowNeedsUpdate = (domain: string) => ({
  domain,
  dr_to_update: true,
  dr_update_reason: "DR outdated",
  dr_latest_search_date: null,
  latest_valid_dr: null,
  latest_valid_dr_date: null,
  needs_update: true,
});

beforeEach(() => {
  clearMocks();
  calls = [];

  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      method,
      url,
      headers: (init as { headers?: Record<string, string> } | undefined)?.headers ?? {},
    });

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
          status: "SUCCEEDED",
          defaultDatasetId: "ds-1",
          chargedEventCounts: { "apify-default-dataset-item": 1 },
        },
      });
    }
    if (url.includes("customer_balance/authorize")) {
      return makeRes(200, { sufficient: true, balance_cents: "100000", required_cents: "50" });
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

const runCreateCall = () =>
  calls.find((c) => c.url.endsWith("/v1/runs") && c.method === "POST");

describe("dr-compute async path — inbound x-audience-id reaches runs-service", () => {
  it("tags the runs-service run egress with the inbound audience id", async () => {
    setMockResult(DR_VIEW, [drRowNeedsUpdate("example.com")]);

    const res = await request(app)
      .post("/orgs/domains/dr-compute")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG_ID)
      .set("x-run-id", RUN_ID)
      .set("x-audience-id", AUDIENCE_ID)
      .send({ domains: ["example.com"] });
    await waitForDomainMetricWorkersForTest();

    expect(res.status).toBe(200);
    const create = runCreateCall();
    expect(create).toBeDefined();
    expect(create?.headers["x-audience-id"]).toBe(AUDIENCE_ID);
  });

  it("omits x-audience-id on egress when the inbound request carries none", async () => {
    setMockResult(DR_VIEW, [drRowNeedsUpdate("example.com")]);

    const res = await request(app)
      .post("/orgs/domains/dr-compute")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG_ID)
      .set("x-run-id", RUN_ID)
      .send({ domains: ["example.com"] });
    await waitForDomainMetricWorkersForTest();

    expect(res.status).toBe(200);
    const create = runCreateCall();
    expect(create).toBeDefined();
    expect("x-audience-id" in (create?.headers ?? {})).toBe(false);
  });
});

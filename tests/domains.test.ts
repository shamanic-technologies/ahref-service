import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import {
  setMockResult,
  clearMocks,
  getMockPool,
  getInsertApifyId,
} from "./setup";

const API_KEY = "test-api-key";
const app = createApp({ apiKey: API_KEY });

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const DR_VIEW = "v_domains_domain_rating_to_update";
const LOW_VIEW = "v_domains_low_domain_rating";

// /orgs/* requests carry x-org-id (required) + optional identity headers.
const withOrg = (req: request.Test) =>
  req
    .set("x-api-key", API_KEY)
    .set("x-org-id", ORG_ID)
    .set("x-user-id", USER_ID)
    .set("x-run-id", RUN_ID);

// /internal/* requests carry the API key only.
const internal = (req: request.Test) => req.set("x-api-key", API_KEY);

const drRow = (domain: string, overrides: Record<string, unknown> = {}) => ({
  domain,
  dr_to_update: false,
  dr_update_reason: "DR exists < 1 year",
  dr_latest_search_date: new Date("2025-06-01T00:00:00Z"),
  latest_valid_dr: 45,
  latest_valid_dr_date: new Date("2025-06-01T00:00:00Z"),
  needs_update: false,
  ...overrides,
});

describe("GET /orgs/domains/dr-status", () => {
  beforeEach(() => clearMocks());

  it("returns 400 when domains is missing", async () => {
    const res = await withOrg(request(app).get("/orgs/domains/dr-status"));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/domains/);
  });

  it("returns 400 for an invalid domain", async () => {
    const res = await withOrg(
      request(app).get("/orgs/domains/dr-status?domains=not%20a%20domain")
    );
    expect(res.status).toBe(400);
  });

  it("returns DR status for a known domain", async () => {
    setMockResult(DR_VIEW, [drRow("example.com")]);

    const res = await withOrg(
      request(app).get("/orgs/domains/dr-status?domains=example.com")
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].domain).toBe("example.com");
    expect(res.body[0].latestValidDr).toBe(45);
    expect(res.body[0].needsUpdate).toBe(false);
  });

  it("returns default needs-update for an unknown domain", async () => {
    setMockResult(DR_VIEW, []);

    const res = await withOrg(
      request(app).get("/orgs/domains/dr-status?domains=unknown.com")
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].domain).toBe("unknown.com");
    expect(res.body[0].needsUpdate).toBe(true);
    expect(res.body[0].drUpdateReason).toBe("No DR fetched yet");
  });

  it("normalizes www and apex to the SAME key and dedupes", async () => {
    setMockResult(DR_VIEW, [drRow("example.com")]);

    const res = await withOrg(
      request(app).get(
        "/orgs/domains/dr-status?domains=www.example.com,example.com,EXAMPLE.com"
      )
    );
    expect(res.status).toBe(200);
    // All three inputs collapse to one domain key.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].domain).toBe("example.com");

    // The view was queried with a single normalized value.
    const viewCall = getMockPool().query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes(DR_VIEW)
    );
    expect(viewCall![1]).toEqual(["example.com"]);
  });

  it("keeps non-www subdomains distinct", async () => {
    setMockResult(DR_VIEW, [drRow("blog.example.com")]);

    const res = await withOrg(
      request(app).get(
        "/orgs/domains/dr-status?domains=blog.example.com,example.com"
      )
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const viewCall = getMockPool().query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes(DR_VIEW)
    );
    expect(viewCall![1]).toEqual(["blog.example.com", "example.com"]);
  });
});

describe("GET /internal/domains/dr-stale", () => {
  beforeEach(() => clearMocks());

  it("returns stale domains", async () => {
    setMockResult(DR_VIEW, [
      drRow("stale.com", {
        dr_to_update: true,
        dr_update_reason: "DR outdated",
        needs_update: true,
        latest_valid_dr: 30,
      }),
    ]);

    const res = await internal(request(app).get("/internal/domains/dr-stale"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].domain).toBe("stale.com");
    expect(res.body[0].drToUpdate).toBe(true);
  });

  it("returns empty array when no stale domains", async () => {
    const res = await internal(request(app).get("/internal/domains/dr-stale"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /internal/domains/low-domain-rating", () => {
  beforeEach(() => clearMocks());

  it("returns domains with low DR", async () => {
    setMockResult(LOW_VIEW, [
      drRow("low.com", { latest_valid_dr: 5, has_low_domain_rating: true }),
    ]);

    const res = await internal(
      request(app).get("/internal/domains/low-domain-rating")
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].domain).toBe("low.com");
    expect(res.body[0].hasLowDomainRating).toBe(true);
    expect(res.body[0].latestValidDr).toBe(5);
  });
});

describe("POST /internal/domains/domain-rating", () => {
  beforeEach(() => clearMocks());

  it("returns 400 when domain is missing from the body", async () => {
    const res = await internal(
      request(app)
        .post("/internal/domains/domain-rating")
        .send({
          dataType: "authority",
          dataCapturedAt: "2025-06-01T00:00:00Z",
          rawData: {},
        })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid body/);
  });

  it("returns 400 for an invalid body", async () => {
    const res = await internal(
      request(app)
        .post("/internal/domains/domain-rating")
        .send({ dataType: "invalid" })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid body/);
  });

  it("returns 400 for an unusable domain string", async () => {
    const res = await internal(
      request(app)
        .post("/internal/domains/domain-rating")
        .send({
          domain: "not a domain",
          dataType: "authority",
          dataCapturedAt: "2025-06-01T00:00:00Z",
          rawData: {},
        })
    );
    expect(res.status).toBe(400);
  });

  it("stores into apify_ahref ONLY (no outlet link table) and returns {id, domain}", async () => {
    const res = await internal(
      request(app)
        .post("/internal/domains/domain-rating")
        .send({
          domain: "example.com",
          dataType: "authority",
          dataCapturedAt: "2025-06-01T00:00:00Z",
          rawData: { dr: 45 },
          authorityDomainRating: 45,
        })
    );
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(getInsertApifyId());
    expect(res.body.domain).toBe("example.com");

    const queryTexts = getMockPool().query.mock.calls.map(
      (c: unknown[]) => c[0] as string
    );
    expect(queryTexts.some((t) => t.includes("INSERT INTO apify_ahref"))).toBe(
      true
    );
    // The outlet link table is gone — it must never be written.
    expect(queryTexts.some((t) => t.includes("ahref_outlets"))).toBe(false);
  });

  it("normalizes the domain before storing (www stripped)", async () => {
    const res = await internal(
      request(app)
        .post("/internal/domains/domain-rating")
        .send({
          domain: "https://www.Example.com/contact",
          dataType: "authority",
          dataCapturedAt: "2025-06-01T00:00:00Z",
          rawData: { dr: 50 },
          authorityDomainRating: 50,
        })
    );
    expect(res.status).toBe(201);
    expect(res.body.domain).toBe("example.com");

    const insertCall = getMockPool().query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" && c[0].includes("INSERT INTO apify_ahref")
    );
    expect(insertCall).toBeDefined();
    const values = insertCall![1] as unknown[];
    // 25 columns, domain is the 2nd value, normalized.
    expect(values).toHaveLength(25);
    expect(values[1]).toBe("example.com");
  });
});

describe("removed outlet coupling", () => {
  beforeEach(() => clearMocks());

  it("no longer serves the campaign-categories endpoint", async () => {
    const res = await withOrg(
      request(app).get(
        "/orgs/domains/campaign-categories-dr-status?campaignId=33333333-3333-3333-3333-333333333333"
      )
    );
    expect(res.status).toBe(404);
  });

  it("no longer serves the old /orgs/outlets path", async () => {
    const res = await withOrg(
      request(app).get("/orgs/outlets/dr-status?outletIds=x")
    );
    expect(res.status).toBe(404);
  });
});

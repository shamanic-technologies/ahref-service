import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { setMockResult, clearMocks, getMockClient } from "./setup";

const API_KEY = "test-api-key";
const app = createApp({
  apiKey: API_KEY,
  outletsServiceUrl: "http://localhost:9999",
  outletsServiceApiKey: "test-outlets-key",
});

const OUTLET_ID_1 = "11111111-1111-1111-1111-111111111111";
const OUTLET_ID_2 = "22222222-2222-2222-2222-222222222222";

describe("GET /outlets/dr-status", () => {
  beforeEach(() => {
    clearMocks();
  });

  it("returns 400 when outletIds is missing", async () => {
    const res = await request(app)
      .get("/outlets/dr-status")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outletIds/);
  });

  it("returns 400 for invalid UUID", async () => {
    const res = await request(app)
      .get("/outlets/dr-status?outletIds=not-a-uuid")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid UUID/);
  });

  it("returns DR status for known outlets", async () => {
    setMockResult("v_outlets_domain_rating_to_update", [
      {
        outlet_id: OUTLET_ID_1,
        dr_to_update: false,
        dr_update_reason: "DR exists < 1 year",
        dr_latest_search_date: new Date("2025-06-01T00:00:00Z"),
        latest_valid_dr: 45,
        latest_valid_dr_date: new Date("2025-06-01T00:00:00Z"),
        needs_update: false,
      },
    ]);

    const res = await request(app)
      .get(`/outlets/dr-status?outletIds=${OUTLET_ID_1}`)
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].outletId).toBe(OUTLET_ID_1);
    expect(res.body[0].latestValidDr).toBe(45);
    expect(res.body[0].needsUpdate).toBe(false);
  });

  it("returns default needs-update for unknown outlet IDs", async () => {
    setMockResult("v_outlets_domain_rating_to_update", []);

    const res = await request(app)
      .get(`/outlets/dr-status?outletIds=${OUTLET_ID_1}`)
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].outletId).toBe(OUTLET_ID_1);
    expect(res.body[0].needsUpdate).toBe(true);
    expect(res.body[0].drUpdateReason).toBe("No DR fetched yet");
  });

  it("handles multiple outlet IDs", async () => {
    setMockResult("v_outlets_domain_rating_to_update", [
      {
        outlet_id: OUTLET_ID_1,
        dr_to_update: false,
        dr_update_reason: "DR exists < 1 year",
        dr_latest_search_date: new Date("2025-06-01T00:00:00Z"),
        latest_valid_dr: 45,
        latest_valid_dr_date: new Date("2025-06-01T00:00:00Z"),
        needs_update: false,
      },
    ]);

    const res = await request(app)
      .get(`/outlets/dr-status?outletIds=${OUTLET_ID_1},${OUTLET_ID_2}`)
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // OUTLET_ID_1 found in DB, OUTLET_ID_2 defaults to needs_update
    const outlet2 = res.body.find(
      (r: { outletId: string }) => r.outletId === OUTLET_ID_2
    );
    expect(outlet2?.needsUpdate).toBe(true);
  });
});

describe("GET /outlets/dr-stale", () => {
  beforeEach(() => {
    clearMocks();
  });

  it("returns stale outlets", async () => {
    setMockResult("v_outlets_domain_rating_to_update", [
      {
        outlet_id: OUTLET_ID_1,
        dr_to_update: true,
        dr_update_reason: "DR outdated",
        dr_latest_search_date: new Date("2024-01-01T00:00:00Z"),
        latest_valid_dr: 30,
        latest_valid_dr_date: new Date("2024-01-01T00:00:00Z"),
        needs_update: true,
      },
    ]);

    const res = await request(app)
      .get("/outlets/dr-stale")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].drToUpdate).toBe(true);
  });

  it("returns empty array when no stale outlets", async () => {
    const res = await request(app)
      .get("/outlets/dr-stale")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("PATCH /outlets/:outletId/domain-rating", () => {
  beforeEach(() => {
    clearMocks();
  });

  it("returns 400 for invalid outlet ID", async () => {
    const res = await request(app)
      .patch("/outlets/not-uuid/domain-rating")
      .set("x-api-key", API_KEY)
      .send({ dataType: "authority", dataCapturedAt: new Date().toISOString(), rawData: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid outlet ID/);
  });

  it("returns 400 for invalid body", async () => {
    const res = await request(app)
      .patch(`/outlets/${OUTLET_ID_1}/domain-rating`)
      .set("x-api-key", API_KEY)
      .send({ dataType: "invalid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid body/);
  });

  it("creates apify_ahref and ahref_outlets records", async () => {
    const res = await request(app)
      .patch(`/outlets/${OUTLET_ID_1}/domain-rating`)
      .set("x-api-key", API_KEY)
      .send({
        dataType: "authority",
        dataCapturedAt: "2025-06-01T00:00:00Z",
        rawData: { dr: 45 },
        authorityDomainRating: 45,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("00000000-0000-0000-0000-000000000099");
    expect(res.body.outletId).toBe(OUTLET_ID_1);

    // Verify transaction was used
    const client = getMockClient();
    const queryTexts = client.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(queryTexts).toContain("BEGIN");
    expect(queryTexts).toContain("COMMIT");
    expect(queryTexts.some((t: string) => t.includes("INSERT INTO apify_ahref"))).toBe(true);
    expect(queryTexts.some((t: string) => t.includes("INSERT INTO ahref_outlets"))).toBe(true);
  });

  it("stores org_id and user_id from identity headers", async () => {
    const orgId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const userId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const res = await request(app)
      .patch(`/outlets/${OUTLET_ID_1}/domain-rating`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", orgId)
      .set("x-user-id", userId)
      .send({
        dataType: "authority",
        dataCapturedAt: "2025-06-01T00:00:00Z",
        rawData: { dr: 50 },
        authorityDomainRating: 50,
      });
    expect(res.status).toBe(201);

    const client = getMockClient();
    const insertCall = client.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("INSERT INTO apify_ahref")
    );
    expect(insertCall).toBeDefined();
    const values = insertCall![1] as unknown[];
    // org_id is $26, user_id is $27 (0-indexed: 25, 26)
    expect(values[25]).toBe(orgId);
    expect(values[26]).toBe(userId);
  });

  it("stores null org_id/user_id when identity headers are absent", async () => {
    const res = await request(app)
      .patch(`/outlets/${OUTLET_ID_1}/domain-rating`)
      .set("x-api-key", API_KEY)
      .send({
        dataType: "authority",
        dataCapturedAt: "2025-06-01T00:00:00Z",
        rawData: { dr: 45 },
        authorityDomainRating: 45,
      });
    expect(res.status).toBe(201);

    const client = getMockClient();
    const insertCall = client.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("INSERT INTO apify_ahref")
    );
    const values = insertCall![1] as unknown[];
    expect(values[25]).toBeNull();
    expect(values[26]).toBeNull();
  });

  it("ignores invalid (non-UUID) identity headers", async () => {
    const res = await request(app)
      .patch(`/outlets/${OUTLET_ID_1}/domain-rating`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", "not-a-uuid")
      .set("x-user-id", "also-not-a-uuid")
      .send({
        dataType: "authority",
        dataCapturedAt: "2025-06-01T00:00:00Z",
        rawData: { dr: 45 },
        authorityDomainRating: 45,
      });
    expect(res.status).toBe(201);

    const client = getMockClient();
    const insertCall = client.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("INSERT INTO apify_ahref")
    );
    const values = insertCall![1] as unknown[];
    expect(values[25]).toBeNull();
    expect(values[26]).toBeNull();
  });

  it("stores traffic data type", async () => {
    const res = await request(app)
      .patch(`/outlets/${OUTLET_ID_1}/domain-rating`)
      .set("x-api-key", API_KEY)
      .send({
        dataType: "traffic",
        dataCapturedAt: "2025-06-01T00:00:00Z",
        rawData: { traffic: 1000 },
        trafficMonthlyAvg: 1000,
      });
    expect(res.status).toBe(201);
  });
});

describe("GET /outlets/low-domain-rating", () => {
  beforeEach(() => {
    clearMocks();
  });

  it("returns outlets with low DR", async () => {
    setMockResult("v_outlets_low_domain_rating", [
      {
        outlet_id: OUTLET_ID_1,
        dr_to_update: false,
        dr_update_reason: "DR exists < 1 year",
        dr_latest_search_date: new Date("2025-06-01T00:00:00Z"),
        latest_valid_dr: 5,
        latest_valid_dr_date: new Date("2025-06-01T00:00:00Z"),
        needs_update: false,
        has_low_domain_rating: true,
      },
    ]);

    const res = await request(app)
      .get("/outlets/low-domain-rating")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].hasLowDomainRating).toBe(true);
    expect(res.body[0].latestValidDr).toBe(5);
  });
});

describe("GET /outlets/campaign-categories-dr-status", () => {
  beforeEach(() => {
    clearMocks();
  });

  it("returns 400 without campaignId", async () => {
    const res = await request(app)
      .get("/outlets/campaign-categories-dr-status")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/campaignId/);
  });

  it("returns 400 for invalid campaignId", async () => {
    const res = await request(app)
      .get("/outlets/campaign-categories-dr-status?campaignId=not-uuid")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid campaignId/);
  });

  it("calls outlets-service and returns DR status", async () => {
    const campaignId = "33333333-3333-3333-3333-333333333333";

    // Mock the outlets-service fetch
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ outletIds: [OUTLET_ID_1] }),
      text: async () => "",
    } as Response);

    setMockResult("v_outlets_domain_rating_to_update", [
      {
        outlet_id: OUTLET_ID_1,
        dr_to_update: false,
        dr_update_reason: "DR exists < 1 year",
        dr_latest_search_date: new Date("2025-06-01T00:00:00Z"),
        latest_valid_dr: 55,
        latest_valid_dr_date: new Date("2025-06-01T00:00:00Z"),
        needs_update: false,
      },
    ]);

    const res = await request(app)
      .get(`/outlets/campaign-categories-dr-status?campaignId=${campaignId}`)
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].latestValidDr).toBe(55);

    expect(fetchSpy).toHaveBeenCalledWith(
      `http://localhost:9999/internal/outlets/by-campaign/${campaignId}`,
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "test-outlets-key" }),
      })
    );

    fetchSpy.mockRestore();
  });

  it("returns empty array when campaign has no outlets", async () => {
    const campaignId = "33333333-3333-3333-3333-333333333333";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ outletIds: [] }),
      text: async () => "",
    } as Response);

    const res = await request(app)
      .get(`/outlets/campaign-categories-dr-status?campaignId=${campaignId}`)
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);

    vi.restoreAllMocks();
  });
});

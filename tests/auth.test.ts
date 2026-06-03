import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { clearMocks } from "./setup";

const API_KEY = "test-api-key";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const app = createApp({
  apiKey: API_KEY,
  outletsServiceUrl: "http://localhost:9999",
  outletsServiceApiKey: "test-outlets-key",
});

describe("Auth middleware", () => {
  beforeEach(() => {
    clearMocks();
  });

  it("rejects requests without x-api-key", async () => {
    const res = await request(app).get("/internal/outlets/dr-stale");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Unauthorized/);
  });

  it("rejects requests with wrong x-api-key", async () => {
    const res = await request(app)
      .get("/internal/outlets/dr-stale")
      .set("x-api-key", "wrong-key");
    expect(res.status).toBe(401);
  });

  it("allows internal requests with correct x-api-key and no identity", async () => {
    const res = await request(app)
      .get("/internal/outlets/dr-stale")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
  });
});

describe("requireOrgId middleware (/orgs/*)", () => {
  beforeEach(() => {
    clearMocks();
  });

  it("rejects /orgs requests missing x-org-id", async () => {
    const res = await request(app)
      .get("/orgs/outlets/dr-status?outletIds=11111111-1111-1111-1111-111111111111")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-org-id/);
  });

  it("accepts /orgs requests with only x-org-id (user/run optional)", async () => {
    const res = await request(app)
      .get("/orgs/outlets/dr-status?outletIds=11111111-1111-1111-1111-111111111111")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG_ID);
    expect(res.status).toBe(200);
  });
});

describe("Route tiers", () => {
  it("returns 404 for the old flat /outlets/* paths", async () => {
    const res = await request(app)
      .get("/outlets/dr-stale")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(404);
  });
});

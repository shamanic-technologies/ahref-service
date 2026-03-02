import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { clearMocks } from "./setup";

const API_KEY = "test-api-key";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

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
    const res = await request(app).get("/outlets/dr-stale");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Unauthorized/);
  });

  it("rejects requests with wrong x-api-key", async () => {
    const res = await request(app)
      .get("/outlets/dr-stale")
      .set("x-api-key", "wrong-key");
    expect(res.status).toBe(401);
  });

  it("allows requests with correct x-api-key and identity headers", async () => {
    const res = await request(app)
      .get("/outlets/dr-stale")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID);
    expect(res.status).toBe(200);
  });
});

describe("Identity middleware", () => {
  beforeEach(() => {
    clearMocks();
  });

  it("rejects requests missing x-org-id", async () => {
    const res = await request(app)
      .get("/outlets/dr-stale")
      .set("x-api-key", API_KEY)
      .set("x-user-id", USER_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-org-id/);
  });

  it("rejects requests missing x-user-id", async () => {
    const res = await request(app)
      .get("/outlets/dr-stale")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-user-id/);
  });

  it("rejects requests with invalid x-org-id", async () => {
    const res = await request(app)
      .get("/outlets/dr-stale")
      .set("x-api-key", API_KEY)
      .set("x-org-id", "not-a-uuid")
      .set("x-user-id", USER_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-org-id/);
  });

  it("rejects requests with invalid x-user-id", async () => {
    const res = await request(app)
      .get("/outlets/dr-stale")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG_ID)
      .set("x-user-id", "not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-user-id/);
  });

  it("rejects requests missing both identity headers", async () => {
    const res = await request(app)
      .get("/outlets/dr-stale")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
  });
});

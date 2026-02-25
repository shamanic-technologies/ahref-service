import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { clearMocks } from "./setup";

const API_KEY = "test-api-key";
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

  it("allows requests with correct x-api-key", async () => {
    const res = await request(app)
      .get("/outlets/dr-stale")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
  });
});

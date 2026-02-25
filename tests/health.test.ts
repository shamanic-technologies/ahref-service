import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";

const app = createApp({
  apiKey: "test-api-key",
  outletsServiceUrl: "http://localhost:9999",
  outletsServiceApiKey: "test-outlets-key",
});

describe("GET /health", () => {
  it("returns ok without auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "ahref-service" });
  });
});

describe("GET /openapi.json", () => {
  it("serves the openapi spec without auth", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.3");
    expect(res.body.info.title).toBe("Ahref Service");
  });
});

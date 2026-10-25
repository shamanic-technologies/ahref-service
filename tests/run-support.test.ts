import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.RUNS_SERVICE_URL = "http://runs.test";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.BILLING_SERVICE_URL = "http://billing.test";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.KEY_SERVICE_URL = "http://key.test";
process.env.KEY_SERVICE_API_KEY = "key-key";

import { createChildRun, DIRECT_READ_SUPPORT } from "../src/services/runs";

let bodies: Array<Record<string, unknown>>;
let headers: Array<Record<string, string>>;

beforeEach(() => {
  bodies = [];
  headers = [];
  global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    headers.push(init?.headers as Record<string, string>);
    return new Response(JSON.stringify({ id: "own-run-1" }), { status: 201 });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

describe("createChildRun — support mark (ledger reconciliation)", () => {
  it("marks a run opened with no caller run as a product_feature support run", async () => {
    await createChildRun("ai-visibility", { orgId: "org-1" });

    expect(bodies[0]).toEqual({
      serviceName: "ahref-service",
      taskName: "ai-visibility",
      support: DIRECT_READ_SUPPORT,
    });
    expect(DIRECT_READ_SUPPORT.kind).toBe("product_feature");
    expect(headers[0]["x-run-id"]).toBeUndefined();
  });

  it("leaves a run under a caller's run unmarked (its cost rides the caller's declaration)", async () => {
    await createChildRun("traffic-compute", { orgId: "org-1", runId: "caller-run-1" });

    expect(bodies[0]).toEqual({ serviceName: "ahref-service", taskName: "traffic-compute" });
    expect(headers[0]["x-run-id"]).toBe("caller-run-1");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";

import { clearMocks, getMockPool, getMetricJobs, seedMetricJob } from "./setup";
import {
  processDomainMetricJobs,
  reclaimStaleRunningJobs,
  recoverDomainMetricQueueOnce,
  registerDomainMetricProcessor,
  waitForDomainMetricWorkersForTest,
  resetDomainMetricWorkersForTest,
  setDomainMetricBatchTimeoutForTest,
} from "../src/services/domain-metric-jobs";

const pool = getMockPool() as unknown as Pool;
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeEach(() => {
  clearMocks();
  resetDomainMetricWorkersForTest();
});

afterEach(() => {
  resetDomainMetricWorkersForTest();
});

describe("reclaimStaleRunningJobs (reaper)", () => {
  it("resets a stale running job under the attempt cap back to pending with last_error", async () => {
    seedMetricJob({
      orgId: ORG_ID,
      metric: "dr",
      domain: "thewealthchannel.com",
      status: "running",
      attempts: 1,
      startedAt: minutesAgo(21),
    });

    const reclaimed = await reclaimStaleRunningJobs(pool);

    expect(reclaimed).toHaveLength(1);
    const job = getMetricJobs()[0];
    expect(job.status).toBe("pending");
    expect(job.started_at).toBeNull();
    expect(String(job.last_error)).toContain("stale timeout");
  });

  it("fails a stale running job that has exhausted its attempts (frees the slot permanently)", async () => {
    seedMetricJob({
      orgId: ORG_ID,
      metric: "dr",
      domain: "menainvestor.com",
      status: "running",
      attempts: 3,
      startedAt: minutesAgo(21),
    });

    const reclaimed = await reclaimStaleRunningJobs(pool);

    expect(reclaimed).toHaveLength(1);
    const job = getMetricJobs()[0];
    expect(job.status).toBe("failed");
    expect(String(job.last_error)).toContain("stale timeout");
  });

  it("does NOT reclaim a freshly-running job (legitimately in-flight)", async () => {
    seedMetricJob({
      orgId: ORG_ID,
      metric: "dr",
      domain: "altaccess.com",
      status: "running",
      attempts: 1,
      startedAt: minutesAgo(1),
    });

    const reclaimed = await reclaimStaleRunningJobs(pool);

    expect(reclaimed).toHaveLength(0);
    expect(getMetricJobs()[0].status).toBe("running");
  });
});

describe("recoverDomainMetricQueueOnce (boot / on-read drain)", () => {
  it("kicks a worker for orphaned pending jobs so they drain without a fresh enqueue", async () => {
    registerDomainMetricProcessor("dr", async () => {
      /* scrape is mocked out — success path */
    });
    seedMetricJob({
      orgId: ORG_ID,
      metric: "dr",
      domain: "thewealthchannel.com",
      status: "pending",
    });

    const { kicked } = await recoverDomainMetricQueueOnce(pool);
    await waitForDomainMetricWorkersForTest();

    expect(kicked).toBe(1);
    expect(getMetricJobs()[0].status).toBe("succeeded");
  });

  it("reclaims a stale running job AND reprocesses it to completion", async () => {
    registerDomainMetricProcessor("dr", async () => {
      /* success path */
    });
    seedMetricJob({
      orgId: ORG_ID,
      metric: "dr",
      domain: "menainvestor.com",
      status: "running",
      attempts: 1,
      startedAt: minutesAgo(21),
    });

    const { reclaimed } = await recoverDomainMetricQueueOnce(pool);
    await waitForDomainMetricWorkersForTest();

    expect(reclaimed).toBe(1);
    expect(getMetricJobs()[0].status).toBe("succeeded");
  });
});

describe("per-batch timeout", () => {
  it("fails a hung batch within the timeout and frees the worker slot", async () => {
    setDomainMetricBatchTimeoutForTest(50);
    seedMetricJob({
      orgId: ORG_ID,
      metric: "dr",
      domain: "altaccess.com",
      status: "pending",
    });

    // Processor that never resolves — simulates a hung scrape / cold-start DB hang.
    const hangingProcessor = () => new Promise<void>(() => {});

    await processDomainMetricJobs(pool, "dr", ORG_ID, hangingProcessor);

    const job = getMetricJobs()[0];
    expect(job.status).toBe("failed");
    expect(String(job.last_error)).toContain("timeout");
  });
});

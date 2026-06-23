import { vi } from "vitest";

// Mock pg Pool
const mockResults: Map<string, { rows: Record<string, unknown>[] }> = new Map();
let lastQuery: { text: string; values: unknown[] } | null = null;
const metricJobs = new Map<string, Record<string, unknown>>();
let metricJobSeq = 0;

const INSERT_APIFY_ID = "00000000-0000-0000-0000-000000000099";

const mockPool = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    lastQuery = { text, values: values ?? [] };

    if (text.includes("INSERT INTO domain_metric_compute_jobs")) {
      const metric = values?.[0] as string;
      const domains = values?.[1] as string[];
      const orgId = values?.[2] as string;
      const userId = (values?.[3] as string | null) ?? null;
      const parentRunId = (values?.[4] as string | null) ?? null;
      const audienceId = (values?.[5] as string | null) ?? null;
      const rows: Record<string, unknown>[] = [];

      for (const domain of domains) {
        const key = `${orgId}:${metric}:${domain}`;
        const existing = metricJobs.get(key);
        if (existing && ["pending", "running"].includes(existing.status as string)) {
          continue;
        }
        const row = {
          id: existing?.id ?? `00000000-0000-0000-0000-${String(++metricJobSeq).padStart(12, "0")}`,
          org_id: orgId,
          user_id: userId,
          parent_run_id: parentRunId,
          audience_id: audienceId,
          metric,
          domain,
          status: "pending",
        };
        metricJobs.set(key, row);
        rows.push(row);
      }

      return { rows };
    }

    if (text.includes("UPDATE domain_metric_compute_jobs jobs")) {
      const metric = values?.[0] as string;
      const orgId = values?.[1] as string;
      const limit = values?.[2] as number;
      const rows: Record<string, unknown>[] = [];

      for (const row of metricJobs.values()) {
        if (rows.length >= limit) break;
        if (row.metric === metric && row.org_id === orgId && row.status === "pending") {
          row.status = "running";
          row.started_at = new Date();
          row.attempts = ((row.attempts as number) ?? 0) + 1;
          rows.push(row);
        }
      }

      return { rows };
    }

    // Reaper: reclaim stale running jobs (running older than the stale window).
    if (text.includes("status = CASE WHEN attempts >= $2")) {
      const staleSecs = values?.[0] as number;
      const maxAttempts = values?.[1] as number;
      const lastError = values?.[2];
      const cutoff = Date.now() - staleSecs * 1000;
      const rows: Record<string, unknown>[] = [];

      for (const row of metricJobs.values()) {
        if (row.status !== "running") continue;
        const startedAt = row.started_at as Date | null | undefined;
        if (!startedAt || startedAt.getTime() >= cutoff) continue;
        const attempts = (row.attempts as number) ?? 0;
        row.status = attempts >= maxAttempts ? "failed" : "pending";
        row.started_at = null;
        row.last_error = lastError;
        rows.push({
          id: row.id,
          metric: row.metric,
          org_id: row.org_id,
          status: row.status,
        });
      }

      return { rows };
    }

    // Reaper: distinct (metric, org) work units that still have pending jobs.
    if (text.includes("SELECT DISTINCT metric, org_id")) {
      const seen = new Set<string>();
      const rows: Record<string, unknown>[] = [];
      for (const row of metricJobs.values()) {
        if (row.status !== "pending") continue;
        const k = `${row.metric}:${row.org_id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({ metric: row.metric, org_id: row.org_id });
      }
      return { rows };
    }

    // Reaper: outstanding (pending + running) job count.
    if (text.includes("COUNT(*)") && text.includes("'pending', 'running'")) {
      let n = 0;
      for (const row of metricJobs.values()) {
        if (["pending", "running"].includes(row.status as string)) n += 1;
      }
      return { rows: [{ n }] };
    }

    if (text.includes("UPDATE domain_metric_compute_jobs")) {
      const ids = (values?.[0] as string[]) ?? [];
      const status = text.includes("status = 'succeeded'") ? "succeeded" : "failed";
      for (const row of metricJobs.values()) {
        if (ids.includes(row.id as string)) {
          row.status = status;
          if (status === "failed") row.last_error = values?.[1];
        }
      }
      return { rows: [] };
    }

    // Ingestion: single INSERT into the data/cache table returns the new id.
    if (text.includes("INSERT INTO apify_ahref")) {
      return { rows: [{ id: INSERT_APIFY_ID }] };
    }

    const key = findMatchingKey(text);
    if (key && mockResults.has(key)) {
      return mockResults.get(key)!;
    }
    return { rows: [] };
  }),
  connect: vi.fn(),
  end: vi.fn(),
};

const findMatchingKey = (text: string): string | undefined => {
  for (const key of mockResults.keys()) {
    if (text.includes(key)) return key;
  }
  return undefined;
};

export const setMockResult = (
  querySubstring: string,
  rows: Record<string, unknown>[]
) => {
  mockResults.set(querySubstring, { rows });
};

export const clearMocks = () => {
  mockResults.clear();
  metricJobs.clear();
  metricJobSeq = 0;
  lastQuery = null;
  mockPool.query.mockClear();
};

export const getLastQuery = () => lastQuery;
export const getMockPool = () => mockPool;
export const getInsertApifyId = () => INSERT_APIFY_ID;
export const getMetricJobs = () => [...metricJobs.values()];

export const seedMetricJob = (job: {
  orgId: string;
  metric: string;
  domain: string;
  status: string;
  attempts?: number;
  startedAt?: Date | null;
  id?: string;
}) => {
  const key = `${job.orgId}:${job.metric}:${job.domain}`;
  const row = {
    id: job.id ?? `00000000-0000-0000-0000-${String(++metricJobSeq).padStart(12, "0")}`,
    org_id: job.orgId,
    user_id: null,
    parent_run_id: null,
    audience_id: null,
    metric: job.metric,
    domain: job.domain,
    status: job.status,
    attempts: job.attempts ?? 0,
    started_at: job.startedAt ?? null,
  };
  metricJobs.set(key, row);
  return row;
};

// Mock the db module
vi.mock("../src/db", () => ({
  getPool: () => mockPool,
  setPool: vi.fn(),
  closePool: vi.fn(),
}));

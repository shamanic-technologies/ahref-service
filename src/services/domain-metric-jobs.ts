import { Pool } from "pg";
import type { OrgContext } from "../middleware/org-context";

export type DomainMetric = "dr" | "traffic";

export interface DomainMetricJob {
  id: string;
  orgId: string;
  userId?: string;
  parentRunId?: string;
  metric: DomainMetric;
  domain: string;
}

type DomainMetricProcessor = (jobs: DomainMetricJob[]) => Promise<void>;

const activeWorkers = new Map<string, Promise<void>>();
let autoStartWorkers = true;

const workerKey = (metric: DomainMetric, orgId: string) => `${orgId}:${metric}`;

const mapJobRow = (row: Record<string, unknown>): DomainMetricJob => ({
  id: row.id as string,
  orgId: row.org_id as string,
  userId: (row.user_id as string | null) ?? undefined,
  parentRunId: (row.parent_run_id as string | null) ?? undefined,
  metric: row.metric as DomainMetric,
  domain: row.domain as string,
});

export const enqueueDomainMetricJobs = async (
  pool: Pool,
  metric: DomainMetric,
  domains: string[],
  ctx: OrgContext
): Promise<DomainMetricJob[]> => {
  if (domains.length === 0) return [];

  const result = await pool.query(
    `INSERT INTO domain_metric_compute_jobs (
      metric, domain, status, org_id, user_id, parent_run_id, requested_at, updated_at
    )
    SELECT $1::text, unnest($2::text[]), 'pending', $3::uuid, $4::uuid, $5::uuid,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ON CONFLICT (org_id, metric, domain) DO UPDATE SET
      status = 'pending',
      user_id = EXCLUDED.user_id,
      parent_run_id = EXCLUDED.parent_run_id,
      requested_at = CURRENT_TIMESTAMP,
      started_at = NULL,
      finished_at = NULL,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE domain_metric_compute_jobs.status NOT IN ('pending', 'running')
    RETURNING id, org_id, user_id, parent_run_id, metric, domain`,
    [metric, domains, ctx.orgId, ctx.userId ?? null, ctx.runId ?? null]
  );

  return result.rows.map(mapJobRow);
};

const claimPendingDomainMetricJobs = async (
  pool: Pool,
  metric: DomainMetric,
  orgId: string,
  limit: number
): Promise<DomainMetricJob[]> => {
  const result = await pool.query(
    `WITH claimed AS (
      SELECT id
      FROM domain_metric_compute_jobs
      WHERE metric = $1
        AND org_id = $2::uuid
        AND status = 'pending'
      ORDER BY requested_at ASC
      LIMIT $3
      FOR UPDATE SKIP LOCKED
    )
    UPDATE domain_metric_compute_jobs jobs
    SET status = 'running',
      attempts = attempts + 1,
      started_at = CURRENT_TIMESTAMP,
      finished_at = NULL,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    FROM claimed
    WHERE jobs.id = claimed.id
    RETURNING jobs.id, jobs.org_id, jobs.user_id, jobs.parent_run_id, jobs.metric, jobs.domain`,
    [metric, orgId, limit]
  );

  return result.rows.map(mapJobRow);
};

const markDomainMetricJobsSucceeded = async (
  pool: Pool,
  jobIds: string[]
): Promise<void> => {
  if (jobIds.length === 0) return;
  await pool.query(
    `UPDATE domain_metric_compute_jobs
     SET status = 'succeeded',
       finished_at = CURRENT_TIMESTAMP,
       last_error = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ANY($1::uuid[])`,
    [jobIds]
  );
};

const markDomainMetricJobsFailed = async (
  pool: Pool,
  jobIds: string[],
  error: unknown
): Promise<void> => {
  if (jobIds.length === 0) return;
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `UPDATE domain_metric_compute_jobs
     SET status = 'failed',
       finished_at = CURRENT_TIMESTAMP,
       last_error = $2,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ANY($1::uuid[])`,
    [jobIds, message]
  );
};

export const processDomainMetricJobs = async (
  pool: Pool,
  metric: DomainMetric,
  orgId: string,
  processor: DomainMetricProcessor
): Promise<void> => {
  while (true) {
    const jobs = await claimPendingDomainMetricJobs(pool, metric, orgId, 50);
    if (jobs.length === 0) return;

    const jobIds = jobs.map((job) => job.id);
    try {
      await processor(jobs);
      await markDomainMetricJobsSucceeded(pool, jobIds);
    } catch (error) {
      console.error(
        `[ahref-service] background ${metric} compute failed for ${jobs
          .map((job) => job.domain)
          .join(",")}:`,
        error
      );
      await markDomainMetricJobsFailed(pool, jobIds, error);
    }
  }
};

export const scheduleDomainMetricWorker = (
  pool: Pool,
  metric: DomainMetric,
  orgId: string,
  processor: DomainMetricProcessor
): void => {
  if (!autoStartWorkers) return;

  const key = workerKey(metric, orgId);
  if (activeWorkers.has(key)) return;

  const worker = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      processDomainMetricJobs(pool, metric, orgId, processor)
        .catch((error) => {
          console.error(`[ahref-service] ${metric} compute worker crashed:`, error);
        })
        .finally(() => {
          activeWorkers.delete(key);
          resolve();
        });
    }, 0) as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer.unref?.();
  });

  activeWorkers.set(key, worker);
};

export const waitForDomainMetricWorkersForTest = async (): Promise<void> => {
  await Promise.all([...activeWorkers.values()]);
};

export const setDomainMetricWorkerAutoStartForTest = (enabled: boolean): void => {
  autoStartWorkers = enabled;
};

export const resetDomainMetricWorkersForTest = (): void => {
  activeWorkers.clear();
  autoStartWorkers = true;
};

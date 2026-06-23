import { Pool } from "pg";
import type { OrgContext } from "../middleware/org-context";

export type DomainMetric = "dr" | "traffic";

export interface DomainMetricJob {
  id: string;
  orgId: string;
  userId?: string;
  parentRunId?: string;
  /** Audience attribution carried across the async boundary (campaign flow). */
  audienceId?: string;
  metric: DomainMetric;
  domain: string;
}

type DomainMetricProcessor = (jobs: DomainMetricJob[]) => Promise<void>;

const activeWorkers = new Map<string, Promise<void>>();
let autoStartWorkers = true;

/** Give up retrying a domain after this many claims so a perpetually-hung
 * scrape ends `failed` (last_error set) instead of cycling forever. */
const MAX_ATTEMPTS = 3;
/** A `running` job whose started_at is older than this is treated as orphaned
 * (its worker crashed / the process was redeployed mid-batch) and reclaimed.
 * Must exceed the per-batch ceiling so a legitimately in-flight batch is never
 * reclaimed out from under a live worker. */
const STALE_RUNNING_MS = 20 * 60_000;
let staleRunningMs = STALE_RUNNING_MS;
/** Hard ceiling on one processor batch. A hung scrape or cold-start DB query
 * (own-Neon scale-to-zero resume) fails the batch and frees the worker slot,
 * instead of wedging the queue with no error. Above the Apify 15min run
 * deadline so a legitimately slow scrape is not killed prematurely. */
const BATCH_TIMEOUT_MS = 17 * 60_000;
let batchTimeoutMs = BATCH_TIMEOUT_MS;
/** Reaper cadence WHILE the queue has outstanding work. The reaper stops
 * rescheduling once the queue drains, so it never polls an idle DB (preserves
 * Neon scale-to-zero); the next enqueue / boot re-arms it. */
const REAPER_INTERVAL_MS = 60_000;
let reaperIntervalMs = REAPER_INTERVAL_MS;

/** Processor registry, keyed by metric, populated by the enqueue paths and at
 * boot. The reaper uses it to kick workers for reclaimed / orphaned pending
 * jobs without importing the per-metric compute modules (avoids a cycle). */
const processors = new Map<DomainMetric, DomainMetricProcessor>();
let reaperScheduled = false;

const workerKey = (metric: DomainMetric, orgId: string) => `${orgId}:${metric}`;

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: (ReturnType<typeof setTimeout> & { unref?: () => void }) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[ahref-service] ${label} exceeded ${ms}ms timeout`)),
      ms
    ) as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const mapJobRow = (row: Record<string, unknown>): DomainMetricJob => ({
  id: row.id as string,
  orgId: row.org_id as string,
  userId: (row.user_id as string | null) ?? undefined,
  parentRunId: (row.parent_run_id as string | null) ?? undefined,
  audienceId: (row.audience_id as string | null) ?? undefined,
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
      metric, domain, status, org_id, user_id, parent_run_id, audience_id, requested_at, updated_at
    )
    SELECT $1::text, unnest($2::text[]), 'pending', $3::uuid, $4::uuid, $5::uuid, $6::uuid,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ON CONFLICT (org_id, metric, domain) DO UPDATE SET
      status = 'pending',
      user_id = EXCLUDED.user_id,
      parent_run_id = EXCLUDED.parent_run_id,
      audience_id = EXCLUDED.audience_id,
      requested_at = CURRENT_TIMESTAMP,
      started_at = NULL,
      finished_at = NULL,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE domain_metric_compute_jobs.status NOT IN ('pending', 'running')
    RETURNING id, org_id, user_id, parent_run_id, audience_id, metric, domain`,
    [metric, domains, ctx.orgId, ctx.userId ?? null, ctx.runId ?? null, ctx.audienceId ?? null]
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
    RETURNING jobs.id, jobs.org_id, jobs.user_id, jobs.parent_run_id, jobs.audience_id, jobs.metric, jobs.domain`,
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
      await withTimeout(processor(jobs), batchTimeoutMs, `${metric} compute batch`);
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

/**
 * Register the processor for a metric so the reaper can drain orphaned / pending
 * jobs (process-restart recovery, on-read healing) without a fresh enqueue.
 * Idempotent — the latest registration for a metric wins.
 */
export const registerDomainMetricProcessor = (
  metric: DomainMetric,
  processor: DomainMetricProcessor
): void => {
  processors.set(metric, processor);
};

export interface ReclaimedJob {
  id: string;
  metric: DomainMetric;
  orgId: string;
  status: string;
}

/**
 * Reclaim `running` jobs whose worker died or hung (started_at older than the
 * stale threshold). A job still under the attempt cap is reset to `pending` for
 * retry; one that has exhausted its attempts is marked `failed` with last_error
 * so it frees the slot permanently instead of cycling. The stale threshold sits
 * above the per-batch ceiling, so a legitimately in-flight batch is never
 * reclaimed from under a live worker.
 */
export const reclaimStaleRunningJobs = async (pool: Pool): Promise<ReclaimedJob[]> => {
  const result = await pool.query(
    `UPDATE domain_metric_compute_jobs
     SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
       started_at = NULL,
       finished_at = CASE WHEN attempts >= $2 THEN CURRENT_TIMESTAMP ELSE NULL END,
       last_error = $3,
       updated_at = CURRENT_TIMESTAMP
     WHERE status = 'running'
       AND started_at < CURRENT_TIMESTAMP - make_interval(secs => $1)
     RETURNING id, metric, org_id, status`,
    [
      Math.ceil(staleRunningMs / 1000),
      MAX_ATTEMPTS,
      `reclaimed: running exceeded ${Math.round(staleRunningMs / 60_000)}min stale timeout (orphaned worker)`,
    ]
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    metric: row.metric as DomainMetric,
    orgId: row.org_id as string,
    status: row.status as string,
  }));
};

interface WorkUnit {
  metric: DomainMetric;
  orgId: string;
}

const findPendingWorkUnits = async (pool: Pool): Promise<WorkUnit[]> => {
  const result = await pool.query(
    `SELECT DISTINCT metric, org_id FROM domain_metric_compute_jobs WHERE status = 'pending'`
  );
  return result.rows.map((row) => ({
    metric: row.metric as DomainMetric,
    orgId: row.org_id as string,
  }));
};

const countOutstandingJobs = async (pool: Pool): Promise<number> => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM domain_metric_compute_jobs WHERE status IN ('pending', 'running')`
  );
  return (result.rows[0]?.n as number) ?? 0;
};

/**
 * One recovery pass: reclaim stale `running` jobs, then kick a worker for every
 * (metric, org) that still has pending work (including the just-reclaimed jobs).
 * Safe to call repeatedly — `scheduleDomainMetricWorker` dedupes per org/metric.
 */
export const recoverDomainMetricQueueOnce = async (
  pool: Pool
): Promise<{ reclaimed: number; kicked: number }> => {
  const reclaimed = await reclaimStaleRunningJobs(pool);
  if (reclaimed.length > 0) {
    console.warn(`[ahref-service] reaper reclaimed ${reclaimed.length} stale running job(s)`);
  }

  const units = await findPendingWorkUnits(pool);
  let kicked = 0;
  for (const unit of units) {
    const processor = processors.get(unit.metric);
    if (!processor) continue;
    scheduleDomainMetricWorker(pool, unit.metric, unit.orgId, processor);
    kicked += 1;
  }
  return { reclaimed: reclaimed.length, kicked };
};

const runReaperTick = async (pool: Pool): Promise<void> => {
  try {
    await recoverDomainMetricQueueOnce(pool);
  } catch (error) {
    console.error("[ahref-service] domain-metric reaper tick failed:", error);
  }

  let outstanding = 0;
  try {
    outstanding = await countOutstandingJobs(pool);
  } catch (error) {
    console.error("[ahref-service] domain-metric reaper outstanding-count failed:", error);
    // Stop rescheduling on a count error to avoid a hot loop; the next enqueue
    // re-arms the reaper.
    reaperScheduled = false;
    return;
  }

  if (outstanding > 0 && autoStartWorkers) {
    const timer = setTimeout(() => {
      void runReaperTick(pool);
    }, reaperIntervalMs) as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer.unref?.();
  } else {
    // Queue drained → stop polling so the Neon compute can scale to zero. The
    // next enqueue (or boot) re-arms the reaper via ensureDomainMetricReaper.
    reaperScheduled = false;
  }
};

/**
 * Arm the self-rescheduling reaper. Runs an immediate recovery pass, then keeps
 * ticking while the queue has outstanding work and stops once it drains. Called
 * at boot (drains the backlog a prior restart orphaned) and on every enqueue
 * (on-read healing). No-op if a reaper is already armed.
 */
export const ensureDomainMetricReaper = (pool: Pool): void => {
  if (!autoStartWorkers) return;
  if (reaperScheduled) return;
  reaperScheduled = true;
  const timer = setTimeout(() => {
    void runReaperTick(pool);
  }, 0) as ReturnType<typeof setTimeout> & { unref?: () => void };
  timer.unref?.();
};

export const waitForDomainMetricWorkersForTest = async (): Promise<void> => {
  await Promise.all([...activeWorkers.values()]);
};

export const setDomainMetricWorkerAutoStartForTest = (enabled: boolean): void => {
  autoStartWorkers = enabled;
};

export const setDomainMetricBatchTimeoutForTest = (ms: number): void => {
  batchTimeoutMs = ms;
};

export const setDomainMetricStaleRunningMsForTest = (ms: number): void => {
  staleRunningMs = ms;
};

export const resetDomainMetricWorkersForTest = (): void => {
  activeWorkers.clear();
  autoStartWorkers = true;
  processors.clear();
  reaperScheduled = false;
  batchTimeoutMs = BATCH_TIMEOUT_MS;
  staleRunningMs = STALE_RUNNING_MS;
  reaperIntervalMs = REAPER_INTERVAL_MS;
};

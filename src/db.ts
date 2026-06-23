import net from "net";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

// Neon scale-to-zero: the FIRST connection after an idle suspend lands while the
// compute is still resuming (~1-7s). Node 20's happy-eyeballs gives each address
// only 250ms, so the connect fails with AggregateError [ETIMEDOUT] before the
// wake completes. Widen the per-attempt window so a cold resume connects instead
// of throwing. (Documented fleet fix — postmark/stripe/google reference impl.)
net.setDefaultAutoSelectFamilyAttemptTimeout?.(5_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Connect-phase failures from a resuming Neon compute. The query never
// dispatched, so retrying is write-safe. Covers the pg CLIENT-level
// "timeout expired" AND the POOL-level "timeout exceeded when trying to connect".
const TRANSIENT = /ETIMEDOUT|ECONNREFUSED|ECONNRESET|timeout expired|timeout exceeded when trying to connect/i;

const isTransientConnectError = (err: unknown): boolean => {
  const seen = new Set<unknown>();
  const walk = (e: unknown): boolean => {
    if (!e || seen.has(e)) return false;
    seen.add(e);
    const code = (e as { code?: string }).code;
    if (code && TRANSIENT.test(code)) return true;
    const message = (e as { message?: string }).message;
    if (message && TRANSIENT.test(message)) return true;
    const cause = (e as { cause?: unknown }).cause;
    if (cause && walk(cause)) return true;
    const errors = (e as { errors?: unknown[] }).errors;
    if (Array.isArray(errors) && errors.some(walk)) return true;
    return false;
  };
  return walk(err);
};

let pool: Pool | null = null;

const installRetry = (p: Pool): Pool => {
  const original = p.query.bind(p) as (...args: unknown[]) => Promise<QueryResult>;
  const retrying = async <R extends QueryResultRow = QueryResultRow>(
    ...args: unknown[]
  ): Promise<QueryResult<R>> => {
    let delay = 250;
    for (let attempt = 0; ; attempt++) {
      try {
        return (await original(...args)) as QueryResult<R>;
      } catch (err) {
        if (attempt >= 3 || !isTransientConnectError(err)) throw err;
        await sleep(delay);
        delay *= 2;
      }
    }
  };
  // Preserve the pg `query` overloads for callers; the retry wrapper is a
  // transparent drop-in (only connect-phase transient errors are retried).
  (p as unknown as { query: typeof retrying }).query = retrying;
  return p;
};

export const getPool = (): Pool => {
  if (!pool) {
    pool = installRetry(
      new Pool({
        connectionString: process.env.AHREF_SERVICE_DATABASE_URL,
        // Bound the connect phase so a cold resume fails fast into the retry
        // wrapper instead of hanging the worker indefinitely (no timeout = hang).
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        keepAlive: true,
        // Headroom for parallel scrape loops (WORKER_CONCURRENCY per active
        // org/metric) + the reaper, each running its own claim/persist/mark.
        max: 20,
      })
    );
  }
  return pool;
};

export const setPool = (p: Pool): void => {
  pool = p;
};

export const closePool = async (): Promise<void> => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};

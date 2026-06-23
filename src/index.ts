import { createApp } from "./app";
import { getConfig } from "./config";
import { getPool } from "./db";
import {
  ensureDomainMetricReaper,
  registerDomainMetricProcessor,
} from "./services/domain-metric-jobs";
import { processOrgDrJobs } from "./services/dr-compute";
import { processOrgTrafficJobs } from "./services/traffic-compute";

const start = async () => {
  const config = getConfig();

  // Run migrations on startup
  const { runMigrations } = await import("./migrate");
  await runMigrations(getPool());

  const app = createApp({
    apiKey: config.AHREF_SERVICE_API_KEY,
  });

  app.listen(config.PORT, () => {
    console.log(`ahref-service listening on port ${config.PORT}`);

    // Boot recovery (post-listen, fire-and-forget so it never blocks port-bind):
    // a prior crash / redeploy can leave `running` jobs orphaned and `pending`
    // jobs with no live worker. Register both processors, then arm the reaper to
    // reclaim stale-running jobs and kick a worker for every org with pending
    // work. The reaper self-stops once the queue drains, so it never keeps the
    // Neon compute awake when idle.
    const pool = getPool();
    registerDomainMetricProcessor("dr", (jobs) => processOrgDrJobs(pool, jobs));
    registerDomainMetricProcessor("traffic", (jobs) => processOrgTrafficJobs(pool, jobs));
    ensureDomainMetricReaper(pool);
  });
};

start().catch((err) => {
  console.error("Failed to start ahref-service:", err);
  process.exit(1);
});

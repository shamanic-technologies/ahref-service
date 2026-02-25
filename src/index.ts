import { createApp } from "./app";
import { getConfig } from "./config";
import { getPool } from "./db";

const start = async () => {
  const config = getConfig();

  // Run migrations on startup
  const { runMigrations } = await import("./migrate");
  await runMigrations(getPool());

  const app = createApp({
    apiKey: config.AHREF_SERVICE_API_KEY,
    outletsServiceUrl: config.OUTLETS_SERVICE_URL,
    outletsServiceApiKey: config.OUTLETS_SERVICE_API_KEY,
  });

  app.listen(config.PORT, () => {
    console.log(`ahref-service listening on port ${config.PORT}`);
  });
};

start().catch((err) => {
  console.error("Failed to start ahref-service:", err);
  process.exit(1);
});

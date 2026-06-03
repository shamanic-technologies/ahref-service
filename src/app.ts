import express from "express";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { authMiddleware } from "./middleware/auth";
import { requireOrgId } from "./middleware/org-context";
import { healthRouter } from "./routes/health";
import { createOrgsOutletsRouter } from "./routes/orgs-outlets";
import { createInternalOutletsRouter } from "./routes/internal-outlets";

export interface AppConfig {
  apiKey: string;
  outletsServiceUrl: string;
  outletsServiceApiKey: string;
}

export const createApp = (config: AppConfig) => {
  const app = express();

  app.use(express.json());

  // Public routes — no auth
  app.use(healthRouter);

  app.get("/openapi.json", (_req, res) => {
    const specPath = join(__dirname, "..", "openapi.json");
    if (!existsSync(specPath)) {
      res.status(404).json({ error: "OpenAPI spec not found" });
      return;
    }
    const spec = JSON.parse(readFileSync(specPath, "utf-8"));
    res.json(spec);
  });

  // All remaining routes require the service API key
  app.use(authMiddleware(config.apiKey));

  // Internal tier — API key only, no org context (platform / cron / ingestion)
  app.use("/internal/outlets", createInternalOutletsRouter());

  // Org tier — API key + x-org-id required
  app.use(
    "/orgs/outlets",
    requireOrgId,
    createOrgsOutletsRouter({
      baseUrl: config.outletsServiceUrl,
      apiKey: config.outletsServiceApiKey,
    })
  );

  return app;
};

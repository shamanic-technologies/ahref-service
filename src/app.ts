import express from "express";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { authMiddleware } from "./middleware/auth";
import { healthRouter } from "./routes/health";
import { createOutletsRouter } from "./routes/outlets";

export interface AppConfig {
  apiKey: string;
  outletsServiceUrl: string;
  outletsServiceApiKey: string;
}

export const createApp = (config: AppConfig) => {
  const app = express();

  app.use(express.json());

  // Health check — no auth
  app.use(healthRouter);

  // OpenAPI spec — no auth
  app.get("/openapi.json", (_req, res) => {
    const specPath = join(__dirname, "..", "openapi.json");
    if (!existsSync(specPath)) {
      res.status(404).json({ error: "OpenAPI spec not found" });
      return;
    }
    const spec = JSON.parse(readFileSync(specPath, "utf-8"));
    res.json(spec);
  });

  // Auth-protected routes
  app.use(
    authMiddleware(config.apiKey),
    createOutletsRouter({
      baseUrl: config.outletsServiceUrl,
      apiKey: config.outletsServiceApiKey,
    })
  );

  return app;
};

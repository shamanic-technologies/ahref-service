import { Router, Request, Response } from "express";
import { getPool } from "../db";
import { drComputeBodySchema, updateDomainRatingBodySchema } from "../schemas/apify-ahref";
import { computeMissingPlatformDr } from "../services/dr-compute";
import {
  getDrStale,
  getLowDomainRating,
  updateDomainRating,
} from "../services/ahref";

/**
 * Internal routes — mounted at /internal/domains (x-api-key only, no org
 * context). These are platform/cron/worker operations: the "needs refresh"
 * list, the low-DR list, and the scraped-data ingestion.
 *
 * Keyed entirely by domain. "dr-stale" means domains we ALREADY hold data for
 * that have now gone stale — the universe of domains-to-track lives with the
 * caller, not here.
 */
export const createInternalDomainsRouter = () => {
  const router = Router();

  // GET /internal/domains/dr-stale — known domains whose DR needs a refresh
  router.get("/dr-stale", async (_req: Request, res: Response) => {
    try {
      const result = await getDrStale(getPool());
      res.json(result);
    } catch (error) {
      console.error("[ahref-service] Error fetching stale DR:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /internal/domains/low-domain-rating — known domains with DR < 10
  router.get("/low-domain-rating", async (_req: Request, res: Response) => {
    try {
      const result = await getLowDomainRating(getPool());
      res.json(result);
    } catch (error) {
      console.error("[ahref-service] Error fetching low DR domains:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /internal/domains/dr-compute — platform/service-auth DR compute for
  // backend callers without org identity. Scrapes only domains the ahref cache
  // marks missing/stale; fresh cached domains are returned without spend.
  router.post("/dr-compute", async (req: Request, res: Response) => {
    const parsed = drComputeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    try {
      const result = await computeMissingPlatformDr(getPool(), parsed.data.domains);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("normalizeDomain")) {
        res.status(400).json({ error: message });
        return;
      }
      console.error("[ahref-service] Error computing platform DR:", error);
      res.status(502).json({ error: "Failed to compute platform DR", detail: message });
    }
  });

  // POST /internal/domains/domain-rating — ingest scraped Ahrefs data.
  // The domain is the cache key; it comes from the body (required) and is
  // normalized before storage.
  router.post("/domain-rating", async (req: Request, res: Response) => {
    try {
      const parsed = updateDomainRatingBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "Invalid body", details: parsed.error.issues });
        return;
      }

      const result = await updateDomainRating(getPool(), parsed.data);
      res.status(201).json(result);
    } catch (error) {
      // normalizeDomain throws on an unusable domain → 400, not 500.
      if (error instanceof Error && error.message.includes("normalizeDomain")) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error("[ahref-service] Error storing domain rating:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};

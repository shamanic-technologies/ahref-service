import { Router, Request, Response } from "express";
import { z } from "zod";
import { getPool } from "../db";
import { updateDomainRatingBodySchema } from "../schemas/apify-ahref";
import {
  getDrStale,
  getLowDomainRating,
  updateDomainRating,
} from "../services/ahref";

/**
 * Internal routes — mounted at /internal/outlets (x-api-key only, no org
 * context). These are platform/cron/worker operations: the global "needs
 * refresh" list, the global low-DR list, and the scraped-data ingestion.
 */
export const createInternalOutletsRouter = () => {
  const router = Router();

  // GET /internal/outlets/dr-stale — all outlets that need a DR refresh
  router.get("/dr-stale", async (_req: Request, res: Response) => {
    try {
      const result = await getDrStale(getPool());
      res.json(result);
    } catch (error) {
      console.error("[ahref-service] Error fetching stale DR:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /internal/outlets/low-domain-rating — all outlets with DR < 10
  router.get("/low-domain-rating", async (_req: Request, res: Response) => {
    try {
      const result = await getLowDomainRating(getPool());
      res.json(result);
    } catch (error) {
      console.error("[ahref-service] Error fetching low DR outlets:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /internal/outlets/:outletId/domain-rating — ingest scraped Ahrefs data
  router.patch(
    "/:outletId/domain-rating",
    async (req: Request, res: Response) => {
      try {
        const { outletId } = req.params;
        const uuidSchema = z.string().uuid();
        if (!uuidSchema.safeParse(outletId).success) {
          res.status(400).json({ error: "Invalid outlet ID" });
          return;
        }

        const parsed = updateDomainRatingBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid body", details: parsed.error.issues });
          return;
        }

        const result = await updateDomainRating(
          getPool(),
          outletId,
          parsed.data
        );
        res.status(201).json(result);
      } catch (error) {
        console.error("[ahref-service] Error updating domain rating:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  return router;
};

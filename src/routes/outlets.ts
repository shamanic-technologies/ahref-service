import { Router, Request, Response } from "express";
import { z } from "zod";
import { getPool } from "../db";
import { updateDomainRatingBodySchema } from "../schemas/apify-ahref";
import {
  getDrStatus,
  getDrStale,
  getLowDomainRating,
  updateDomainRating,
} from "../services/ahref";
import { createOutletsClient } from "../services/outlets-client";
import { extractIdentity } from "../middleware/identity";

export const createOutletsRouter = (outletsConfig: {
  baseUrl: string;
  apiKey: string;
}) => {
  const router = Router();
  const outletsClient = createOutletsClient(outletsConfig);

  // GET /outlets/dr-status?outletIds=id1,id2,...
  router.get("/outlets/dr-status", async (req: Request, res: Response) => {
    try {
      const raw = req.query.outletIds;
      if (!raw || typeof raw !== "string") {
        res.status(400).json({ error: "outletIds query parameter is required" });
        return;
      }

      const outletIds = raw.split(",").map((id) => id.trim()).filter(Boolean);

      const uuidSchema = z.string().uuid();
      for (const id of outletIds) {
        if (!uuidSchema.safeParse(id).success) {
          res.status(400).json({ error: `Invalid UUID: ${id}` });
          return;
        }
      }

      const result = await getDrStatus(getPool(), outletIds);
      res.json(result);
    } catch (error) {
      console.error("Error fetching DR status:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /outlets/dr-stale
  router.get("/outlets/dr-stale", async (_req: Request, res: Response) => {
    try {
      const result = await getDrStale(getPool());
      res.json(result);
    } catch (error) {
      console.error("Error fetching stale DR:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /outlets/:outletId/domain-rating
  router.patch(
    "/outlets/:outletId/domain-rating",
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
          res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
          return;
        }

        const identity = extractIdentity(req);
        const result = await updateDomainRating(getPool(), outletId, parsed.data, identity);
        res.status(201).json(result);
      } catch (error) {
        console.error("Error updating domain rating:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  // GET /outlets/low-domain-rating
  router.get("/outlets/low-domain-rating", async (_req: Request, res: Response) => {
    try {
      const result = await getLowDomainRating(getPool());
      res.json(result);
    } catch (error) {
      console.error("Error fetching low DR outlets:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /outlets/campaign-categories-dr-status?campaignId=uuid
  router.get(
    "/outlets/campaign-categories-dr-status",
    async (req: Request, res: Response) => {
      try {
        const campaignId = req.query.campaignId;
        if (!campaignId || typeof campaignId !== "string") {
          res.status(400).json({ error: "campaignId query parameter is required" });
          return;
        }

        const uuidSchema = z.string().uuid();
        if (!uuidSchema.safeParse(campaignId).success) {
          res.status(400).json({ error: "Invalid campaignId" });
          return;
        }

        const outletIds = await outletsClient.getOutletsByCampaign(campaignId);

        if (outletIds.length === 0) {
          res.json([]);
          return;
        }

        const result = await getDrStatus(getPool(), outletIds);
        res.json(result);
      } catch (error) {
        console.error("Error fetching campaign DR status:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  return router;
};

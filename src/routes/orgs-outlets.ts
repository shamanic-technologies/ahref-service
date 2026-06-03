import { Router, Request, Response } from "express";
import { z } from "zod";
import { getPool } from "../db";
import { getDrStatus } from "../services/ahref";
import { createOutletsClient } from "../services/outlets-client";
import { getOrgContext } from "../middleware/org-context";

/**
 * Org-scoped routes — mounted at /orgs/outlets (requires x-api-key + x-org-id).
 * These are the lookups an org's dashboard / workflow performs. The DR data
 * itself is global reference data (a domain's rating is not org-specific), so
 * the org context is used for auth + downstream forwarding, not row filtering.
 */
export const createOrgsOutletsRouter = (outletsConfig: {
  baseUrl: string;
  apiKey: string;
}) => {
  const router = Router();
  const outletsClient = createOutletsClient(outletsConfig);

  // GET /orgs/outlets/dr-status?outletIds=id1,id2,...
  router.get("/dr-status", async (req: Request, res: Response) => {
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
      console.error("[ahref-service] Error fetching DR status:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /orgs/outlets/campaign-categories-dr-status?campaignId=uuid
  router.get(
    "/campaign-categories-dr-status",
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

        const ctx = getOrgContext(req);
        const outletIds = await outletsClient.getOutletsByCampaign(
          campaignId,
          ctx
        );

        if (outletIds.length === 0) {
          res.json([]);
          return;
        }

        const result = await getDrStatus(getPool(), outletIds);
        res.json(result);
      } catch (error) {
        console.error(
          "[ahref-service] Error fetching campaign DR status:",
          error
        );
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  return router;
};

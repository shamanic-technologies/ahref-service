import { Router, Request, Response } from "express";
import { getPool } from "../db";
import { getDrStatus } from "../services/ahref";
import { computeDr } from "../services/dr-compute";
import { drComputeBodySchema } from "../schemas/apify-ahref";
import { normalizeDomain } from "../lib/domain";

/**
 * Org-scoped routes — mounted at /orgs/domains (requires x-api-key + x-org-id).
 * DR/traffic data is global reference data keyed by domain (a domain's rating
 * is not org-specific), so the org context is used for auth, not row filtering.
 *
 * This service is domain-centric and has NO knowledge of outlets, campaigns,
 * brands, or journalism — callers resolve their own entities to domains and ask
 * about domains.
 */
export const createOrgsDomainsRouter = () => {
  const router = Router();

  // GET /orgs/domains/dr-status?domains=a.com,b.com,...
  router.get("/dr-status", async (req: Request, res: Response) => {
    try {
      const raw = req.query.domains;
      if (!raw || typeof raw !== "string") {
        res.status(400).json({ error: "domains query parameter is required" });
        return;
      }

      const inputs = raw.split(",").map((d) => d.trim()).filter(Boolean);
      if (inputs.length === 0) {
        res.status(400).json({ error: "domains query parameter is required" });
        return;
      }

      let domains: string[];
      try {
        // Normalize + dedupe so www/non-www and casing collapse to one key.
        domains = [...new Set(inputs.map(normalizeDomain))];
      } catch (err) {
        res
          .status(400)
          .json({ error: err instanceof Error ? err.message : "Invalid domain" });
        return;
      }

      const result = await getDrStatus(getPool(), domains);
      res.json(result);
    } catch (error) {
      console.error("[ahref-service] Error fetching DR status:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /orgs/domains/dr-compute — on-demand: scrape Ahrefs (DR) for the given
  // domains via Apify, declare cost + authorize, persist, return the DR. This is
  // the only metered/spending endpoint; dr-status stays a pure read.
  router.post("/dr-compute", async (req: Request, res: Response) => {
    const parsed = drComputeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    try {
      const result = await computeDr(getPool(), parsed.data.domains, req.orgContext!);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An unusable domain is a client error (400); everything else is a
      // downstream / cost / scrape failure → fail loud as 502.
      if (message.includes("normalizeDomain")) {
        res.status(400).json({ error: message });
        return;
      }
      console.error("[ahref-service] Error computing DR:", error);
      res.status(502).json({ error: "Failed to compute DR", detail: message });
    }
  });

  return router;
};

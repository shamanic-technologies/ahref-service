import { Router, Request, Response } from "express";
import { getPool } from "../db";
import { getDrStatus, getTrafficHistory } from "../services/ahref";
import { computeDr } from "../services/dr-compute";
import { computeTraffic } from "../services/traffic-compute";
import {
  getAiVisibilityCached,
  getOrComputeAiVisibility,
} from "../services/ai-visibility";
import {
  drComputeBodySchema,
  trafficComputeBodySchema,
  aiVisibilityBodySchema,
} from "../schemas/apify-ahref";
import { normalizeDomainsSkippingInvalid } from "../lib/domain";

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

      // Pure read: skip invalid entries (e.g. a "-" placeholder) instead of
      // failing the whole batch. Normalize + dedupe so www/non-www and casing
      // collapse to one key.
      const { domains, skipped } = normalizeDomainsSkippingInvalid(inputs);
      if (skipped.length > 0) {
        console.warn(
          `[ahref-service] dr-status: skipping invalid domain(s): ${skipped.join(", ")}`
        );
      }
      if (domains.length === 0) {
        res.status(400).json({ error: "no valid domain in domains query parameter" });
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

  // GET /orgs/domains/traffic-history?domains=a.com,b.com,...
  // Pure read of the traffic silver/gold: latest snapshot + monthly organic
  // series per domain. No spend.
  router.get("/traffic-history", async (req: Request, res: Response) => {
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

      // Pure read: skip invalid entries (e.g. a "-" placeholder) instead of
      // failing the whole batch. Normalize + dedupe so www/non-www and casing
      // collapse to one key.
      const { domains, skipped } = normalizeDomainsSkippingInvalid(inputs);
      if (skipped.length > 0) {
        console.warn(
          `[ahref-service] traffic-history: skipping invalid domain(s): ${skipped.join(", ")}`
        );
      }
      if (domains.length === 0) {
        res.status(400).json({ error: "no valid domain in domains query parameter" });
        return;
      }

      const result = await getTrafficHistory(getPool(), domains);
      res.json(result);
    } catch (error) {
      console.error("[ahref-service] Error fetching traffic history:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /orgs/domains/traffic-compute — on-demand: scrape Ahrefs traffic for
  // the given domains via Apify, declare cost + authorize, persist (bronze +
  // silver), return the monthly series. Metered/spending — mirrors dr-compute.
  router.post("/traffic-compute", async (req: Request, res: Response) => {
    const parsed = trafficComputeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    try {
      const result = await computeTraffic(getPool(), parsed.data.domains, req.orgContext!);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An unusable domain is a client error (400); everything else is a
      // downstream / cost / scrape failure → fail loud as 502.
      if (message.includes("normalizeDomain")) {
        res.status(400).json({ error: message });
        return;
      }
      console.error("[ahref-service] Error computing traffic:", error);
      res.status(502).json({ error: "Failed to compute traffic", detail: message });
    }
  });

  // GET /orgs/domains/ai-visibility?domains=a.com,b.com,...
  // Pure read of the AI-visibility cache: the latest Brand-Radar snapshot per
  // domain (lean shape, no `raw`). No Apify scrape, no cost — mirrors dr-status
  // / traffic-history. The POST on this same path owns the metered refresh.
  router.get("/ai-visibility", async (req: Request, res: Response) => {
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

      // Pure read: skip invalid entries (e.g. a "-" placeholder) instead of
      // failing the whole batch. Normalize + dedupe so www/non-www and casing
      // collapse to one key.
      const { domains, skipped } = normalizeDomainsSkippingInvalid(inputs);
      if (skipped.length > 0) {
        console.warn(
          `[ahref-service] ai-visibility: skipping invalid domain(s): ${skipped.join(", ")}`
        );
      }
      if (domains.length === 0) {
        res.status(400).json({ error: "no valid domain in domains query parameter" });
        return;
      }

      const result = await getAiVisibilityCached(getPool(), domains);
      res.json(result);
    } catch (error) {
      console.error("[ahref-service] Error fetching AI-visibility cache:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /orgs/domains/ai-visibility — get-or-refresh Ahrefs Brand-Radar
  // AI-visibility stats for a domain: return the cached snapshot if fresh, else
  // scrape via Apify (declares cost + authorizes) and resolve competitor brands.
  router.post("/ai-visibility", async (req: Request, res: Response) => {
    const parsed = aiVisibilityBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
      return;
    }

    try {
      const result = await getOrComputeAiVisibility(
        getPool(),
        parsed.data.domain,
        req.orgContext!
      );
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An unusable domain is a client error (400); everything else is a
      // downstream / cost / scrape / brand-resolve failure → fail loud as 502
      // (distinguishable from a true zero-mention result, which is a 200).
      if (message.includes("normalizeDomain")) {
        res.status(400).json({ error: message });
        return;
      }
      console.error("[ahref-service] Error computing AI-visibility:", error);
      res.status(502).json({ error: "Failed to compute AI-visibility", detail: message });
    }
  });

  return router;
};

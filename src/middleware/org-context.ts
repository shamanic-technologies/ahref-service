import { Request, Response, NextFunction } from "express";

/**
 * Org context extracted from identity headers on /orgs/* routes.
 * Only orgId is guaranteed (enforced by requireOrgId). All other headers are
 * optional — parsed if present, ignored if absent. Matches the platform-wide
 * convention (see outlets-service, brand-service, lead-service).
 */
export interface OrgContext {
  orgId: string;
  userId?: string;
  runId?: string;
  campaignId?: string;
  brandIds: string[];
  featureSlug?: string;
  workflowSlug?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      orgContext?: OrgContext;
    }
  }
}

/**
 * Middleware for /orgs/* routes. Requires x-org-id (presence only — the caller
 * already resolved it to an internal UUID via client-service). Parses every
 * other identity header as optional.
 */
export const requireOrgId = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    res.status(400).json({ error: "Missing required header: x-org-id" });
    return;
  }

  const rawBrandId = req.headers["x-brand-id"] as string | undefined;
  const brandIds = String(rawBrandId ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  req.orgContext = {
    orgId,
    userId: (req.headers["x-user-id"] as string | undefined) || undefined,
    runId: (req.headers["x-run-id"] as string | undefined) || undefined,
    campaignId:
      (req.headers["x-campaign-id"] as string | undefined) || undefined,
    brandIds,
    featureSlug:
      (req.headers["x-feature-slug"] as string | undefined) || undefined,
    workflowSlug:
      (req.headers["x-workflow-slug"] as string | undefined) || undefined,
  };
  next();
};

export const getOrgContext = (req: Request): OrgContext => {
  const ctx = req.orgContext;
  if (!ctx) {
    throw new Error(
      "[ahref-service] getOrgContext called without requireOrgId middleware"
    );
  }
  return ctx;
};

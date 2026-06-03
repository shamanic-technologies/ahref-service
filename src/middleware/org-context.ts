import { Request, Response, NextFunction } from "express";

/**
 * Org context for /orgs/* routes. DR/traffic data is global reference data, so
 * the org context exists only for auth + traceability — it never filters rows.
 * Only generic platform identity is carried; this service has no campaign /
 * brand / outlet concept.
 */
export interface OrgContext {
  orgId: string;
  userId?: string;
  runId?: string;
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
 * already resolved it to an internal UUID via client-service). Parses user/run
 * identity as optional.
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

  req.orgContext = {
    orgId,
    userId: (req.headers["x-user-id"] as string | undefined) || undefined,
    runId: (req.headers["x-run-id"] as string | undefined) || undefined,
  };
  next();
};

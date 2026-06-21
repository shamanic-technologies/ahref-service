import type { OrgContext } from "../middleware/org-context";

/**
 * Build standard forwarding headers for downstream service calls.
 * Single source of truth — all service clients must use this.
 *
 * `overrideRunId` lets a caller send this service's OWN run id as `x-run-id`
 * (per the run-tracking convention: overwrite x-run-id with our own run before
 * downstream calls). When omitted, the inbound caller's run id is forwarded —
 * used at child-run creation so runs-service sets it as the parent.
 */
export function buildServiceHeaders(
  apiKey: string,
  ctx: OrgContext,
  overrideRunId?: string
): Record<string, string> {
  const runId = overrideRunId ?? ctx.runId;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (runId) headers["x-run-id"] = runId;
  // Forward audience attribution so runs-service tags the run (and, by
  // COALESCE inheritance, its cost rows) for per-audience cost attribution.
  // Only reaches internal services that use this builder — vendor calls
  // (Ahrefs, Apify) build headers inline, so no internal-header egress leak.
  if (ctx.audienceId) headers["x-audience-id"] = ctx.audienceId;
  return headers;
}

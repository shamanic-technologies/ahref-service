import type { OrgContext } from "../middleware/org-context";

export interface OutletsClientConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Build forwarding headers for the outlets-service call. Forwards the full
 * identity context (convention: forward all received headers downstream), not
 * just the API key.
 */
const buildHeaders = (
  apiKey: string,
  ctx: OrgContext
): Record<string, string> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  if (ctx.campaignId) headers["x-campaign-id"] = ctx.campaignId;
  if (ctx.brandIds.length > 0) headers["x-brand-id"] = ctx.brandIds.join(",");
  if (ctx.featureSlug) headers["x-feature-slug"] = ctx.featureSlug;
  if (ctx.workflowSlug) headers["x-workflow-slug"] = ctx.workflowSlug;
  return headers;
};

export const createOutletsClient = (config: OutletsClientConfig) => {
  return {
    getOutletsByCampaign: async (
      campaignId: string,
      ctx: OrgContext
    ): Promise<string[]> => {
      const res = await fetch(
        `${config.baseUrl}/internal/outlets?campaignId=${campaignId}`,
        { headers: buildHeaders(config.apiKey, ctx) }
      );
      if (!res.ok) {
        throw new Error(
          `outlets-service responded with ${res.status}: ${await res.text()}`
        );
      }
      const data = (await res.json()) as {
        outlets: Array<{ id: string }>;
      };
      return data.outlets.map((o) => o.id);
    },
  };
};

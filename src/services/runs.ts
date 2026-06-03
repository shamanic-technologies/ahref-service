import { getDownstreamConfig } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

const SERVICE_NAME = "ahref-service";
const TIMEOUT_MS = 30_000;

export type CostStatus = "actual" | "provisioned" | "cancelled";
export type CostSource = "platform" | "org";

export interface CostItem {
  costName: string;
  costSource: CostSource;
  quantity: number;
  status: CostStatus;
  idempotencyKey?: string;
}

const post = async (url: string, body: unknown, headers: Record<string, string>) => {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[ahref-service] runs-service POST ${url} timed out after ${TIMEOUT_MS}ms`);
    }
    throw new Error(
      `[ahref-service] runs-service POST ${url} fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[ahref-service] runs-service POST ${url} failed (${res.status}): ${text}`);
  }
  return res.json();
};

/**
 * Create this service's own run for the DR-compute request. The inbound
 * caller's run id (ctx.runId) is forwarded as x-run-id, so runs-service links
 * the new run as its child (parent_run_id).
 */
export const createChildRun = async (taskName: string, ctx: OrgContext): Promise<string> => {
  const { runsServiceUrl, runsServiceApiKey } = getDownstreamConfig();
  const data = (await post(
    `${runsServiceUrl}/v1/runs`,
    { serviceName: SERVICE_NAME, taskName },
    buildServiceHeaders(runsServiceApiKey, ctx)
  )) as { id: string };
  return data.id;
};

/** Add a single cost line item to a run. Returns the created cost id. */
export const addCost = async (
  runId: string,
  item: CostItem,
  ctx: OrgContext
): Promise<string> => {
  const { runsServiceUrl, runsServiceApiKey } = getDownstreamConfig();
  const data = (await post(
    `${runsServiceUrl}/v1/runs/${runId}/costs`,
    { items: [item] },
    buildServiceHeaders(runsServiceApiKey, ctx, runId)
  )) as { costs: Array<{ id: string }> };
  return data.costs[0].id;
};

/** PATCH a cost item's status (provisioned → actual / cancelled). */
export const setCostStatus = async (
  runId: string,
  costId: string,
  status: CostStatus,
  ctx: OrgContext
): Promise<void> => {
  const { runsServiceUrl, runsServiceApiKey } = getDownstreamConfig();
  const url = `${runsServiceUrl}/v1/runs/${runId}/costs/${costId}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PATCH",
      headers: buildServiceHeaders(runsServiceApiKey, ctx, runId),
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `[ahref-service] runs-service PATCH ${url} fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[ahref-service] runs-service PATCH ${url} failed (${res.status}): ${text}`);
  }
};

/** Close this service's own run. */
export const closeRun = async (
  runId: string,
  status: "completed" | "failed",
  ctx: OrgContext
): Promise<void> => {
  const { runsServiceUrl, runsServiceApiKey } = getDownstreamConfig();
  const url = `${runsServiceUrl}/v1/runs/${runId}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PATCH",
      headers: buildServiceHeaders(runsServiceApiKey, ctx, runId),
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `[ahref-service] runs-service PATCH ${url} fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[ahref-service] runs-service PATCH ${url} failed (${res.status}): ${text}`);
  }
};

import { getDownstreamConfig } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

const TIMEOUT_MS = 30_000;

export interface AuthorizeItem {
  costName: string;
  quantity: number;
}

/**
 * Pre-execution affordability check for platform-key spend (the Apify scrape
 * is paid with our platform Apify key, so the org's balance must cover it).
 * Fail-loud: a non-2xx response OR `sufficient:false` throws, blocking the
 * scrape before any spend.
 */
export const authorize = async (
  items: AuthorizeItem[],
  description: string,
  runId: string,
  ctx: OrgContext
): Promise<void> => {
  const { billingServiceUrl, billingServiceApiKey } = getDownstreamConfig();
  const url = `${billingServiceUrl}/v1/customer_balance/authorize`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: buildServiceHeaders(billingServiceApiKey, ctx, runId),
      body: JSON.stringify({ items, description }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[ahref-service] billing-service authorize timed out after ${TIMEOUT_MS}ms`);
    }
    throw new Error(
      `[ahref-service] billing-service authorize fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[ahref-service] billing-service authorize failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    sufficient: boolean;
    balance_cents: string;
    required_cents: string;
  };
  if (!data.sufficient) {
    throw new Error(
      `[ahref-service] billing-service authorize: insufficient balance (balance=${data.balance_cents}¢, required=${data.required_cents}¢)`
    );
  }
};

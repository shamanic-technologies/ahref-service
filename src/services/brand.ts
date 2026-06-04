import { getBrandServiceConfig } from "../config";

const TIMEOUT_MS = 30_000;

export interface ResolvedBrand {
  brandId: string;
  domain: string | null;
  name: string | null;
}

/**
 * Resolve a batch of domains to GLOBAL brand identities via brand-service.
 *
 * Calls the internal (API-key only, no org) resolve endpoint, which upserts the
 * global brand row per domain WITHOUT claiming it for any org and WITHOUT
 * scraping — so this carries no metered cost and no org-pollution. brandId is
 * global, so the resolved value is valid for every org reading the cache.
 *
 * Fail-loud: any non-2xx throws (→ 502 at the route). Domains brand-service
 * cannot parse are simply omitted from its response (handled by the caller).
 */
export const resolveBrandsByDomain = async (
  domains: string[]
): Promise<ResolvedBrand[]> => {
  if (domains.length === 0) return [];

  const { brandServiceUrl, brandServiceApiKey } = getBrandServiceConfig();
  const url = `${brandServiceUrl}/internal/brands/resolve-by-domain`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": brandServiceApiKey,
      },
      body: JSON.stringify({ domains }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `[ahref-service] brand-service resolve-by-domain timed out after ${TIMEOUT_MS}ms`
      );
    }
    throw new Error(
      `[ahref-service] brand-service resolve-by-domain fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[ahref-service] brand-service resolve-by-domain failed (${res.status}): ${text}`
    );
  }

  const data = (await res.json()) as { brands?: ResolvedBrand[] };
  return data.brands ?? [];
};

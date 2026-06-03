import { getDownstreamConfig } from "../config";

const TIMEOUT_MS = 30_000;

export interface CallerInfo {
  service: string;
  method: string;
  path: string;
}

/**
 * Resolve a decrypted PLATFORM key for a provider via key-service. Platform
 * keys are global (no org/user identity needed) but the X-Caller-* headers are
 * required for provider-requirements tracking.
 *
 * Fail-loud: a non-2xx (incl. 404 = provider/platform-key not registered yet)
 * throws — the caller must not proceed without the key.
 */
export const getPlatformKey = async (
  provider: string,
  caller: CallerInfo
): Promise<string> => {
  const { keyServiceUrl, keyServiceApiKey } = getDownstreamConfig();
  const url = `${keyServiceUrl}/keys/platform/${provider}/decrypt`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": keyServiceApiKey,
        "x-caller-service": caller.service,
        "x-caller-method": caller.method,
        "x-caller-path": caller.path,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[ahref-service] key-service platform decrypt timed out after ${TIMEOUT_MS}ms`);
    }
    throw new Error(
      `[ahref-service] key-service platform decrypt fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[ahref-service] key-service platform decrypt for "${provider}" failed (${res.status}): ${text}`
    );
  }
  const data = (await res.json()) as { provider: string; key: string };
  return data.key;
};

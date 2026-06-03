/**
 * Domain normalization — the single keying primitive for this service.
 *
 * ahref-service is domain-centric: DR/traffic data is cached per domain, not
 * per outlet/campaign/brand. Two rules define a "domain key":
 *
 *  1. Subdomains are DISTINCT entities — `blog.example.com` ≠ `example.com`.
 *  2. `www` is NOT a subdomain — the leading `www.` label is stripped, so
 *     `www.example.com` and `example.com` resolve to the same key. Only the
 *     leading `www.` is removed; `www2`, `wwwx`, or a `www` that appears deeper
 *     in the host (`www.blog.example.com` → `blog.example.com`) keep every
 *     other label intact.
 *
 * Accepts bare hostnames or full URLs. Fails loud on anything that doesn't
 * reduce to a plausible hostname (empty, scheme-only, contains spaces) — no
 * silent fallback to "".
 */
export const normalizeDomain = (input: string): string => {
  if (typeof input !== "string") {
    throw new Error(`[ahref-service] normalizeDomain: expected string, got ${typeof input}`);
  }

  let host = input.trim().toLowerCase();
  if (host === "") {
    throw new Error("[ahref-service] normalizeDomain: empty input");
  }

  // If it looks like a URL (has a scheme, or a protocol-relative //), parse the
  // hostname out. Otherwise treat the whole string as a host[:port][/path].
  if (host.includes("://") || host.startsWith("//")) {
    const withScheme = host.startsWith("//") ? `http:${host}` : host;
    let parsed: URL;
    try {
      parsed = new URL(withScheme);
    } catch {
      throw new Error(`[ahref-service] normalizeDomain: not a valid URL: ${input}`);
    }
    host = parsed.hostname;
  } else {
    // Strip any path / query / fragment, then the port.
    host = host.split("/")[0].split("?")[0].split("#")[0];
    host = host.split(":")[0];
  }

  // Strip a trailing dot (FQDN root) and any leftover whitespace.
  host = host.replace(/\.$/, "").trim();

  // Strip exactly one leading `www.` label (the www exception).
  if (host.startsWith("www.")) {
    host = host.slice(4);
  }

  // Validate: must look like a hostname (at least one dot, label chars only).
  if (host === "" || host.includes(" ") || !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host)) {
    throw new Error(`[ahref-service] normalizeDomain: not a valid domain: ${input}`);
  }

  return host;
};

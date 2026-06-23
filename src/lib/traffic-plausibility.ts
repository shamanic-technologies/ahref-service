/**
 * Traffic-plausibility guard — the single source of truth for "is this scraped
 * organic-traffic figure trustworthy, or a partial / wrong-scope scrape we must
 * NOT present as a confident value?".
 *
 * Why this exists: the Ahrefs Apify actor occasionally returns a tiny, confident
 * organic-traffic number that is wrong. The two observed failure modes (prod
 * rows captured 2026-06): a www-canonical site (wsj.com, ft.com) scraped at the
 * bare apex returns only the handful of pages physically served on the apex
 * (wsj.com → 91% `/subscribe`; ft.com → empty pages, 88% Vietnam) — a tiny
 * number that looks like success. The root cause (apex-vs-www scope) is fixed by
 * scraping with `mode:"subdomains"`, but a scrape can still come back partial on
 * a rate-limit / timeout, so we keep this guard as defense-in-depth: a flagged
 * scrape is stored but surfaced as "no reliable data" (null), never as a
 * silently-wrong tiny number.
 *
 * Deterministic, no LLM. Two coherence rules (OR):
 *  A. STRUCTURAL — a positive traffic figure with zero ranking-page evidence
 *     (empty `topPages`) is a partial/empty scrape, not a real low-traffic site.
 *  B. AUTHORITY — organic traffic must be coherent with the domain's own
 *     authority. A domain with established backlink authority (DR ≥ 40) that
 *     reports under 5,000 monthly organic visits (~160/day) is internally
 *     incoherent — high authority never coexists with near-zero organic.
 *
 * The same rules are mirrored in the migration backfill (SQL) so already-stored
 * rows are invalidated identically.
 */

/** DR at/above which a domain has enough authority to rule out near-zero organic. */
export const HIGH_DR_THRESHOLD = 40;
/** Minimum monthly organic traffic a HIGH_DR_THRESHOLD domain can plausibly have. */
export const MIN_ORGANIC_FOR_HIGH_DR = 5000;

export interface TrafficPlausibilityInput {
  /** Scraped current monthly organic-traffic estimate. */
  trafficMonthlyAvg: number | null;
  /** Scraped top-pages array (ranking-page evidence). */
  topPages: unknown;
  /** The domain's latest known Ahrefs Domain Rating, or null if unknown. */
  authorityDomainRating: number | null;
}

export interface TrafficPlausibilityResult {
  implausible: boolean;
  reason: string | null;
}

export const assessTrafficPlausibility = (
  input: TrafficPlausibilityInput
): TrafficPlausibilityResult => {
  const avg = input.trafficMonthlyAvg;
  const pages = Array.isArray(input.topPages) ? input.topPages : [];

  // Rule A — structural: a traffic figure with no ranking-page evidence.
  if (avg != null && avg > 0 && pages.length === 0) {
    return {
      implausible: true,
      reason: "traffic figure with no ranking-page evidence (empty topPages)",
    };
  }

  // Rule B — authority coherence: high-DR domain reporting near-zero organic.
  const dr = input.authorityDomainRating;
  if (
    dr != null &&
    dr >= HIGH_DR_THRESHOLD &&
    (avg == null || avg < MIN_ORGANIC_FOR_HIGH_DR)
  ) {
    return {
      implausible: true,
      reason: `organic traffic incoherent with domain authority (DR ${dr}, under ${MIN_ORGANIC_FOR_HIGH_DR} monthly organic)`,
    };
  }

  return { implausible: false, reason: null };
};

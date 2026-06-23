/**
 * Traffic-plausibility guard — the single source of truth for "is this scraped
 * organic-traffic figure trustworthy, or a partial / empty scrape we must NOT
 * present as a confident value?".
 *
 * Why this exists: the Ahrefs Apify actor occasionally returns a confident
 * organic-traffic number with no page-level data behind it (a partial/empty
 * scrape on a rate-limit / timeout — observed prod row ft.com: a positive
 * trafficMonthlyAvg with an empty `topPages`). The magnitude root cause (apex
 * vs www scope) is fixed at the source by scraping with `mode:"subdomains"`;
 * this guard is the remaining defense-in-depth: a scrape with no ranking-page
 * evidence is invalidated so the consumer sees "no reliable data" (null) rather
 * than a number with nothing behind it.
 *
 * Deterministic, no LLM. One structural rule: a positive traffic figure with
 * zero ranking-page evidence (empty `topPages`) is a partial/empty scrape.
 *
 * NOTE: a DR-vs-traffic authority cross-check was intentionally removed — once
 * the scope fix lands, the scrape is correct, and that rule only mis-fired on
 * genuinely small but authoritative niche sites (DR ≥ 40 with a few thousand
 * real organic visits), wrongly hiding their data.
 */

export interface TrafficPlausibilityInput {
  /** Scraped current monthly organic-traffic estimate. */
  trafficMonthlyAvg: number | null;
  /** Scraped top-pages array (ranking-page evidence). */
  topPages: unknown;
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

  // A traffic figure with no ranking-page evidence is a partial/empty scrape.
  if (avg != null && avg > 0 && pages.length === 0) {
    return {
      implausible: true,
      reason: "traffic figure with no ranking-page evidence (empty topPages)",
    };
  }

  return { implausible: false, reason: null };
};

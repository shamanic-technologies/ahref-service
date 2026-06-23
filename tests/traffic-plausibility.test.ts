import { describe, it, expect } from "vitest";
import { assessTrafficPlausibility } from "../src/lib/traffic-plausibility";

const pages = [{ url: "https://x/", traffic: 100, share: 10 }];

describe("assessTrafficPlausibility", () => {
  it("passes a real high-traffic scrape backed by pages", () => {
    expect(
      assessTrafficPlausibility({ trafficMonthlyAvg: 3_289_936, topPages: pages })
    ).toEqual({ implausible: false, reason: null });
  });

  it("flags a positive figure with no ranking-page evidence (ft.com signature)", () => {
    const r = assessTrafficPlausibility({ trafficMonthlyAvg: 196, topPages: [] });
    expect(r.implausible).toBe(true);
    expect(r.reason).toContain("no ranking-page evidence");
  });

  it("does NOT flag a genuinely small site that has real ranking pages", () => {
    // Post scope-fix this is correct data, not a bad scrape — must pass.
    expect(
      assessTrafficPlausibility({ trafficMonthlyAvg: 4716, topPages: pages }).implausible
    ).toBe(false);
  });

  it("does not flag a zero-traffic site that also has no pages (nothing to mistrust)", () => {
    expect(
      assessTrafficPlausibility({ trafficMonthlyAvg: 0, topPages: [] }).implausible
    ).toBe(false);
  });
});

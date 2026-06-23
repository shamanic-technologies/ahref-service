import { describe, it, expect } from "vitest";
import { assessTrafficPlausibility } from "../src/lib/traffic-plausibility";

const pages = [{ url: "https://x/", traffic: 100, share: 10 }];

describe("assessTrafficPlausibility", () => {
  it("passes a real high-traffic scrape backed by pages", () => {
    expect(
      assessTrafficPlausibility({
        trafficMonthlyAvg: 3_289_936,
        topPages: pages,
        authorityDomainRating: 93,
      })
    ).toEqual({ implausible: false, reason: null });
  });

  it("flags a positive figure with no ranking-page evidence (ft.com signature)", () => {
    const r = assessTrafficPlausibility({
      trafficMonthlyAvg: 196,
      topPages: [],
      authorityDomainRating: null,
    });
    expect(r.implausible).toBe(true);
    expect(r.reason).toContain("no ranking-page evidence");
  });

  it("flags high-DR + near-zero organic via authority coherence (wsj.com signature)", () => {
    const r = assessTrafficPlausibility({
      trafficMonthlyAvg: 4802,
      topPages: pages,
      authorityDomainRating: 92,
    });
    expect(r.implausible).toBe(true);
    expect(r.reason).toContain("DR 92");
  });

  it("does not flag a genuinely small site with low authority", () => {
    expect(
      assessTrafficPlausibility({
        trafficMonthlyAvg: 800,
        topPages: pages,
        authorityDomainRating: 12,
      }).implausible
    ).toBe(false);
  });

  it("does not flag a mid-size site comfortably above the floor", () => {
    expect(
      assessTrafficPlausibility({
        trafficMonthlyAvg: 52_102,
        topPages: pages,
        authorityDomainRating: 92,
      }).implausible
    ).toBe(false);
  });

  it("flags a high-DR domain with a null traffic figure", () => {
    expect(
      assessTrafficPlausibility({
        trafficMonthlyAvg: null,
        topPages: pages,
        authorityDomainRating: 70,
      }).implausible
    ).toBe(true);
  });
});

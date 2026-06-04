import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const dataTypeSchema = z.enum(["authority", "traffic"]).openapi("AhrefDataType");

export const updateDomainRatingBodySchema = z
  .object({
    // Domain is the cache key — required. Normalized (www-stripped, lowercased)
    // before storage by the ingestion route.
    domain: z.string(),
    dataType: dataTypeSchema,
    dataCapturedAt: z.string().datetime(),
    urlInput: z.string().optional(),
    mode: z.string().optional(),
    rawData: z.record(z.unknown()),
    authorityDomainRating: z.number().int().nullable().optional(),
    authorityUrlRating: z.number().int().nullable().optional(),
    authorityBacklinks: z.number().int().nullable().optional(),
    authorityRefdomains: z.number().int().nullable().optional(),
    authorityDofollowBacklinks: z.number().int().nullable().optional(),
    authorityDofollowRefdomains: z.number().int().nullable().optional(),
    trafficMonthlyAvg: z.number().int().nullable().optional(),
    costMonthlyAvg: z.number().nullable().optional(),
    trafficHistory: z.unknown().nullable().optional(),
    trafficTopPages: z.unknown().nullable().optional(),
    trafficTopCountries: z.unknown().nullable().optional(),
    trafficTopKeywords: z.unknown().nullable().optional(),
    overallSearchTraffic: z.number().nullable().optional(),
    overallSearchTrafficHistory: z.unknown().nullable().optional(),
    overallSearchTrafficValue: z.number().nullable().optional(),
    overallSearchTrafficValueHistory: z.unknown().nullable().optional(),
    overallSearchTrafficByCountry: z.unknown().nullable().optional(),
    trafficByCountry: z.unknown().nullable().optional(),
    overallSearchTrafficKeywords: z.unknown().nullable().optional(),
  })
  .openapi("UpdateDomainRatingBody");

// Body for POST /orgs/domains/dr-compute — domains to scrape DR for, on demand.
export const drComputeBodySchema = z
  .object({
    domains: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Domains to fetch DR for. Normalized server-side (www stripped, case-folded); other subdomains kept distinct."
      ),
  })
  .openapi("DrComputeBody");

// Body for POST /orgs/domains/traffic-compute — domains to scrape traffic for.
export const trafficComputeBodySchema = z
  .object({
    domains: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Domains to fetch traffic for. Normalized server-side (www stripped, case-folded); other subdomains kept distinct."
      ),
  })
  .openapi("TrafficComputeBody");

// One month of the organic-traffic time-series (silver `domain_traffic_monthly`).
export const trafficMonthlySchema = z
  .object({
    month: z.string().describe("First day of the month (YYYY-MM-DD)."),
    organicTraffic: z.number().int().nullable(),
  })
  .openapi("TrafficMonthly");

// Per-domain traffic response: latest rich snapshot + full monthly organic series.
export const trafficResponseSchema = z
  .object({
    domain: z.string(),
    hasData: z.boolean(),
    latestDataCapturedAt: z.string().nullable(),
    trafficMonthlyAvg: z.number().int().nullable(),
    trafficValueMonthlyAvg: z.number().int().nullable(),
    topPages: z.unknown().nullable(),
    topCountries: z.unknown().nullable(),
    topKeywords: z.unknown().nullable(),
    monthlyOrganicTraffic: z.array(trafficMonthlySchema),
  })
  .openapi("TrafficResponse");

export const drStatusResponseSchema = z
  .object({
    domain: z.string(),
    drToUpdate: z.boolean(),
    drUpdateReason: z.string().nullable(),
    drLatestSearchDate: z.string().nullable(),
    latestValidDr: z.number().int().nullable(),
    latestValidDrDate: z.string().nullable(),
    needsUpdate: z.boolean(),
  })
  .openapi("DrStatusResponse");

export const lowDrResponseSchema = z
  .object({
    domain: z.string(),
    drToUpdate: z.boolean(),
    drUpdateReason: z.string().nullable(),
    drLatestSearchDate: z.string().nullable(),
    latestValidDr: z.number().int().nullable(),
    latestValidDrDate: z.string().nullable(),
    needsUpdate: z.boolean(),
    hasLowDomainRating: z.boolean().nullable(),
  })
  .openapi("LowDrResponse");

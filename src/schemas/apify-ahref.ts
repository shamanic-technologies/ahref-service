import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const dataTypeSchema = z.enum(["authority", "traffic"]).openapi("AhrefDataType");

export const updateDomainRatingBodySchema = z
  .object({
    dataType: dataTypeSchema,
    dataCapturedAt: z.string().datetime(),
    urlInput: z.string().optional(),
    domain: z.string().optional(),
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

export const drStatusResponseSchema = z
  .object({
    outletId: z.string().uuid(),
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
    outletId: z.string().uuid(),
    drToUpdate: z.boolean(),
    drUpdateReason: z.string().nullable(),
    drLatestSearchDate: z.string().nullable(),
    latestValidDr: z.number().int().nullable(),
    latestValidDrDate: z.string().nullable(),
    needsUpdate: z.boolean(),
    hasLowDomainRating: z.boolean().nullable(),
  })
  .openapi("LowDrResponse");

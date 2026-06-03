import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  AHREF_SERVICE_DATABASE_URL: z.string(),
  AHREF_SERVICE_API_KEY: z.string(),
});

export type Config = z.infer<typeof envSchema>;

export const getConfig = (): Config => {
  return envSchema.parse(process.env);
};

/**
 * Downstream service config — required only by the DR-compute path (Apify
 * scrape + run/cost/authorize declaration). Parsed lazily so the read-only
 * endpoints (dr-status, dr-stale, ...) never need these env vars.
 *
 * Fail-loud: a missing/empty var throws when a client is first used, never a
 * silent fallback.
 */
const downstreamSchema = z.object({
  RUNS_SERVICE_URL: z.string().url(),
  RUNS_SERVICE_API_KEY: z.string().min(1),
  BILLING_SERVICE_URL: z.string().url(),
  BILLING_SERVICE_API_KEY: z.string().min(1),
  KEY_SERVICE_URL: z.string().url(),
  KEY_SERVICE_API_KEY: z.string().min(1),
});

export interface DownstreamConfig {
  runsServiceUrl: string;
  runsServiceApiKey: string;
  billingServiceUrl: string;
  billingServiceApiKey: string;
  keyServiceUrl: string;
  keyServiceApiKey: string;
}

export const getDownstreamConfig = (): DownstreamConfig => {
  const env = downstreamSchema.parse(process.env);
  return {
    runsServiceUrl: env.RUNS_SERVICE_URL,
    runsServiceApiKey: env.RUNS_SERVICE_API_KEY,
    billingServiceUrl: env.BILLING_SERVICE_URL,
    billingServiceApiKey: env.BILLING_SERVICE_API_KEY,
    keyServiceUrl: env.KEY_SERVICE_URL,
    keyServiceApiKey: env.KEY_SERVICE_API_KEY,
  };
};

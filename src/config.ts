import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  AHREF_SERVICE_DATABASE_URL: z.string(),
  AHREF_SERVICE_API_KEY: z.string(),
  OUTLETS_SERVICE_URL: z.string(),
  OUTLETS_SERVICE_API_KEY: z.string(),
});

export type Config = z.infer<typeof envSchema>;

export const getConfig = (): Config => {
  return envSchema.parse(process.env);
};

import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  updateDomainRatingBodySchema,
  drComputeBodySchema,
  drStatusResponseSchema,
  lowDrResponseSchema,
  trafficComputeBodySchema,
  trafficResponseSchema,
  aiVisibilityBodySchema,
  aiVisibilityResponseSchema,
} from "./schemas/apify-ahref";

const registry = new OpenAPIRegistry();

// Org-tier identity headers (/orgs/*). Only x-org-id is required; the rest are
// optional and parsed if present.
const orgHeaders = z.object({
  "x-org-id": z.string().uuid().describe("Org UUID from client-service (required)"),
  "x-user-id": z.string().uuid().optional().describe("User UUID from client-service"),
  "x-run-id": z.string().uuid().optional().describe("Caller's run ID from runs-service"),
});

// Register schemas
registry.register("UpdateDomainRatingBody", updateDomainRatingBodySchema);
registry.register("DrComputeBody", drComputeBodySchema);
registry.register("DrStatusResponse", drStatusResponseSchema);
registry.register("LowDrResponse", lowDrResponseSchema);
registry.register("TrafficComputeBody", trafficComputeBodySchema);
registry.register("TrafficResponse", trafficResponseSchema);
registry.register("AiVisibilityBody", aiVisibilityBodySchema);
registry.register("AiVisibilityResponse", aiVisibilityResponseSchema);

// Health
registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            service: z.literal("ahref-service"),
          }),
        },
      },
    },
  },
});

// GET /orgs/domains/dr-status
registry.registerPath({
  method: "get",
  path: "/orgs/domains/dr-status",
  summary: "Get DR status for a list of domains",
  request: {
    headers: orgHeaders,
    query: z.object({
      domains: z
        .string()
        .describe(
          "Comma-separated domains. Normalized server-side: www stripped, case-folded; other subdomains kept distinct."
        ),
    }),
  },
  responses: {
    200: {
      description: "DR status for requested domains",
      content: {
        "application/json": {
          schema: z.array(drStatusResponseSchema),
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

// POST /orgs/domains/dr-compute
registry.registerPath({
  method: "post",
  path: "/orgs/domains/dr-compute",
  summary: "Scrape Ahrefs DR for domains on demand (declares cost + authorizes)",
  request: {
    headers: orgHeaders,
    body: {
      content: {
        "application/json": {
          schema: drComputeBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "DR status for the requested domains after the scrape",
      content: {
        "application/json": {
          schema: z.array(drStatusResponseSchema),
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

// GET /orgs/domains/traffic-history
registry.registerPath({
  method: "get",
  path: "/orgs/domains/traffic-history",
  summary: "Get traffic (latest snapshot + monthly organic series) for domains",
  request: {
    headers: orgHeaders,
    query: z.object({
      domains: z
        .string()
        .describe(
          "Comma-separated domains. Normalized server-side: www stripped, case-folded; other subdomains kept distinct."
        ),
    }),
  },
  responses: {
    200: {
      description: "Traffic history for the requested domains",
      content: {
        "application/json": {
          schema: z.array(trafficResponseSchema),
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

// POST /orgs/domains/traffic-compute
registry.registerPath({
  method: "post",
  path: "/orgs/domains/traffic-compute",
  summary: "Scrape Ahrefs traffic for domains on demand (declares cost + authorizes)",
  request: {
    headers: orgHeaders,
    body: {
      content: {
        "application/json": {
          schema: trafficComputeBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Traffic history for the requested domains after the scrape",
      content: {
        "application/json": {
          schema: z.array(trafficResponseSchema),
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

// POST /orgs/domains/ai-visibility
registry.registerPath({
  method: "post",
  path: "/orgs/domains/ai-visibility",
  summary:
    "Get-or-refresh Ahrefs Brand-Radar AI-visibility stats for a domain (declares cost + authorizes on scrape)",
  request: {
    headers: orgHeaders,
    body: {
      content: {
        "application/json": {
          schema: aiVisibilityBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "AI-visibility stats: global mention count, per-engine breakdown, top cited competitors, and raw upstream payload",
      content: {
        "application/json": {
          schema: aiVisibilityResponseSchema,
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

// GET /internal/domains/dr-stale
registry.registerPath({
  method: "get",
  path: "/internal/domains/dr-stale",
  summary: "Known domains whose DR needs a refresh (platform/cron)",
  responses: {
    200: {
      description: "Stale DR domains",
      content: {
        "application/json": {
          schema: z.array(drStatusResponseSchema),
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

// GET /internal/domains/low-domain-rating
registry.registerPath({
  method: "get",
  path: "/internal/domains/low-domain-rating",
  summary: "Known domains with DR < 10 (platform/cron)",
  responses: {
    200: {
      description: "Low DR domains",
      content: {
        "application/json": {
          schema: z.array(lowDrResponseSchema),
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

// POST /internal/domains/domain-rating
registry.registerPath({
  method: "post",
  path: "/internal/domains/domain-rating",
  summary: "Ingest scraped Ahrefs data for a domain (platform worker)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: updateDomainRatingBodySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Ahrefs data stored successfully",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string().uuid(),
            domain: z.string(),
          }),
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

const generator = new OpenApiGeneratorV3(registry.definitions);
const doc = generator.generateDocument({
  openapi: "3.0.3",
  info: {
    title: "Ahref Service",
    version: "1.0.0",
    description:
      "Domain-keyed cache of Ahrefs domain authority and traffic data. Keyed per domain (www folded to apex, other subdomains distinct); no outlet/campaign/brand coupling.",
  },
  servers: [{ url: "/" }],
  security: [],
});

// Add security scheme
doc.components = {
  ...doc.components,
  securitySchemes: {
    apiKey: {
      type: "apiKey",
      in: "header",
      name: "x-api-key",
    },
  },
};

const outputPath = join(__dirname, "..", "openapi.json");
writeFileSync(outputPath, JSON.stringify(doc, null, 2));
console.log(`OpenAPI spec written to ${outputPath}`);

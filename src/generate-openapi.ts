import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  updateDomainRatingBodySchema,
  drStatusResponseSchema,
  lowDrResponseSchema,
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
registry.register("DrStatusResponse", drStatusResponseSchema);
registry.register("LowDrResponse", lowDrResponseSchema);

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

// GET /orgs/outlets/dr-status
registry.registerPath({
  method: "get",
  path: "/orgs/outlets/dr-status",
  summary: "Get DR status for a list of outlet IDs",
  request: {
    headers: orgHeaders,
    query: z.object({
      outletIds: z.string().describe("Comma-separated outlet UUIDs"),
    }),
  },
  responses: {
    200: {
      description: "DR status for requested outlets",
      content: {
        "application/json": {
          schema: z.array(drStatusResponseSchema),
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

// GET /orgs/outlets/campaign-categories-dr-status
registry.registerPath({
  method: "get",
  path: "/orgs/outlets/campaign-categories-dr-status",
  summary:
    "DR status for outlets in a campaign (cross-service with outlets-service)",
  request: {
    headers: orgHeaders,
    query: z.object({
      campaignId: z.string().uuid().describe("Campaign UUID"),
    }),
  },
  responses: {
    200: {
      description: "DR status for campaign outlets",
      content: {
        "application/json": {
          schema: z.array(drStatusResponseSchema),
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

// GET /internal/outlets/dr-stale
registry.registerPath({
  method: "get",
  path: "/internal/outlets/dr-stale",
  summary: "All outlets that need DR refresh (platform/cron)",
  responses: {
    200: {
      description: "Stale DR outlets",
      content: {
        "application/json": {
          schema: z.array(drStatusResponseSchema),
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

// GET /internal/outlets/low-domain-rating
registry.registerPath({
  method: "get",
  path: "/internal/outlets/low-domain-rating",
  summary: "Outlets with DR < 10 (platform/cron)",
  responses: {
    200: {
      description: "Low DR outlets",
      content: {
        "application/json": {
          schema: z.array(lowDrResponseSchema),
        },
      },
    },
  },
  security: [{ apiKey: [] }],
});

// PATCH /internal/outlets/:outletId/domain-rating
registry.registerPath({
  method: "patch",
  path: "/internal/outlets/{outletId}/domain-rating",
  summary: "Ingest scraped Ahrefs data for an outlet (platform worker)",
  request: {
    params: z.object({ outletId: z.string().uuid() }),
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
            outletId: z.string().uuid(),
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
      "Manages Ahrefs domain authority and traffic data for press outlets",
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

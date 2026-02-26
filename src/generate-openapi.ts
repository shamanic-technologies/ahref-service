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

// Shared optional identity headers for all secured endpoints
const identityHeaders = z.object({
  "x-org-id": z.string().uuid().optional().describe("Org UUID from client-service"),
  "x-user-id": z.string().uuid().optional().describe("User UUID from client-service"),
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

// GET /outlets/dr-status
registry.registerPath({
  method: "get",
  path: "/outlets/dr-status",
  summary: "Get DR status for a list of outlet IDs",
  request: {
    headers: identityHeaders,
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

// GET /outlets/dr-stale
registry.registerPath({
  method: "get",
  path: "/outlets/dr-stale",
  summary: "All outlets that need DR refresh",
  request: {
    headers: identityHeaders,
  },
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

// PATCH /outlets/:outletId/domain-rating
registry.registerPath({
  method: "patch",
  path: "/outlets/{outletId}/domain-rating",
  summary: "Store new Ahrefs data for an outlet",
  request: {
    headers: identityHeaders,
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

// GET /outlets/low-domain-rating
registry.registerPath({
  method: "get",
  path: "/outlets/low-domain-rating",
  summary: "Outlets with DR < 10",
  request: {
    headers: identityHeaders,
  },
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

// GET /outlets/campaign-categories-dr-status
registry.registerPath({
  method: "get",
  path: "/outlets/campaign-categories-dr-status",
  summary:
    "DR status for outlets in a campaign (cross-service with outlets-service)",
  request: {
    headers: identityHeaders,
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

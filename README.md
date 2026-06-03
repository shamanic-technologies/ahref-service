# ahref-service

Domain-keyed cache of Ahrefs domain authority (DR) and traffic data.

This service is **domain-centric**. It has no concept of outlets, campaigns,
brands, or journalism — callers resolve their own entities to domains and ask
about domains. Everything (cache, DB, endpoints) is keyed by a normalized
domain.

## Domain key

Two rules define a domain key:

- **Subdomains are distinct** — `blog.example.com` ≠ `example.com`.
- **`www` is not a subdomain** — the leading `www.` label is stripped, so
  `www.example.com` and `example.com` resolve to the same key. Only the leading
  `www.` is removed (`www2`, `www.blog.example.com` → `blog.example.com`).

Inputs may be bare hostnames or full URLs; the host is extracted, lower-cased,
port/path/trailing-dot stripped. Unusable input fails loud (400 / thrown error),
never a silent empty key.

## Endpoints

| Method | Path | Tier | Purpose |
|--------|------|------|---------|
| GET | `/orgs/domains/dr-status?domains=a.com,b.com` | org (`x-api-key` + `x-org-id`) | DR status for domains; unknown domain → "needs update". **Pure read — no spend.** |
| POST | `/orgs/domains/dr-compute` | org (`x-api-key` + `x-org-id`) | On-demand: scrape Ahrefs DR for `{domains}` via Apify, persist, return DR. **Metered — declares cost + authorizes.** |
| GET | `/internal/domains/dr-stale` | internal (`x-api-key`) | Known domains whose DR is now stale |
| GET | `/internal/domains/low-domain-rating` | internal (`x-api-key`) | Known domains with DR < 10 |
| POST | `/internal/domains/domain-rating` | internal (`x-api-key`) | Ingest scraped Ahrefs data (domain in body) |

## DR compute (on-demand scrape)

`POST /orgs/domains/dr-compute` is the only endpoint that spends. It scrapes
Ahrefs via the Apify actor `pro100chok/ahrefs-seo-tools` (`pC8gsptNv2RwJm0QE`),
`searchType: website_authority` (DR + backlink/refdomain counts). Per metered
spend it follows the strict order, fail-loud at every step (any failure → 502):

1. **PROVISION** — `runs-service` cost `apify-ahrefs-result` (`costSource:"org"`),
   quantity = number of domains.
2. **AUTHORIZE** — `billing-service /v1/customer_balance/authorize` (Apify is a
   platform key, so the org's balance must cover it).
3. **EXECUTE** — resolve the platform Apify key from `key-service`
   (`GET /keys/platform/apify/decrypt`), run the actor, persist each result.
4. **ACTUALIZE** — bill the real charged result count, cancel the provisioned hold.

The cost unit is uniform per Apify result regardless of search type, so traffic /
AI-visibility can later be added under the same `apify-ahrefs-result` cost name.
DR is global reference data, so the persisted rating row carries no `org_id` —
org attribution lives on the run + cost.

## Data

`apify_ahref` is the append-only data/cache table; the cache is "the latest row
per domain". Migrations never drop, truncate, or delete it. DR/traffic ratings
live here — they are never destroyed by a deploy.

## Env

| Var | Purpose |
|-----|---------|
| `PORT` | HTTP port (default 3000) |
| `AHREF_SERVICE_DATABASE_URL` | Postgres connection string |
| `AHREF_SERVICE_API_KEY` | Service API key (all non-public routes) |
| `RUNS_SERVICE_URL` / `RUNS_SERVICE_API_KEY` | runs-service (cost declaration) — `dr-compute` only |
| `BILLING_SERVICE_URL` / `BILLING_SERVICE_API_KEY` | billing-service (authorize) — `dr-compute` only |
| `KEY_SERVICE_URL` / `KEY_SERVICE_API_KEY` | key-service (resolve platform Apify key) — `dr-compute` only |

The Apify token is **not** an env var — it is resolved at runtime from
key-service as the platform `apify` key (registered by the dashboard from its
`APIFY_API_KEY` Vercel env var).

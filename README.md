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
| GET | `/orgs/domains/traffic-history?domains=a.com,b.com` | org (`x-api-key` + `x-org-id`) | Latest traffic snapshot + monthly organic series per domain; unknown → `hasData:false`. **Pure read — no spend.** |
| POST | `/orgs/domains/traffic-compute` | org (`x-api-key` + `x-org-id`) | On-demand: scrape Ahrefs traffic for `{domains}` via Apify, persist (bronze + silver), return the series. **Metered — declares cost + authorizes.** |
| GET | `/internal/domains/dr-stale` | internal (`x-api-key`) | Known domains whose DR is now stale |
| GET | `/internal/domains/low-domain-rating` | internal (`x-api-key`) | Known domains with DR < 10 |
| POST | `/internal/domains/domain-rating` | internal (`x-api-key`) | Ingest scraped Ahrefs data (domain in body). `dataType:"traffic"` rows are also promoted to silver. |

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

## Traffic compute (on-demand scrape)

`POST /orgs/domains/traffic-compute` mirrors `dr-compute` for the actor's
`searchType: traffic_overview` (monthly organic traffic + value + history + top
pages/countries/keywords). Same metered order, same `apify-ahrefs-result` cost
(the Apify result unit is uniform per search type), fail-loud at every step.

The dashboard is expected to call this **once a month per brand** (the caller
resolves brand → domain; this service stays domain-centric). One scrape returns
~12–24 months of organic-traffic back-history, so history accrues immediately;
monthly re-runs extend and refresh it.

## Data layering

| Layer | Object | Shape |
|-------|--------|-------|
| **Bronze** | `apify_ahref` | Append-only raw scrape rows (full `raw_data` jsonb + typed columns). One row per scrape. The cache is "latest row per domain". |
| **Silver** | `domain_traffic_monthly` | One row per `(domain, month)`, organic traffic exploded from bronze `traffic_history`. Last-write-wins by `data_captured_at`. The historized series. |
| **Silver** | `domain_traffic_snapshot` | One row per scrape: monthly traffic avg, **traffic value ($)**, top pages/countries/keywords. Ahrefs gives no value-history, so a value series accrues here over monthly scrapes. |
| **Gold** | `v_domain_traffic_latest` | Latest snapshot per domain (dashboard read). |

Silver promotion is deterministic (no LLM — structured JSON) and runs inside the
bronze ingest for `dataType:"traffic"` rows, so any path that writes a traffic
bronze row gets silver. Migrations are additive and never drop/truncate these.

DR has **no** history from the actor (`domainRating` is a current scalar across
all search types); only traffic is pre-historized by Ahrefs.

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

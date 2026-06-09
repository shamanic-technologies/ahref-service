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
| POST | `/orgs/domains/dr-compute` | org (`x-api-key` + `x-org-id`) | Fire-and-forget DR request for `{domains}`. Fresh cached domains return immediately; missing/stale domains are queued and computed in the background. **Metered in background — declares cost + authorizes before Apify.** |
| GET | `/orgs/domains/traffic-history?domains=a.com,b.com` | org (`x-api-key` + `x-org-id`) | Latest traffic snapshot + monthly organic series per domain; unknown → `hasData:false`. **Pure read — no spend.** |
| POST | `/orgs/domains/traffic-compute` | org (`x-api-key` + `x-org-id`) | Fire-and-forget traffic request for `{domains}`. Existing saved traffic returns immediately; missing domains are queued and computed in the background. **Metered in background — declares cost + authorizes before Apify.** |
| POST | `/orgs/domains/ai-visibility` | org (`x-api-key` + `x-org-id`) | Get-or-refresh Ahrefs Brand-Radar AI-visibility for `{domain}`: cached if fresh, else scrape. **Metered on scrape — declares cost + authorizes.** |
| GET | `/internal/domains/dr-stale` | internal (`x-api-key`) | Known domains whose DR is now stale |
| GET | `/internal/domains/low-domain-rating` | internal (`x-api-key`) | Known domains with DR < 10 |
| POST | `/internal/domains/dr-compute` | internal (`x-api-key`) | Platform/service-auth trigger: compute missing/stale DR for `{domains}` without org identity. Fresh cached domains are returned without scrape. **Metered as platform run cost; no org authorization.** |
| POST | `/internal/domains/domain-rating` | internal (`x-api-key`) | Ingest scraped Ahrefs data (domain in body). `dataType:"traffic"` rows are also promoted to silver. |

## DR compute (on-demand scrape)

`POST /orgs/domains/dr-compute` is the org-scoped fire-and-forget trigger for DR.
It returns the existing DR status response shape immediately. Fresh cached
domains are not queued. Missing/stale domains are upserted into
`domain_metric_compute_jobs` and a background worker scrapes Ahrefs via the
Apify actor `pro100chok/ahrefs-seo-tools` (`pC8gsptNv2RwJm0QE`),
`searchType: website_authority` (DR + backlink/refdomain counts).

The queue is unique on `(org_id, metric, domain)`, so repeated clicks for the
same org/domain/metric coalesce instead of starting duplicate Apify runs. The
HTTP request does not wait for Apify completion; callers read the saved values
later through `dr-status` after the worker persists them.

The background worker follows the strict metered order, fail-loud at every step
(any failure is logged and marked on the job row):

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

`POST /internal/domains/dr-compute` is the platform/service-auth counterpart for
backend services that do not have org identity. It accepts the same `{domains}`
body, requires only `x-api-key`, and callers do not send `x-org-id`, `x-user-id`,
campaign, brand, feature, or workflow headers. Ahref-service normalizes/dedupes
the domains, reads its domain-keyed cache, and scrapes only domains whose DR is
missing/stale. Platform work creates a runs-service platform run and records an
`apify-ahrefs-result` platform cost after the scrape returns the charged result
count; there is no org balance authorization because no org is being charged.

## Traffic compute (on-demand scrape)

`POST /orgs/domains/traffic-compute` mirrors the org DR trigger for the actor's
`searchType: traffic_overview` (monthly organic traffic + value + history + top
pages/countries/keywords). It returns the existing traffic read response shape
immediately. Domains that already have saved traffic are not queued; missing
domains are coalesced in `domain_metric_compute_jobs` and processed by the
background worker.

The worker uses the same metered order, same `apify-ahrefs-result` cost (the
Apify result unit is uniform per search type), and fail-loud background logging
+ job failure state.

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
| **Queue** | `domain_metric_compute_jobs` | Fire-and-forget DR/traffic work queue. One row per `(org_id, metric, domain)` coalesces duplicate requests and records pending/running/succeeded/failed state plus `last_error`. |

Silver promotion is deterministic (no LLM — structured JSON) and runs inside the
bronze ingest for `dataType:"traffic"` rows, so any path that writes a traffic
bronze row gets silver. Migrations are additive and never drop/truncate these.

DR has **no** history from the actor (`domainRating` is a current scalar across
all search types); only traffic is pre-historized by Ahrefs.

## AI-visibility (Brand-Radar, on-demand get-or-refresh)

`POST /orgs/domains/ai-visibility` returns the brand domain's Ahrefs Brand-Radar
AI-visibility stats — global mention count, per-AI-engine breakdown (ChatGPT,
Perplexity, Gemini, Google AI Overviews/Mode, Copilot, …), and the top cited
competitor brands — plus the full raw upstream payload. It mirrors the
`dr-status` / `dr-compute` get-or-refresh split:

- **Fresh cache (< 6 days)** → returns the cached snapshot, no scrape, no spend.
- **Stale / absent** → scrapes via the SAME Apify actor as DR
  (`searchType: ai_visibility`), so the cost bills under the SAME
  `apify-ahrefs-result` cost name (PROVISION → AUTHORIZE → EXECUTE → ACTUALIZE,
  fail-loud at every step).

`snapshotDate` is the extraction date. Competitor entries carry a **global**
`brandId` resolved at ingest via brand-service's internal `resolve-by-domain`
(no org claim, no scrape) — `brandId` is global, so the cached value is valid for
every org reading the cache. An upstream scrape **or** brand-service failure is a
`502` (fail-loud), distinguishable from a true zero-mention result (a `200` with
`mentionsTotal: 0`). The raw payload is preserved so new Brand-Radar fields need
no contract change to capture.

## Data

`apify_ahref` is the append-only data/cache table; the cache is "the latest row
per domain" (per `data_type`: `authority` / `traffic` / `ai_visibility`).
Migrations never drop, truncate, or delete it. DR/traffic/AI-visibility data
lives here — never destroyed by a deploy.

## Env

| Var | Purpose |
|-----|---------|
| `PORT` | HTTP port (default 3000) |
| `AHREF_SERVICE_DATABASE_URL` | Postgres connection string |
| `AHREF_SERVICE_API_KEY` | Service API key (all non-public routes) |
| `RUNS_SERVICE_URL` / `RUNS_SERVICE_API_KEY` | runs-service (cost declaration) — `dr-compute` + `ai-visibility` |
| `BILLING_SERVICE_URL` / `BILLING_SERVICE_API_KEY` | billing-service (authorize) — `dr-compute` + `ai-visibility` |
| `KEY_SERVICE_URL` / `KEY_SERVICE_API_KEY` | key-service (resolve platform Apify key) — `dr-compute` + `ai-visibility` |
| `BRAND_SERVICE_URL` / `BRAND_SERVICE_API_KEY` | brand-service (resolve competitor domains to global brandIds) — `ai-visibility` only |

The Apify token is **not** an env var — it is resolved at runtime from
key-service as the platform `apify` key (registered by the dashboard from its
`APIFY_API_KEY` Vercel env var).

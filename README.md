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
| GET | `/orgs/domains/dr-status?domains=a.com,b.com` | org (`x-api-key` + `x-org-id`) | DR status for domains; unknown domain → "needs update" |
| GET | `/internal/domains/dr-stale` | internal (`x-api-key`) | Known domains whose DR is now stale |
| GET | `/internal/domains/low-domain-rating` | internal (`x-api-key`) | Known domains with DR < 10 |
| POST | `/internal/domains/domain-rating` | internal (`x-api-key`) | Ingest scraped Ahrefs data (domain in body) |

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

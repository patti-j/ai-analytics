# Query Insight

## Overview

Query Insight is a natural language interface designed to query manufacturing planning data from PlanetTogether analytics. It translates plain English questions into SQL queries against an Azure SQL database using OpenAI. The system targets curated Power BI reporting tables, providing insights across various contexts such as Production & Planning, Capacity Plan, Dispatch List, Inventories, Sales Orders, Schedule Conformance, and AuditLog. Its core purpose is to democratize access to complex manufacturing planning data through an intuitive conversational interface, enhancing data accessibility and decision-making.

## User Preferences

Preferred communication style: Simple, everyday language.
Code quality expectation: Production-ready, clean code suitable for dev team code review.
Cleanup approach: Clean up incrementally as features are built, not in large batches at the end.

## System Architecture

**Frontend:** The application uses React with TypeScript, Vite, Tailwind CSS v4, and shadcn/ui components for UI/UX. TanStack Query manages server state, and Wouter handles client-side routing.

**Backend:** Built with Node.js and TypeScript, the backend queries Azure SQL databases using the `mssql` package and integrates with the OpenAI API for natural language to SQL translation.

**Data Flow:** User natural language input is sent to the backend, which forwards it to OpenAI with schema context. OpenAI generates an SQL query that undergoes validation for safety (e.g., SELECT statements only, allowed tables, row limits) before execution against Azure SQL. Results are returned to the frontend with human-readable date formatting.

**Key Design Decisions & Features:**
- **Unified Query Experience:** A matrix classifier automatically selects relevant tables based on keywords in the user's question, enabling cross-domain queries without mode selection.
- **SQL Safety Guardrails:** Strict validation ensures only safe `SELECT` statements and allowlisted `INNER`/`LEFT`/`RIGHT` `JOIN`s are executed, blocking malicious or inefficient queries. All queries are limited to `TOP 100` rows and target `publish.DASHt_*` tables.
- **Dynamic Table Discovery & Curated Architecture:** The system discovers `DASHt_*` tables from Azure SQL at startup and primarily uses these curated Power BI tables for user queries, with Tier2 source tables available for fallback.
- **Matrix-Driven Table Selection & Column Slimming:** Keyword matching selects 2-4 most relevant tables, and schema context is dynamically trimmed to relevant columns (30-column cap per table) to optimize LLM prompt size.
- **Comprehensive Schema Grounding:** Database schemas are prefetched and cached. A SQL Column Validator validates all column references in generated SQL against the cached schema.
- **JOIN Support:** The SQL validator supports safe `INNER`/`LEFT`/`RIGHT` `JOIN`s with validated table references.
- **Schema Introspection:** `INFORMATION_SCHEMA.COLUMNS` is used to provide OpenAI with exact column lists, preventing hallucination.
- **Query Performance Monitoring:** An analytics dashboard (`/dashboard`) provides metrics on query performance, success rates, latency, and error analytics.
- **User Permissions Enforcement:** Server-side enforcement injects WHERE clauses based on user permissions (`Planning Areas`, `Scenarios`, `Plants`) and restricts access to sensitive tables like `DASHt_SalesOrders` for non-admin users.
- **Pinned Dashboard:** Users can pin favorite queries to a personal dashboard for quick access, storing up to 20 items locally with cached results.
- **Server-Persisted Favorites:** Favorite questions are persisted to `dbo.AiUserFavorite` (CompanyId, UserEmail, QuestionText, CreatedAt) via `/api/favorites` GET/POST/DELETE routes. The `useFavoriteQueries` hook uses the API when authenticated, falls back to localStorage otherwise, and merges local-only favorites into the server on first authenticated load.
- **Global Filters:** Three dropdown filters (Planning Area, Scenario, Plant) are available in the UI, applied to all queries.
- **SSE Streaming:** Full SSE streaming support (`/api/ask/stream`) with typing effects and a stop button is available, auto-enabled in Azure deployments.
- **ScenarioType Filtering:** `DASHt_Planning` and `DASHt_SalesOrders` queries use the user's selected scenario from the dropdown filter.
- **Invalid Filter Validation:** The system provides helpful messages and valid alternatives when a query returns 0 results due to non-existent filter values.
- **Simulated Today:** An anchor date can be configured (e.g., `VITE_DEV_FIXED_TODAY` or `SIMULATED_TODAY`) for all date-relative queries.

## Embed Auth & Multi-Tenant Architecture

**Iframe Embedding:** The app supports iframe embedding within a Blazor WebApp parent via JWT-based embed auth handshake:
- Parent sends `PT.EMBED.AUTH` postMessage with JWT embed token
- App validates JWT (iss=PlanetTogether.WebApp, aud=PlanetTogether.EmbedApp) using `EMBED_TOKEN_SECRET`
- Creates 8-hour HttpOnly cookie session (`pt_embed_session`) in memory
- Dev bypass mode: when `EMBED_TOKEN_SECRET` is not set in development, sessions auto-create with `x-username`/`x-company-id`/`x-is-admin` headers

**Multi-Tenant Database Access:**
- `server/db-webapp.ts`: Connection to `pt_webapp_dev` database for user/entitlement management (uses `WEBAPP_DATABASE_URL` or `WEBAPP_SQL_*` env vars)
- `server/db-publish.ts`: Dynamic per-company Publish DB pools looked up from `CompanyDbs` table in webapp DB
- `server/db-azure.ts`: Original single-tenant connection used for query execution (fallback)

**Entitlement Management (DB-backed, replaces JSON permissions):**
- `server/entitlement-storage.ts`: CRUD for `dbo.AiAnalyticsUser` and `dbo.AiUserEntitlement` tables
- `server/membership-sync.ts`: Syncs users with AI_Analytics role from webapp's User/Role/UserRole tables
- 6 scope types: PlanningArea, Plant, Scenario, Resource, Product, Workcenter
- Admin routes at `/api/admin/entitlements/*` protected by `requireAdmin` middleware
- User entitlements at `/api/my-entitlements` for query page filter constraining
- **Query Enforcement (T012):** `enforceEntitlements()` in `server/query-permissions.ts` injects WHERE clauses based on user entitlements into both `/api/ask` and `/api/ask/stream`. Non-admin users with 0 entitlements are blocked. Entitlement lookup failure is fail-closed (503). Filter-options endpoint intersects dropdown values with user entitlements (non-admin only). Column mappings cover all 6 scope types across DASHt tables.

**Key Server Files:**
- `server/embed-auth.ts`: JWT validation, session store, middleware, requireAdmin
- `server/db-webapp.ts`: pt_webapp_dev connection pool
- `server/db-publish.ts`: Dynamic per-company Publish DB pools
- `server/entitlement-storage.ts`: AiAnalyticsUser & AiUserEntitlement CRUD
- `server/membership-sync.ts`: AI_Analytics role membership sync
- `server/favorites-storage.ts`: AiUserFavorite CRUD (CompanyId+UserEmail+QuestionText scoped)

**Theme Override from Parent:**
- Parent can send `ui.theme` ("dark"|"light") in the `PT.EMBED.AUTH` postMessage
- `EmbedSessionContext.applyTheme()` applies CSS class + localStorage + dispatches `theme-override` CustomEvent
- `ThemeProvider` listens for `theme-override` event to sync its React state with the DOM change

**Key Frontend Files:**
- `client/src/contexts/EmbedSessionContext.tsx`: PostMessage listener, session management, entitlements loading, theme override
- `client/src/components/theme-provider.tsx`: Theme management with external override support via CustomEvent
- `client/src/pages/admin-users.tsx`: Admin page for managing user entitlements (/admin/users)
- `client/src/pages/admin-permissions.tsx`: Legacy admin page for JSON-file permissions (/admin/permissions)

**Environment Variables Required:**
- `EMBED_TOKEN_SECRET`: Secret for JWT validation (required in production, optional for dev bypass)
- `WEBAPP_DATABASE_URL` or `WEBAPP_SQL_SERVER/DATABASE/USER/PASSWORD`: pt_webapp_dev connection
- `PUBLISH_DB_PASSWORD`: Password for per-company Publish DB connections
- `DATABASE_URL`: Existing Azure SQL Publish DB connection (for single-tenant fallback)

## Legacy Admin Permissions

- **User Permissions Admin Page:** Legacy admin page (`/admin/permissions`) manages user access via `data/user-permissions.json`. Being replaced by DB-backed entitlements at `/admin/users`.

## Maintenance Scripts

- **Query Matrix Generator:** The `/matrix` page (`docs/query-matrix.html`) is auto-generated from `src/config/analytics_reference.json`. To regenerate after updating table mappings:
  ```bash
  npx tsx script/generate-matrix-html.ts
  ```
  This ensures the documentation stays in sync with the actual table selection logic.

## External Dependencies

- **Azure SQL Database:** The primary data source, configured via `DATABASE_URL` or discrete environment variables. Tables follow the `publish.DASHt_*` naming convention.
- **OpenAI API:** Used for natural language to SQL translation, requiring `AI_INTEGRATIONS_OPENAI_API_KEY` or `OPENAI_API_KEY`.
- **Environment Configuration:** Secrets and configurations like `DATABASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `DIAGNOSTICS_TOKEN`, and `PUBLIC_BASE_URL` are managed via Replit Secrets or Azure App Service configuration.

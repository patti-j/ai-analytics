# Query Insight

## Overview

Query Insight is a natural language interface designed to query manufacturing planning data from PlanetTogether analytics. It translates plain English questions into SQL queries against an Azure SQL database using OpenAI. The system targets curated Power BI reporting tables, providing insights across various contexts such as Production & Planning, Capacity Plan, Dispatch List, Inventories, Sales Orders, Schedule Conformance, and AuditLog. Its core purpose is to democratize access to complex manufacturing planning data through an intuitive conversational interface, enhancing data accessibility and decision-making.

## User Preferences

Preferred communication style: Simple, everyday language.
Code quality expectation: Production-ready, clean code suitable for dev team code review.
Cleanup approach: Clean up incrementally as features are built, not in large batches at the end.
Version numbering: Increment APP_VERSION (in query.tsx) and package.json version on every commit.

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
- **Query Performance Monitoring:** An analytics dashboard (`/dashboard`) provides metrics on query performance, success rates, latency, and error analytics. Restricted to company admins only. Analytics data is stored in `dbo.AiQueryLog` (webapp DB) and served via `/api/admin/analytics` and `/api/admin/analytics/failed-queries` endpoints.
- **Entitlement-Based Access Enforcement:** Server-side enforcement via `enforceEntitlements()` injects WHERE clauses based on DB-backed user entitlements (6 scope types). Non-admin users with 0 entitlements are blocked. Admin users bypass entitlements entirely (null entitlements = unrestricted access).
- **Server-Persisted Favorites:** Favorite questions are persisted to `dbo.AiUserFavorite` (CompanyId, UserEmail, QuestionText, CreatedAt) via `/api/my-favorites` GET/POST/DELETE routes. Favorites are loaded at session init time in `EmbedSessionContext` (same pattern as entitlements) and managed via context methods (`addFavorite`, `removeFavorite`, `toggleFavorite`, `isFavorite`).
- **Global Filters:** Six multi-select checkbox filters (Planning Area, Scenario, Plant, Resource, Product, Workcenter) matching the 6 entitlement scope types. Each filter has an "All" checkbox at the top (default). Multiple values can be selected, generating SQL `IN()` clauses. Filter options are fetched from the per-company Publish DB (DbType=2 in CompanyDbs table) with entitlements-based intersection for non-admin users. Component: `client/src/components/MultiSelectFilter.tsx`. Product filter has `JobProduct` column fallback for schemas without `ProductName`.
- **SSE Streaming:** Full SSE streaming support (`/api/ask/stream`) with typing effects and a stop button is available, auto-enabled in Azure deployments.
- **ScenarioType Filtering:** `DASHt_Planning` and `DASHt_SalesOrders` queries use the user's selected scenario from the dropdown filter.
- **Invalid Filter Validation:** The system provides helpful messages and valid alternatives when a query returns 0 results due to non-existent filter values.
- **Simulated Today:** An anchor date can be configured (e.g., `VITE_DEV_FIXED_TODAY` or `SIMULATED_TODAY`) for all date-relative queries.

## Embed Auth & Multi-Tenant Architecture

**Authentication — postMessage only:**
- Parent Blazor app sends `PT.EMBED.AUTH` postMessage with JWT embed token
- App validates JWT (iss=PlanetTogether.WebApp, aud=PlanetTogether.EmbedApp) using `EMBED_TOKEN_SECRET`
- Creates 8-hour HttpOnly cookie session (`pt_embed_session`, `SameSite=None; Secure` in production) in memory
- Session ID returned in `/api/session/from-embed` response for cross-origin EventSource auth (passed as `_sid` query param)
- No URL token auth, no direct session fallback — postMessage is the ONLY auth path
- Duplicate `PT.EMBED.AUTH` messages are ignored once authenticated (guard in EmbedSessionContext)

**Admin Determination:**
- Admin status comes solely from the `isCompanyAdmin` JWT claim
- No server-side role table lookups (PT admin role checks were removed in v1.9.3)
- Admin users: entitlements are `null` (not fetched), all scopes accessible
- Non-admin users: entitlements loaded from `dbo.AiUserEntitlement`, enforced on queries

**Cross-Origin API Architecture:**
- The iframe is loaded from the AI Analytics Azure Web App but rendered within the Blazor host context
- All API calls use absolute URLs via `apiUrl()` helper from `client/src/lib/api-config.ts`
- `VITE_API_BASE_URL` env var must be set to the AI Analytics Web App URL (e.g., `https://aianalytics-*.azurewebsites.net`)
- Server has CORS middleware in `server/index.ts` allowing Azure origins with credentials
- EventSource (SSE streaming) uses `_sid` query parameter since it doesn't support cookies cross-origin
- Additional CORS origins can be added via `CORS_ORIGIN` env var (comma-separated)

**Multi-Tenant Database Access:**
- `server/db-webapp.ts`: Connection to webapp database via `WEBAPP_DB_CONNECTION_STRING` (ADO.NET format)
- `server/db-publish.ts`: Dynamic per-company Publish DB pools looked up from `CompanyDbs` table in webapp DB
- `server/db-azure.ts`: Original single-tenant connection (legacy, kept as fallback)

**4 AI Tables (all in webapp DB `pt_webapp_dev`):**
- `dbo.AiAnalyticsUser` — user records (CompanyId, UserEmail, IsActive)
- `dbo.AiUserEntitlement` — scope-based permissions (CompanyId, UserEmail, ScopeType, ScopeValue). Note: table also has GrantedAtUtc and GrantedByEmail columns but our queries only SELECT the first 4.
- `dbo.AiUserFavorite` — saved questions (CompanyId, UserEmail, QuestionText, CreatedAt)
- `dbo.AiQueryLog` — query audit log (Id IDENTITY PK, CompanyId, UserEmail, QuestionText, GeneratedSql, RowCount, DurationMs, LlmMs, SqlMs, Success, ErrorMessage, ErrorStage, CreatedAt)
- Entitlements and favorites are bundled into `/api/session/from-embed` and `/api/session` responses
- Favorites mutations via POST/DELETE `/api/my-favorites`
- Admin CRUD at `/api/admin/entitlements/*` protected by `requireAdmin` middleware
- Analytics endpoints at `/api/admin/analytics` protected by company admin check
- 6 scope types: PlanningArea, Plant, Scenario, Resource, Product, Workcenter
- **Query Enforcement:** `enforceEntitlements()` in `server/query-permissions.ts` injects WHERE clauses based on user entitlements into both `/api/ask` and `/api/ask/stream`. Non-admin users with 0 entitlements are blocked. Entitlement lookup failure is fail-closed (503). Filter-options endpoint intersects dropdown values with user entitlements (non-admin only). Column mappings cover all 6 scope types across DASHt tables.
- **Entitlement save:** `replaceEntitlements()` wraps DELETE+INSERTs in a SQL transaction for atomicity.

**Key Server Files:**
- `server/embed-auth.ts`: JWT validation, in-memory session store, cookie middleware, requireAdmin
- `server/db-webapp.ts`: pt_webapp_dev connection pool (ADO.NET connection string parsing)
- `server/db-publish.ts`: Dynamic per-company Publish DB pools (looked up from CompanyDbs)
- `server/entitlement-storage.ts`: AiAnalyticsUser & AiUserEntitlement CRUD, diagnostic logging on 0-row results
- `server/membership-sync.ts`: AI_Analytics role membership sync (role matching: `LIKE 'AI[_ ]Analytics%'`)
- `server/favorites-storage.ts`: AiUserFavorite CRUD (CompanyId+UserEmail+QuestionText scoped)
- `server/query-log-storage.ts`: AiQueryLog insert + analytics aggregation (logQuery, getQueryAnalytics, getPopularQuestions, getFailedQueries)
- `server/query-permissions.ts`: Entitlement enforcement — injects WHERE clauses into SQL based on user scopes

**Theme Override from Parent:**
- Parent can send `ui.theme` ("dark"|"light") in the `PT.EMBED.AUTH` postMessage payload
- Default theme is "light"
- `EmbedSessionContext.applyTheme()` applies CSS class + localStorage + dispatches `theme-override` CustomEvent
- `ThemeProvider` listens for `theme-override` event to sync its React state with the DOM change
- Duplicate auth messages still apply theme updates (even though re-auth is skipped)

**Key Frontend Files:**
- `client/src/contexts/EmbedSessionContext.tsx`: PostMessage listener, session management, entitlements loading, theme override, duplicate auth guard
- `client/src/components/theme-provider.tsx`: Theme management with external override support via CustomEvent
- `client/src/pages/admin-users.tsx`: Admin page for managing user entitlements (/admin/users) — expandable inline cards, filters out current admin from list
- `client/src/pages/query.tsx`: Main query interface — filters, question input, results, favorites
- `client/src/pages/dashboard.tsx`: Analytics dashboard for company admins

**Navigation Icons (query.tsx header):**
- Users icon (admin users page) — visible to company admins only
- BarChart3 icon (analytics dashboard) — visible to company admins only
- TableProperties icon (query matrix reference) — visible to all
- HelpCircle icon (guided tour) — visible to all
- ThemeToggle — visible to all

**Environment Variables Required:**
- `EMBED_TOKEN_SECRET`: Secret for JWT validation (required, also resolved from Key Vault as `EMBED-TOKEN-SECRET`)
- `WEBAPP_DB_CONNECTION_STRING`: ADO.NET connection string for webapp database (AiAnalyticsUser, AiUserEntitlement, AiUserFavorite, AiQueryLog tables)
- `PUBLISH_DB_PASSWORD`: Password for per-company Publish DB connections (optional if Key Vault is configured)
- `AZURE_KEYVAULT_URL` (or `KEY_VAULT_URL`): Azure Key Vault URL (e.g., `https://vault-name.vault.azure.net/`)
- `AZURE_TENANT_ID` (or `KEY_VAULT_TENANT_ID`): Azure AD tenant ID for Key Vault auth
- `AZURE_CLIENT_ID` (or `KEY_VAULT_CLIENT_ID`): Azure AD app registration client ID
- `AZURE_CLIENT_SECRET` (or `KEY_VAULT_CLIENT_SECRET`): Azure AD app registration client secret
- `DATABASE_URL`: Existing Azure SQL Publish DB connection (for single-tenant fallback)
- `VITE_API_BASE_URL`: AI Analytics Web App URL for cross-origin API calls from iframe
- `CORS_ORIGIN`: Additional allowed CORS origins (comma-separated, optional)

**Key Vault Secrets Used:**
- `EMBED-TOKEN-SECRET`: JWT signing key for embed token validation
- DB passwords via `DBPasswordKey` from CompanyDbs table (e.g., `AcmeDBPassword`)
- Key Vault module: `server/keyvault.ts` (shared by embed-auth.ts and db-publish.ts)

**Logging:**
- Health check (`/api/health`) is excluded from request logging to reduce noise
- Azure health probes hit `/api/health` every 60 seconds — this is expected
- Entitlement queries log input parameters and result counts for debugging
- When entitlements return 0 rows for a non-admin, diagnostic queries check for email mismatches

## Maintenance Scripts

- **Query Matrix Generator:** The `/matrix` page (`docs/query-matrix.html`) is auto-generated from `src/config/analytics_reference.json`. To regenerate after updating table mappings:
  ```bash
  npx tsx script/generate-matrix-html.ts
  ```

## External Dependencies

- **Azure SQL Database:** The primary data source, configured via `DATABASE_URL` or discrete environment variables. Tables follow the `publish.DASHt_*` naming convention.
- **OpenAI API:** Used for natural language to SQL translation, requiring `AI_INTEGRATIONS_OPENAI_API_KEY` or `OPENAI_API_KEY`.
- **Environment Configuration:** Secrets and configurations like `DATABASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `DIAGNOSTICS_TOKEN`, and `PUBLIC_BASE_URL` are managed via Replit Secrets or Azure App Service configuration.

## Known Issues / Tech Debt

- `xlsx` package has a high-severity vulnerability with no fix available; consider migrating to `exceljs`
- `esbuild` and `drizzle-kit` have moderate-severity dev-only vulnerabilities
- `drizzle.config.ts` references `shared/schema.ts` but Drizzle ORM is not actively used (Azure SQL is accessed directly via `mssql`)
- ~30 unused shadcn/ui component files exist in `client/src/components/ui/` (standard boilerplate, harmless)

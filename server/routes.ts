import type { Express } from "express";
import { createServer, type Server } from "http";
import { executeQuery } from "./db-azure";
import { validateAndModifySql, runValidatorSelfCheck, type ValidationOptions } from "./sql-validator";
import { generateSqlFromQuestion, generateSuggestions, classifyQuestion, answerGeneralQuestion, generateNaturalLanguageResponse, streamNaturalLanguageResponse, cacheSuccessfulSql } from "./openai-client";
import { log } from "./index";
import { logQuery, getQueryAnalytics, getPopularQuestions as getPopularQuestionsDb, getFailedQueries as getFailedQueriesDb, checkUserHasPtAdminRole } from "./query-log-storage";
import { getSchemasForMode, formatSchemaForPrompt, TableSchema } from "./schema-introspection";
import { validateSqlColumns } from "./sql-column-validator";
import { readFileSync } from "fs";
import { join } from "path";
import { 
  getDiscoveryStatus, 
  runTableDiscovery 
} from "./table-discovery";
import { entitlementSaveSchema, SCOPE_TYPES } from "@shared/schema";
import { applyGlobalFilters, enforceEntitlements, intersectFilterOptions } from "./query-permissions";
import { handleSessionFromEmbed, requireAdmin } from "./embed-auth";
import {
  getUsersWithEntitlementStatus,
  getEntitlementsForUser,
  getEntitlementsByScope,
  replaceEntitlements,
  upsertUser,
  getAllEntitlementsForCompany,
} from "./entitlement-storage";
import { syncMembership } from "./membership-sync";
import { getFavoritesForUser, addFavorite as addFavoriteDb, removeFavorite as removeFavoriteDb } from "./favorites-storage";
import { isWebAppConfigured } from "./db-webapp";
import { executePublishQuery, getPublishDbConfig } from "./db-publish";

async function runPublishQuery(companyId: number | undefined, sqlText: string) {
  if (companyId) {
    return await executePublishQuery(companyId, sqlText);
  }
  return await executeQuery(sqlText);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Embed auth: create session from JWT token
  app.post("/api/session/from-embed", handleSessionFromEmbed);

  app.get("/api/session", async (req, res) => {
    if (!req.embedSession) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const { companyId, email, isCompanyAdmin, hasAIAnalyticsRole } = req.embedSession;

    const isPtAdmin = await checkUserHasPtAdminRole(companyId, email).catch(() => false);
    const effectiveAdmin = isCompanyAdmin || isPtAdmin;

    const [entitlements, favRows] = await Promise.all([
      effectiveAdmin
        ? Promise.resolve([])
        : getEntitlementsForUser(companyId, email).catch(() => []),
      getFavoritesForUser(companyId, email).catch(() => []),
    ]);

    const favorites = favRows.map(r => ({
      question: r.QuestionText,
      savedAt: r.CreatedAt,
    }));

    res.json({
      email,
      companyId,
      isCompanyAdmin: effectiveAdmin,
      isPtAdmin,
      hasAIAnalyticsRole,
      isAdmin: effectiveAdmin,
      entitlements,
      scopeTypes: SCOPE_TYPES,
      favorites,
    });
  });

  // ===== ADMIN ENTITLEMENT ENDPOINTS (new DB-backed) =====

  // List all users for company with entitlement status (triggers membership sync)
  app.get("/api/admin/entitlements/users", requireAdmin, async (req, res) => {
    try {
      const companyId = req.embedSession!.companyId;

      if (isWebAppConfigured()) {
        try {
          await syncMembership(companyId);
        } catch (syncErr: any) {
          log(`[admin-entitlements] Membership sync failed: ${syncErr.message}`, 'admin-entitlements');
        }
      }

      const users = await getUsersWithEntitlementStatus(companyId);
      res.json({ users });
    } catch (error: any) {
      log(`[admin-entitlements] Error fetching users: ${error.message}`, 'error');
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  // Get entitlements for a specific user
  app.get("/api/admin/entitlements/users/:email", requireAdmin, async (req, res) => {
    try {
      const companyId = req.embedSession!.companyId;
      const email = decodeURIComponent(req.params.email);
      const entitlements = await getEntitlementsForUser(companyId, email);
      res.json({ email, entitlements });
    } catch (error: any) {
      log(`[admin-entitlements] Error fetching entitlements: ${error.message}`, 'error');
      res.status(500).json({ error: 'Failed to fetch entitlements' });
    }
  });

  // Save entitlements for a user (replace all)
  app.put("/api/admin/entitlements/users/:email", requireAdmin, async (req, res) => {
    try {
      const companyId = req.embedSession!.companyId;
      const email = decodeURIComponent(req.params.email);
      const grantedByEmail = req.embedSession!.email;

      const parseResult = entitlementSaveSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: 'Invalid entitlement data', details: parseResult.error.format() });
      }

      await upsertUser(companyId, email, true);
      await replaceEntitlements(companyId, email, parseResult.data.scopes, grantedByEmail);

      const entitlements = await getEntitlementsForUser(companyId, email);
      res.json({ ok: true, email, entitlements });
    } catch (error: any) {
      log(`[admin-entitlements] Error saving entitlements: ${error.message}`, 'error');
      res.status(500).json({ error: 'Failed to save entitlements' });
    }
  });

  // Get available scope values from Publish DB (for entitlement checkbox lists)
  app.get("/api/admin/entitlements/scope-values/:scopeType", requireAdmin, async (req, res) => {
    try {
      const scopeType = req.params.scopeType;
      if (!SCOPE_TYPES.includes(scopeType as any)) {
        return res.status(400).json({ error: `Invalid scope type: ${scopeType}` });
      }

      const scopeQueries: Record<string, string> = {
        PlanningArea: "SELECT DISTINCT PlanningAreaName AS value FROM [publish].[DASHt_Resources] WHERE PlanningAreaName IS NOT NULL ORDER BY PlanningAreaName",
        Plant: "SELECT DISTINCT PlantName AS value FROM [publish].[DASHt_Resources] WHERE PlantName IS NOT NULL ORDER BY PlantName",
        Scenario: "SELECT DISTINCT NewScenarioId AS value FROM [publish].[DASHt_Planning] WHERE NewScenarioId IS NOT NULL ORDER BY NewScenarioId",
        Resource: "SELECT DISTINCT ResourceName AS value FROM [publish].[DASHt_Resources] WHERE ResourceName IS NOT NULL ORDER BY ResourceName",
        Product: "SELECT DISTINCT JobProduct AS value FROM [publish].[DASHt_Planning] WHERE JobProduct IS NOT NULL ORDER BY JobProduct",
        Workcenter: "SELECT DISTINCT WorkcenterName AS value FROM [publish].[DASHt_Resources] WHERE WorkcenterName IS NOT NULL ORDER BY WorkcenterName",
      };

      const query = scopeQueries[scopeType];
      if (!query) {
        return res.status(400).json({ error: `No query defined for scope type: ${scopeType}` });
      }

      const companyId = req.embedSession!.companyId;
      const result = await runPublishQuery(companyId, query);
      const values = (result?.recordset || []).map((r: any) => r.value).filter(Boolean);
      res.json({ scopeType, values });
    } catch (error: any) {
      log(`[admin-entitlements] Error fetching scope values: ${error.message}`, 'error');
      res.status(500).json({ error: 'Failed to fetch scope values' });
    }
  });

  app.post("/api/my-favorites", async (req, res) => {
    try {
      if (!req.embedSession) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { companyId, email } = req.embedSession;
      const { question } = req.body;
      if (!question || typeof question !== 'string' || question.trim().length === 0) {
        return res.status(400).json({ error: 'Question text is required' });
      }
      await addFavoriteDb(companyId, email, question.trim());
      res.json({ ok: true });
    } catch (error: any) {
      log(`[favorites] Error adding favorite: ${error.message}`, 'error');
      res.status(500).json({ error: 'Failed to save favorite' });
    }
  });

  app.delete("/api/my-favorites", async (req, res) => {
    try {
      if (!req.embedSession) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { companyId, email } = req.embedSession;
      const { question } = req.body;
      if (!question || typeof question !== 'string') {
        return res.status(400).json({ error: 'Question text is required' });
      }
      await removeFavoriteDb(companyId, email, question.trim());
      res.json({ ok: true });
    } catch (error: any) {
      log(`[favorites] Error removing favorite: ${error.message}`, 'error');
      res.status(500).json({ error: 'Failed to remove favorite' });
    }
  });

  // Get runtime config (simulated date for testing)
  app.get("/api/config", (_req, res) => {
    const simulatedToday = process.env.SIMULATED_TODAY || process.env.VITE_DEV_FIXED_TODAY || null;
    res.json({ 
      simulatedToday,
      serverTime: new Date().toISOString()
    });
  });

  // Get filter options for planning area, scenario, and plant dropdowns
  app.get("/api/filter-options", async (req, res) => {
    try {
      const companyId = req.embedSession?.companyId;
      const sessionEmail = req.embedSession?.email;
      log(`[filter-options] Request from ${sessionEmail || '(no session)'}, companyId=${companyId || '(none)'}`, 'filter-options');

      async function safeQuery(label: string, sql: string) {
        try {
          return await runPublishQuery(companyId, sql);
        } catch (err: any) {
          log(`[filter-options] ${label} query failed: ${err.message}`, 'filter-options');
          return { recordset: [] };
        }
      }
      const [planningAreaResult, scenarioResult, plantResult, resourceResult, productResult, workcenterResult] = await Promise.all([
        safeQuery("planningArea", "SELECT DISTINCT PlanningAreaName FROM [publish].[DASHt_Resources] WHERE PlanningAreaName IS NOT NULL ORDER BY PlanningAreaName"),
        safeQuery("scenario", "SELECT DISTINCT NewScenarioId, ScenarioName, ScenarioType FROM [publish].[DASHt_Planning] WHERE NewScenarioId IS NOT NULL ORDER BY ScenarioType, ScenarioName"),
        safeQuery("plant", "SELECT DISTINCT PlantName FROM [publish].[DASHt_Resources] WHERE PlantName IS NOT NULL ORDER BY PlantName"),
        safeQuery("resource", "SELECT DISTINCT ResourceName FROM [publish].[DASHt_Resources] WHERE ResourceName IS NOT NULL ORDER BY ResourceName"),
        safeQuery("product", "SELECT DISTINCT TOP 500 JobProduct AS ProductName FROM [publish].[DASHt_Planning] WHERE JobProduct IS NOT NULL ORDER BY JobProduct"),
        safeQuery("workcenter", "SELECT DISTINCT WorkcenterName FROM [publish].[DASHt_Resources] WHERE WorkcenterName IS NOT NULL ORDER BY WorkcenterName"),
      ]);

      let planningAreas = (planningAreaResult?.recordset || []).map((r: any) => r.PlanningAreaName).filter(Boolean);
      let scenarios = (scenarioResult?.recordset || []).map((r: any) => ({
        id: r.NewScenarioId,
        name: r.ScenarioName,
        type: r.ScenarioType
      })).filter((s: any) => s.id);
      let plants = (plantResult?.recordset || []).map((r: any) => r.PlantName).filter(Boolean);
      let resources = (resourceResult?.recordset || []).map((r: any) => r.ResourceName).filter(Boolean);
      let products = (productResult?.recordset || []).map((r: any) => r.ProductName).filter(Boolean);
      let workcenters = (workcenterResult?.recordset || []).map((r: any) => r.WorkcenterName).filter(Boolean);

      const dbQueriesReturned = planningAreas.length > 0 || plants.length > 0 || resources.length > 0 || products.length > 0 || workcenters.length > 0 || scenarios.length > 0;
      log(`[filter-options] DB query results: PA=${planningAreas.length}, Scenarios=${scenarios.length}, Plants=${plants.length}, Resources=${resources.length}, Products=${products.length}, WC=${workcenters.length}, anyReturned=${dbQueriesReturned}`, 'filter-options');

      if (!dbQueriesReturned && companyId) {
        log(`[filter-options] All Publish DB queries returned empty for company ${companyId}, falling back to company entitlements`, 'filter-options');
        try {
          const companyEntitlements = await getAllEntitlementsForCompany(companyId);
          if (companyEntitlements.length > 0) {
            const byScope = new Map<string, Set<string>>();
            for (const e of companyEntitlements) {
              if (!byScope.has(e.ScopeType)) byScope.set(e.ScopeType, new Set());
              byScope.get(e.ScopeType)!.add(e.ScopeValue);
            }
            planningAreas = [...(byScope.get('PlanningArea') || [])].sort();
            plants = [...(byScope.get('Plant') || [])].sort();
            resources = [...(byScope.get('Resource') || [])].sort();
            products = [...(byScope.get('Product') || [])].sort();
            workcenters = [...(byScope.get('Workcenter') || [])].sort();
            const scenarioVals = [...(byScope.get('Scenario') || [])].sort();
            scenarios = scenarioVals.map(s => ({ id: s, name: s, type: '' }));
            log(`[filter-options] Built filter options from ${companyEntitlements.length} company entitlements`, 'filter-options');
          }
        } catch (entErr: any) {
          log(`[filter-options] Company entitlements fallback failed: ${entErr.message}`, 'filter-options');
        }
      }

      const session = req.embedSession;
      const filterIsPtAdmin = session ? await checkUserHasPtAdminRole(session.companyId, session.email).catch(() => false) : false;
      const filterEffectiveAdmin = session ? (session.isCompanyAdmin || filterIsPtAdmin) : false;
      if (session && !filterEffectiveAdmin) {
        try {
          const entitlements = await getEntitlementsForUser(session.companyId, session.email);
          if (entitlements.length === 0) {
            return res.json({
              planningAreas: [],
              scenarios: [],
              plants: [],
              resources: [],
              products: [],
              workcenters: [],
              noEntitlements: true,
            });
          }

          const byScope = new Map<string, string[]>();
          for (const e of entitlements) {
            const vals = byScope.get(e.ScopeType) || [];
            vals.push(e.ScopeValue);
            byScope.set(e.ScopeType, vals);
          }

          const entitledPA = byScope.get('PlanningArea');
          if (entitledPA) {
            planningAreas = intersectFilterOptions(planningAreas, entitledPA, false);
          }

          const entitledScenarios = byScope.get('Scenario');
          if (entitledScenarios) {
            const entitled = new Set(entitledScenarios.map(s => s.toLowerCase()));
            scenarios = scenarios.filter((s: any) => entitled.has(s.id.toLowerCase()));
          }

          const entitledPlants = byScope.get('Plant');
          if (entitledPlants) {
            plants = intersectFilterOptions(plants, entitledPlants, false);
          }

          const entitledResources = byScope.get('Resource');
          if (entitledResources) {
            resources = intersectFilterOptions(resources, entitledResources, false);
          }

          const entitledProducts = byScope.get('Product');
          if (entitledProducts) {
            products = intersectFilterOptions(products, entitledProducts, false);
          }

          const entitledWorkcenters = byScope.get('Workcenter');
          if (entitledWorkcenters) {
            workcenters = intersectFilterOptions(workcenters, entitledWorkcenters, false);
          }
        } catch (entErr: any) {
          log(`[filter-options] Entitlement lookup failed, showing all options: ${entErr.message}`, 'permissions');
        }
      }

      res.json({
        planningAreas,
        scenarios,
        plants,
        resources,
        products,
        workcenters,
      });
    } catch (error: any) {
      log(`[filter-options] Error: ${error.message}`, "error");
      res.json({
        planningAreas: [],
        scenarios: [],
        plants: [],
        resources: [],
        products: [],
        workcenters: [],
      });
    }
  });

  // Validator self-check endpoint (development only)
  app.get("/api/validator-check", (_req, res) => {
    const { passed, results } = runValidatorSelfCheck();
    res.json({
      passed,
      results,
      timestamp: new Date().toISOString(),
    });
  });

  // ===== ADMIN ANALYTICS ENDPOINTS (PT admin role required) =====

  app.get("/api/admin/analytics", async (req, res) => {
    try {
      const session = req.embedSession!;
      const isPtAdmin = await checkUserHasPtAdminRole(session.companyId, session.email);
      if (!isPtAdmin) {
        return res.status(403).json({ error: 'PT Admin access required' });
      }
      const timeRange = req.query.timeRange ? parseInt(req.query.timeRange as string, 10) : 1440;
      const analytics = await getQueryAnalytics(timeRange);
      res.json(analytics);
    } catch (error: any) {
      log(`[admin-analytics] Error: ${error.message}`, 'error');
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  });

  app.get("/api/admin/analytics/failed-queries", async (req, res) => {
    try {
      const session = req.embedSession!;
      const isPtAdmin = await checkUserHasPtAdminRole(session.companyId, session.email);
      if (!isPtAdmin) {
        return res.status(403).json({ error: 'PT Admin access required' });
      }
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const failedQueries = await getFailedQueriesDb(limit);
      res.json(failedQueries);
    } catch (error: any) {
      log(`[admin-analytics] Error: ${error.message}`, 'error');
      res.status(500).json({ error: 'Failed to fetch failed queries' });
    }
  });

  // Serve query matrix HTML for team review
  app.get("/matrix", (_req, res) => {
    try {
      const matrixPath = join(process.cwd(), 'docs', 'query-matrix.html');
      const htmlContent = readFileSync(matrixPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.send(htmlContent);
    } catch (error: any) {
      log(`Failed to load query matrix: ${error.message}`, 'matrix');
      res.status(500).send('Failed to load query matrix');
    }
  });

  // Get semantic catalog with availability info
  app.get("/api/semantic-catalog", (_req, res) => {
    try {
      const catalogPath = join(process.cwd(), 'docs', 'semantic', 'semantic-catalog.json');
      const catalogContent = readFileSync(catalogPath, 'utf-8');
      const catalog = JSON.parse(catalogContent);
      res.json(catalog);
    } catch (error: any) {
      log(`Failed to load semantic catalog: ${error.message}`, 'semantic-catalog');
      res.status(500).json({
        error: 'Failed to load semantic catalog',
      });
    }
  });

  // Table discovery endpoint - lists discovered tables and scope availability
  app.get("/api/discovered-tables", async (_req, res) => {
    try {
      const status = getDiscoveryStatus();
      res.json(status);
    } catch (error: any) {
      log(`Failed to get discovery status: ${error.message}`, 'discovered-tables');
      res.status(500).json({
        error: 'Failed to get discovery status',
      });
    }
  });

  // Trigger table re-discovery (admin endpoint)
  app.post("/api/discovered-tables/refresh", async (req, res) => {
    // Security: Only allow in development or with valid DIAGNOSTICS_TOKEN
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const diagnosticsToken = process.env.DIAGNOSTICS_TOKEN;
    const providedToken = req.headers['x-diagnostics-token'];

    if (!isDevelopment && (!diagnosticsToken || providedToken !== diagnosticsToken)) {
      return res.status(403).json({
        error: 'Forbidden: Refresh endpoint requires DIAGNOSTICS_TOKEN in production',
      });
    }

    try {
      await runTableDiscovery();
      const status = getDiscoveryStatus();
      res.json({ success: true, ...status });
    } catch (error: any) {
      log(`Failed to refresh table discovery: ${error.message}`, 'discovered-tables');
      res.status(500).json({
        error: 'Failed to refresh table discovery',
      });
    }
  });


  // Get schema for tables (table->columns mapping)
  app.get("/api/schema/:tier", async (req, res) => {
    try {
      const tier = req.params.tier as string;
      
      // Load semantic catalog to get tables
      const catalogPath = join(process.cwd(), 'docs', 'semantic', 'semantic-catalog.json');
      const catalogContent = readFileSync(catalogPath, 'utf-8');
      const catalog = JSON.parse(catalogContent);
      
      // Get tables based on tier (default to tier1)
      let tables = catalog.tables?.tier1 || [];
      if (tier === 'tier2' || tier === 'all') {
        tables = [...tables, ...(catalog.tables?.tier2 || [])];
      }

      const schemas = await getSchemasForMode(tier, tables);
      
      // Convert Map to plain object for JSON serialization
      const schemasObj: Record<string, TableSchema> = {};
      for (const [tableName, schema] of Array.from(schemas)) {
        schemasObj[tableName] = schema;
      }
      
      res.json({ 
        tier, 
        tables: schemasObj,
        tableCount: schemas.size,
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      log(`Failed to get schema for tier ${req.params.tier}: ${error.message}`, 'schema');
      res.status(500).json({
        error: 'Failed to load schema',
        tables: {}
      });
    }
  });

  // Database connectivity check
  app.get("/api/db-check", async (req, res) => {
    try {
      const result = await runPublishQuery(
        req.embedSession?.companyId,
        'SELECT TOP (1) * FROM [publish].[DASHt_Planning]'
      );
      
      res.json({
        ok: true,
        rowCount: result.recordset.length,
        sample: result.recordset[0] || null,
      });
    } catch (error: any) {
      log(`Database check failed: ${error.message}`, 'db-check');
      res.status(500).json({
        ok: false,
        error: error.message || 'Database connection failed',
      });
    }
  });

  app.get("/api/db/publish-check", async (req, res) => {
    try {
      const companyId = req.embedSession?.companyId;
      const email = req.embedSession?.email;
      const steps: any[] = [];

      steps.push({ step: "session", companyId, email, hasSession: !!req.embedSession });

      if (!companyId) {
        return res.json({ ok: false, error: "No companyId in session", steps });
      }

      try {
        const dbConfig = await getPublishDbConfig(companyId);
        steps.push({
          step: "companyDbs-lookup",
          ok: true,
          server: dbConfig.DBServerName,
          database: dbConfig.DBName,
          user: dbConfig.DBUserName,
          passwordKey: dbConfig.DBPasswordKey,
          hasPassword: !!(process.env.PUBLISH_DB_PASSWORD || process.env[dbConfig.DBPasswordKey]),
        });
      } catch (err: any) {
        steps.push({ step: "companyDbs-lookup", ok: false, error: err.message });
        return res.json({ ok: false, error: "CompanyDbs lookup failed", steps });
      }

      try {
        const testResult = await executePublishQuery(companyId, "SELECT TOP 1 PlanningAreaName FROM [publish].[DASHt_Resources]");
        steps.push({
          step: "publish-query",
          ok: true,
          rowCount: testResult.recordset.length,
          sample: testResult.recordset[0] || null,
        });
      } catch (err: any) {
        steps.push({ step: "publish-query", ok: false, error: err.message });
        return res.json({ ok: false, error: "Publish DB query failed", steps });
      }

      try {
        const paResult = await executePublishQuery(companyId, "SELECT DISTINCT PlanningAreaName FROM [publish].[DASHt_Resources] WHERE PlanningAreaName IS NOT NULL");
        const plantResult = await executePublishQuery(companyId, "SELECT DISTINCT PlantName FROM [publish].[DASHt_Resources] WHERE PlantName IS NOT NULL");
        steps.push({
          step: "filter-values",
          ok: true,
          planningAreas: paResult.recordset.map((r: any) => r.PlanningAreaName),
          plants: plantResult.recordset.map((r: any) => r.PlantName),
        });
      } catch (err: any) {
        steps.push({ step: "filter-values", ok: false, error: err.message });
      }

      try {
        const entitlements = await getAllEntitlementsForCompany(companyId);
        steps.push({
          step: "company-entitlements",
          ok: true,
          count: entitlements.length,
          sample: entitlements.slice(0, 5).map(e => ({ scope: e.ScopeType, value: e.ScopeValue })),
        });
      } catch (err: any) {
        steps.push({ step: "company-entitlements", ok: false, error: err.message });
      }

      res.json({ ok: true, steps });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/last-update", async (req, res) => {
    try {
      const companyId = req.embedSession?.companyId;
      if (!companyId) {
        res.json({ ok: true, lastUpdate: null });
        return;
      }
      const result = await runPublishQuery(companyId, 'SELECT TOP (1) MAX(PublishDate) as lastUpdate FROM [publish].[DASHt_Planning]');
      const lastUpdate = result.recordset[0]?.lastUpdate || null;
      res.json({ ok: true, lastUpdate });
    } catch (error: any) {
      log(`Last update fetch failed: ${error.message}`, 'last-update');
      res.json({ ok: true, lastUpdate: null });
    }
  });

  // Database diagnostics endpoint - lists and validates access to publish.DASHt_* tables
  app.get("/api/db/diagnostics", async (req, res) => {
    // Security: Only allow in development or with valid DIAGNOSTICS_TOKEN
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const diagnosticsToken = process.env.DIAGNOSTICS_TOKEN;
    const providedToken = req.headers['x-diagnostics-token'];

    if (!isDevelopment && (!diagnosticsToken || providedToken !== diagnosticsToken)) {
      return res.status(403).json({
        error: 'Forbidden: Diagnostics endpoint is only available in development or with valid DIAGNOSTICS_TOKEN header',
      });
    }

    log('Running database diagnostics...', 'db-diagnostics');

    try {
      // Step 1: Query sys.tables to find all publish.DASHt_* tables
      const tablesQuery = `
        SELECT t.name
        FROM sys.tables t
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name = 'publish' 
          AND t.name LIKE 'DASHt[_]%' ESCAPE '\\'
        ORDER BY t.name
      `;

      const diagCompanyId = req.embedSession?.companyId;
      const tablesResult = await runPublishQuery(diagCompanyId, tablesQuery);
      const tableNames = tablesResult.recordset.map(row => row.name);

      log(`Found ${tableNames.length} DASHt tables`, 'db-diagnostics');

      // Step 2: Test access to each table
      const tableResults = await Promise.all(
        tableNames.map(async (tableName) => {
          try {
            const testQuery = `SELECT TOP (0) * FROM [publish].[${tableName}]`;
            await runPublishQuery(diagCompanyId, testQuery);
            
            return {
              table: tableName,
              accessible: true,
              error: null,
            };
          } catch (error: any) {
            // Log detailed error server-side, but return sanitized message to client
            log(`Failed to access table ${tableName}: ${error.message}`, 'db-diagnostics');
            
            // Sanitize error message - don't expose internal DB details
            let sanitizedError = 'Access denied';
            if (error.message?.toLowerCase().includes('invalid object name')) {
              sanitizedError = 'Table not found';
            } else if (error.message?.toLowerCase().includes('permission')) {
              sanitizedError = 'Permission denied';
            }
            
            return {
              table: tableName,
              accessible: false,
              error: sanitizedError,
            };
          }
        })
      );

      // Step 3: Compile results
      const accessibleCount = tableResults.filter(r => r.accessible).length;
      const failedCount = tableResults.filter(r => !r.accessible).length;

      const response = {
        timestamp: new Date().toISOString(),
        totalTables: tableNames.length,
        accessible: accessibleCount,
        failed: failedCount,
        tables: tableResults,
      };

      log(`Diagnostics complete: ${accessibleCount}/${tableNames.length} tables accessible`, 'db-diagnostics');

      res.json(response);

    } catch (error: any) {
      // Log detailed error server-side only
      log(`Diagnostics failed: ${error.message}`, 'db-diagnostics');
      
      // Return sanitized error to client - don't expose internal DB details
      res.status(500).json({
        error: 'Failed to run diagnostics. Check database connectivity and permissions.',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Streaming natural language to SQL query endpoint (SSE via GET for proxy compatibility)
  app.get("/api/ask/stream", async (req, res) => {
    log(`Stream request received, headers: ${JSON.stringify(req.headers)}`, 'ask-stream');
    
    // Read params from query string (GET is more proxy-friendly for SSE)
    const publishDate = String(req.query.publishDate ?? '');
    const question = String(req.query.question ?? req.query.query ?? req.query.q ?? req.query.prompt ?? '');
    const filterPlanningArea = req.query.filterPlanningArea ? String(req.query.filterPlanningArea) : null;
    const filterScenarioId = req.query.filterScenarioId ? String(req.query.filterScenarioId) : null;
    const filterPlant = req.query.filterPlant ? String(req.query.filterPlant) : null;
    const filterResource = req.query.filterResource ? String(req.query.filterResource) : null;
    const filterProduct = req.query.filterProduct ? String(req.query.filterProduct) : null;
    const filterWorkcenter = req.query.filterWorkcenter ? String(req.query.filterWorkcenter) : null;
    const filters = { planningArea: filterPlanningArea, scenarioId: filterScenarioId, plant: filterPlant, resource: filterResource, product: filterProduct, workcenter: filterWorkcenter };

    // Validate question parameter
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({
        error: 'Question is required and must be a non-empty string',
      });
    }

    log(`Stream request validated, question: ${question}`, 'ask-stream');

    // Track if client disconnected (SSE: watch the RESPONSE, not the request)
    let clientDisconnected = false;
    let keepAliveInterval: NodeJS.Timeout | null = null;

    // If the client goes away, the response closes
    res.on('close', () => {
      clientDisconnected = true;
      if (keepAliveInterval) clearInterval(keepAliveInterval);
      log('Client disconnected (res.close), aborting stream', 'ask-stream');
    });

    // If the client aborts mid-request (rare here, but correct)
    req.on('aborted', () => {
      clientDisconnected = true;
      if (keepAliveInterval) clearInterval(keepAliveInterval);
      log('Client aborted request (req.aborted), aborting stream', 'ask-stream');
    });

    // Set up SSE headers - optimized for Replit's proxy
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Encoding', 'identity');
    // Don't set Transfer-Encoding manually - let Node handle it
    res.flushHeaders();
    
    log('SSE headers sent and flushed', 'ask-stream');
    
    // Keep-alive interval to prevent proxy timeout
    keepAliveInterval = setInterval(() => {
      if (!clientDisconnected) {
        res.write(': keepalive\n\n');
      }
    }, 15000);

    // Helper to write with flush support for proxies
    const write = (s: string) => {
      if (clientDisconnected) return;
      res.write(s);
      // @ts-ignore - flush may exist on some response implementations
      if (typeof res.flush === 'function') res.flush();
    };

    // Helper to send SSE events (checks for disconnect)
    const sendEvent = (event: string, data: any) => {
      write(`event: ${event}\n`);
      write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial connected status
    sendEvent('status', { stage: 'connected', message: 'Connected' });
    sendEvent('status', { stage: 'after_connected', message: 'after_connected' });

    let generatedSql: string | undefined;
    let llmStartTime: number | undefined;
    let llmMs: number | undefined;

    try {
      log(`Processing question (streaming): ${question}`, 'ask-stream');

      // Classify INSIDE try so errors don't kill SSE immediately
      const questionType = await classifyQuestion(question);
      if (clientDisconnected) return;
      
      // Log classification result for debugging
      sendEvent('status', { stage: 'classified', questionType });
      
      if (questionType === 'general') {
        log(`General question detected (streaming): ${question}`, 'ask-stream');
        const answer = await answerGeneralQuestion(question);
        sendEvent('complete', {
          isGeneralAnswer: true,
          answer,
          question,
          dataLastUpdated: publishDate || null,
        });
        return;
      }

      // Send status update to keep connection alive (no chunk text - only stream results)
      sendEvent('status', { stage: 'generating_sql', message: 'Generating SQL query...' });

      // Generate SQL from natural language
      llmStartTime = Date.now();
      const sqlGenResult = await generateSqlFromQuestion(question, { publishDate, filters });
      generatedSql = sqlGenResult.sql;
      const selectedTables = sqlGenResult.selectedTables;
      const confidence = sqlGenResult.confidence;
      llmMs = Date.now() - llmStartTime;
      log(`Generated SQL (streaming): ${generatedSql}`, 'ask-stream');
      log(`Filters applied: scenarioId=${filters.scenarioId}, plant=${filters.plant}`, 'ask-stream');

      // Handle out-of-scope questions with low/no confidence
      if (confidence === 'none') {
        sendEvent('complete', {
          isOutOfScope: true,
          answer: `I couldn't find data matching your question in the available PowerBI reports.`,
          question,
          dataLastUpdated: publishDate || null,
        });
        return;
      }

      // Validate and modify SQL if needed
      const validationOptions: ValidationOptions = {};
      const validation = validateAndModifySql(generatedSql, validationOptions);

      
      if (!validation.valid) {
        log(`SQL validation failed (streaming): ${validation.error}`, 'ask-stream');
        logQuery({ CompanyId: req.embedSession!.companyId, UserEmail: req.embedSession!.email, QuestionText: question, GeneratedSql: generatedSql, RowCount: null, DurationMs: llmMs, LlmMs: llmMs, SqlMs: null, Success: false, ErrorMessage: validation.error || 'Unknown validation error', ErrorStage: 'validation' });
        sendEvent('error', { error: `SQL validation failed: ${validation.error}`, sql: generatedSql });
        return;
      }

      const finalSql = validation.modifiedSql || generatedSql;
      
      // Validate column references against schema
      const columnValidation = await validateSqlColumns(finalSql, selectedTables);
      if (!columnValidation.valid) {
        log(`Column validation failed (streaming): ${columnValidation.errors.length} errors - ${JSON.stringify(columnValidation.errors)}`, 'ask-stream');
        logQuery({ CompanyId: req.embedSession!.companyId, UserEmail: req.embedSession!.email, QuestionText: question, GeneratedSql: finalSql, RowCount: null, DurationMs: llmMs, LlmMs: llmMs, SqlMs: null, Success: false, ErrorMessage: 'Column validation failed', ErrorStage: 'validation' });
        
        const firstError = columnValidation.errors[0];
        let errorMessage = firstError.message;
        if (firstError.availableColumns && firstError.availableColumns.length > 0) {
          errorMessage += `\n\nDid you mean one of these? ${firstError.availableColumns.join(', ')}`;
        }
        
        sendEvent('error', { error: errorMessage, sql: finalSql, schemaError: true });
        return;
      }

      // Check for disconnect before continuing
      if (clientDisconnected) return;

      let enforcedSql = finalSql;
      let entitlementFilters: string[] = [];
      try {
        const isPtAdmin = await checkUserHasPtAdminRole(req.embedSession!.companyId, req.embedSession!.email).catch(() => false);
        const effectiveAdmin = req.embedSession!.isCompanyAdmin || isPtAdmin;
        const entitlements = effectiveAdmin ? [] : await getEntitlementsForUser(req.embedSession!.companyId, req.embedSession!.email);
        const entResult = enforceEntitlements(enforcedSql, entitlements, effectiveAdmin);
        if (!entResult.allowed) {
          log(`Entitlement denied: ${entResult.blockedReason}`, 'ask-stream');
          sendEvent('error', { error: entResult.blockedReason || 'Access denied', isPermissionDenied: true });
          return;
        }
        enforcedSql = entResult.modifiedSql || enforcedSql;
        entitlementFilters = entResult.appliedFilters || [];
        if (entitlementFilters.length > 0) {
          log(`Entitlement filters applied: ${entitlementFilters.join('; ')}`, 'ask-stream');
        }
      } catch (entErr: any) {
        log(`[ask-stream] Entitlement lookup failed — blocking query (fail-closed): ${entErr.message}`, 'ask-stream');
        sendEvent('error', { error: 'Unable to verify your data access permissions. Please try again later.', isPermissionDenied: true });
        return;
      }
      
      // Apply user-selected global filters (from dropdown selectors)
      const globalFilterResult = applyGlobalFilters(enforcedSql, filters);
      enforcedSql = globalFilterResult.modifiedSql;
      if (globalFilterResult.appliedFilters.length > 0) {
        log(`Global filters applied: ${globalFilterResult.appliedFilters.join('; ')}`, 'ask-stream');
      }

      // Send SQL to client
      sendEvent('sql', { sql: enforcedSql });
      sendEvent('status', { stage: 'executing_sql', message: 'Running query...' });

      // Execute the query
      const streamCompanyId = req.embedSession!.companyId;
      const sqlStartTime = Date.now();
      const result = await runPublishQuery(streamCompanyId, enforcedSql);
      const sqlMs = Date.now() - sqlStartTime;

      if (clientDisconnected) return;

      logQuery({ CompanyId: streamCompanyId, UserEmail: req.embedSession!.email, QuestionText: question, GeneratedSql: enforcedSql, RowCount: result.recordset.length, DurationMs: llmMs + sqlMs, LlmMs: llmMs, SqlMs: sqlMs, Success: true, ErrorMessage: null, ErrorStage: null });

      let actualTotalCount: number | undefined;
      if (result.recordset.length === 100) {
        try {
          const fromIndex = enforcedSql.toUpperCase().indexOf(' FROM ');
          if (fromIndex > -1) {
            let countSql = 'SELECT COUNT(*) AS TotalCount' + enforcedSql.substring(fromIndex);
            countSql = countSql.replace(/ORDER\s+BY\s+[^;]+/i, '');
            const countResult = await runPublishQuery(streamCompanyId, countSql);
            actualTotalCount = countResult.recordset[0]?.TotalCount;
          }
        } catch (countError: any) {
          log(`Failed to get total count (streaming): ${countError.message}`, 'ask-stream');
        }
      }

      if (clientDisconnected) return;

      // Send rows to client
      sendEvent('rows', { 
        rows: result.recordset, 
        rowCount: result.recordset.length,
        actualTotalCount 
      });

      // Stream the natural language response
      sendEvent('status', { stage: 'generating_answer', message: 'Generating answer...' });

      // Collect all applied filters for the response
      const allAppliedFilters = [
        ...entitlementFilters,
        ...(globalFilterResult.appliedFilters || [])
      ];

      const stream = streamNaturalLanguageResponse(
        question, 
        result.recordset, 
        result.recordset.length,
        actualTotalCount,
        allAppliedFilters
      );

      let fullAnswer = '';
      
      // Token buffering: batch small writes to reduce proxy disconnects
      let tokenBuffer = '';
      const BUFFER_FLUSH_SIZE = 20; // Flush when buffer reaches this size
      const BUFFER_FLUSH_INTERVAL = 50; // Or flush every 50ms
      let lastFlushTime = Date.now();
      
      const flushBuffer = () => {
        if (tokenBuffer.length > 0 && !clientDisconnected) {
          sendEvent('chunk', { text: tokenBuffer });
          tokenBuffer = '';
          lastFlushTime = Date.now();
        }
      };
      
      for await (const chunk of stream) {
        if (clientDisconnected) break; // Stop streaming if client disconnected
        fullAnswer += chunk;
        tokenBuffer += chunk;
        
        // Flush if buffer is large enough or enough time has passed
        const now = Date.now();
        if (tokenBuffer.length >= BUFFER_FLUSH_SIZE || (now - lastFlushTime) >= BUFFER_FLUSH_INTERVAL) {
          flushBuffer();
        }
      }
      
      // Flush any remaining buffered content
      flushBuffer();

      if (clientDisconnected) return;

      // Cache successful SQL (cache base SQL before filters, so filters can be reapplied on cache hits)
      cacheSuccessfulSql(question, finalSql, selectedTables);

      // Get suggestions asynchronously
      const suggestions = await generateSuggestions(question);

      // Send completion event
      sendEvent('complete', {
        answer: fullAnswer,
        sql: enforcedSql,
        rowCount: result.recordset.length,
        actualTotalCount,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        dataLastUpdated: publishDate || null,
      });

    } catch (error: any) {
      log(`Error in /api/ask/stream: ${error.message}`, 'ask-stream');

      // Only log to query logger if context was created
      if (req.embedSession) {
        const errorStage = generatedSql ? 'execution' : 'generation';
        logQuery({ CompanyId: req.embedSession.companyId, UserEmail: req.embedSession.email, QuestionText: question, GeneratedSql: generatedSql || null, RowCount: null, DurationMs: llmMs || 0, LlmMs: llmMs, SqlMs: null, Success: false, ErrorMessage: error.message || 'Failed to process query', ErrorStage: errorStage });
      }

      sendEvent('error', { error: error.message || 'Failed to process query' });
    } finally {
      if (keepAliveInterval) clearInterval(keepAliveInterval);
      res.end();
    }
  });

  // Natural language to SQL query endpoint
  app.post("/api/ask", async (req, res) => {
    const publishDate = req.body?.publishDate;
    const question =
      req.body?.question ??
      req.body?.query ??
      req.body?.q ??
      req.body?.prompt;
    const filters = req.body?.filters || { planningArea: null, scenarioId: null, plant: null, resource: null, product: null, workcenter: null };

    // Validate question parameter
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({
        error: 'Question is required and must be a non-empty string',
      });
    }

    // Classify the question: is it a data query or a general/help question?
    const questionType = await classifyQuestion(question);
    
    if (questionType === 'general') {
      log(`General question detected: ${question}`, 'ask');
      const answer = await answerGeneralQuestion(question);
      return res.json({
        isGeneralAnswer: true,
        answer,
        question,
      });
    }

    log(`Processing question: ${question}`, 'ask');

    let generatedSql: string | undefined;
    let llmStartTime: number | undefined;
    let llmMs: number | undefined;

    try {
      // Generate SQL from natural language
      // Matrix classifier selects relevant tables dynamically
      llmStartTime = Date.now();
      const sqlGenResult = await generateSqlFromQuestion(question, { publishDate, filters });
      generatedSql = sqlGenResult.sql;
      const selectedTables = sqlGenResult.selectedTables;
      const confidence = sqlGenResult.confidence;
      llmMs = Date.now() - llmStartTime;
      log(`Generated SQL: ${generatedSql}`, 'ask');
      log(`Matrix-selected tables: ${selectedTables.join(', ')} (confidence: ${confidence})`, 'ask');
      log(`Filters applied: scenario=${filters.scenario}, plant=${filters.plant}`, 'ask');

      // Handle out-of-scope questions with low/no confidence
      if (confidence === 'none') {
        return res.json({
          isOutOfScope: true,
          answer: `I couldn't find data matching your question in the available PowerBI reports. The system covers:\n\n` +
            `- **Capacity**: Resource utilization, demand vs capacity, shifts, overtime\n` +
            `- **Production**: Jobs, operations, schedules, due dates, lateness, priorities\n` +
            `- **Finance**: Sales orders, purchase orders, inventory levels, materials\n\n` +
            `Try rephrasing your question using terms like: jobs, resources, capacity, demand, orders, inventory, schedule, due date, or lateness.`,
          question,
        });
      }

      // Validate and modify SQL if needed (no table allowlist - all publish.* tables are allowed)
      const validationOptions: ValidationOptions = {};
      const validation = validateAndModifySql(generatedSql, validationOptions);
      
      if (!validation.valid) {
        log(`SQL validation failed: ${validation.error}`, 'ask');
        
        logQuery({ CompanyId: req.embedSession!.companyId, UserEmail: req.embedSession!.email, QuestionText: question, GeneratedSql: generatedSql, RowCount: null, DurationMs: llmMs, LlmMs: llmMs, SqlMs: null, Success: false, ErrorMessage: validation.error || 'Unknown validation error', ErrorStage: 'validation' });

        return res.status(400).json({
          error: `SQL validation failed: ${validation.error}`,
          sql: generatedSql,
          isMock: false,
        });
      }

      const finalSql = validation.modifiedSql || generatedSql;
      
      // Validate column references against schema (use matrix-selected tables)
      const columnValidation = await validateSqlColumns(finalSql, selectedTables);
      if (!columnValidation.valid) {
        log(`🔴 COLUMN VALIDATION FAILED: ${columnValidation.errors.length} errors found`, 'ask');
        
        for (const error of columnValidation.errors) {
          log(`  - ${error.message}`, 'ask');
        }
        
        logQuery({ CompanyId: req.embedSession!.companyId, UserEmail: req.embedSession!.email, QuestionText: question, GeneratedSql: finalSql, RowCount: null, DurationMs: llmMs, LlmMs: llmMs, SqlMs: null, Success: false, ErrorMessage: `Column validation failed: ${columnValidation.errors.map(e => e.message).join('; ')}`, ErrorStage: 'validation' });
        
        // Detect scope-mismatch using semantic catalog keywords
        const questionLower = question.toLowerCase();
        
        // Build helpful error message with fuzzy suggestions
        const firstError = columnValidation.errors[0];
        let errorMessage = firstError.message;
        if (firstError.availableColumns && firstError.availableColumns.length > 0) {
          errorMessage += `\n\nDid you mean one of these? ${firstError.availableColumns.join(', ')}`;
        }
        
        return res.status(400).json({
          error: errorMessage,
          sql: finalSql,
          isMock: false,
          schemaError: true,
          invalidColumns: columnValidation.errors.map(e => e.column),
        });
      }
      
      // Log column mapping suggestions if any
      if (columnValidation.warnings.length > 0) {
        log(`Column mapping suggestions:`, 'ask');
        for (const warning of columnValidation.warnings) {
          log(`  ${warning.originalColumn} → ${warning.suggestedColumn} (${warning.table})`, 'ask');
        }
      }
      
      let enforcedSql = finalSql;
      try {
        const isPtAdmin = await checkUserHasPtAdminRole(req.embedSession!.companyId, req.embedSession!.email).catch(() => false);
        const effectiveAdmin = req.embedSession!.isCompanyAdmin || isPtAdmin;
        const entitlements = effectiveAdmin ? [] : await getEntitlementsForUser(req.embedSession!.companyId, req.embedSession!.email);
        const entResult = enforceEntitlements(enforcedSql, entitlements, effectiveAdmin);
        if (!entResult.allowed) {
          log(`Entitlement denied: ${entResult.blockedReason}`, 'ask');
          return res.status(403).json({
            error: entResult.blockedReason || 'Access denied',
            isPermissionDenied: true,
          });
        }
        enforcedSql = entResult.modifiedSql || enforcedSql;
        if (entResult.appliedFilters && entResult.appliedFilters.length > 0) {
          log(`Entitlement filters applied: ${entResult.appliedFilters.join('; ')}`, 'ask');
        }
      } catch (entErr: any) {
        log(`[ask] Entitlement lookup failed — blocking query (fail-closed): ${entErr.message}`, 'ask');
        return res.status(503).json({
          error: 'Unable to verify your data access permissions. Please try again later.',
          isPermissionDenied: true,
        });
      }
      
      // Apply user-selected global filters (from dropdown selectors)
      const globalFilterResult = applyGlobalFilters(enforcedSql, filters);
      enforcedSql = globalFilterResult.modifiedSql;
      if (globalFilterResult.appliedFilters.length > 0) {
        log(`Global filters applied: ${globalFilterResult.appliedFilters.join('; ')}`, 'ask');
      }
      
      log(`Executing SQL: ${enforcedSql}`, 'ask');

      // Execute the query
      const askCompanyId = req.embedSession!.companyId;
      const sqlStartTime = Date.now();
      const result = await runPublishQuery(askCompanyId, enforcedSql);
      const sqlMs = Date.now() - sqlStartTime;

      logQuery({ CompanyId: askCompanyId, UserEmail: req.embedSession!.email, QuestionText: question, GeneratedSql: enforcedSql, RowCount: result.recordset.length, DurationMs: llmMs + sqlMs, LlmMs: llmMs, SqlMs: sqlMs, Success: true, ErrorMessage: null, ErrorStage: null });

      // Generate "did you mean?" suggestions asynchronously
      const suggestions = await generateSuggestions(question);

      // Get actual total count if results were limited to 100
      let actualTotalCount: number | undefined;
      if (result.recordset.length === 100) {
        try {
          // Build a count query from the original SQL
          // Extract the FROM clause and everything after it
          const fromIndex = enforcedSql.toUpperCase().indexOf(' FROM ');
          if (fromIndex > -1) {
            let countSql = 'SELECT COUNT(*) AS TotalCount' + enforcedSql.substring(fromIndex);
            // Remove ORDER BY clause for count query
            countSql = countSql.replace(/ORDER\s+BY\s+[^;]+/i, '');
            const countResult = await runPublishQuery(askCompanyId, countSql);
            actualTotalCount = countResult.recordset[0]?.TotalCount;
            log(`Actual total count: ${actualTotalCount} (showing first 100)`, 'ask');
          }
        } catch (countError: any) {
          log(`Failed to get total count: ${countError.message}`, 'ask');
        }
      }

      // Check for empty results and find nearest dates if applicable
      let nearestDates: { before: string | null; after: string | null } | undefined;
      let invalidFilterMessage: string | undefined;
      
      if (result.recordset.length === 0) {
        const tableMatch = enforcedSql.match(/FROM\s+(\[?publish\]?\.\[?\w+\]?)/i);
        const tableName = tableMatch ? tableMatch[1].replace(/\[/g, '').replace(/\]/g, '') : null;
        
        // Check for common filter patterns that might have invalid values
        const filterPatterns = [
          { regex: /PlanningAreaName\s*=\s*'([^']+)'/i, column: 'PlanningAreaName', label: 'planning area' },
          { regex: /PlantName\s*=\s*'([^']+)'/i, column: 'PlantName', label: 'plant' },
          { regex: /DepartmentName\s*=\s*'([^']+)'/i, column: 'DepartmentName', label: 'department' },
          { regex: /ResourceName\s*=\s*'([^']+)'/i, column: 'ResourceName', label: 'resource' },
          { regex: /JobProduct\s*=\s*'([^']+)'/i, column: 'JobProduct', label: 'product' },
        ];
        
        for (const pattern of filterPatterns) {
          const match = enforcedSql.match(pattern.regex);
          if (match && tableName) {
            const userValue = match[1];
            try {
              // Check if the value exists in the database
              const checkQuery = `SELECT DISTINCT TOP 10 ${pattern.column} FROM ${tableName} WHERE ${pattern.column} IS NOT NULL ORDER BY ${pattern.column}`;
              const checkResult = await runPublishQuery(askCompanyId, checkQuery);
              const validValues = checkResult.recordset.map((r: any) => r[pattern.column]);
              
              if (validValues.length > 0 && !validValues.some((v: string) => v.toLowerCase() === userValue.toLowerCase())) {
                // Value doesn't exist - provide helpful suggestion
                invalidFilterMessage = `The ${pattern.label} "${userValue}" doesn't exist. Available ${pattern.label}s include: ${validValues.slice(0, 5).join(', ')}${validValues.length > 5 ? '...' : ''}.`;
                log(`Invalid filter value: ${pattern.label} "${userValue}" not found. Valid values: ${validValues.join(', ')}`, 'ask');
              }
            } catch (filterError: any) {
              log(`Failed to validate filter value: ${filterError.message}`, 'ask');
            }
            break; // Only check the first matching filter pattern
          }
        }
        
        // Check if the query involves date filtering - look for common date columns
        if (!invalidFilterMessage) {
          const dateColumns = ['DemandDate', 'CapacityDate', 'ShiftDate', 'JobScheduledStartDateTime', 'PublishDate', 'RequiredAvailableDate'];
          
          // Find which date column is used in the query
          let detectedDateColumn: string | null = null;
          for (const col of dateColumns) {
            if (enforcedSql.toLowerCase().includes(col.toLowerCase())) {
              detectedDateColumn = col;
              break;
            }
          }
          
          if (detectedDateColumn && tableName) {
            try {
              // Get the overall date range available in the table (excluding sentinel dates)
              const rangeQuery = `SELECT MIN(${detectedDateColumn}) AS MinDate, MAX(CASE WHEN ${detectedDateColumn} < '2100-01-01' THEN ${detectedDateColumn} ELSE NULL END) AS MaxDate FROM ${tableName} WHERE ${detectedDateColumn} > '1900-01-01'`;
              const rangeResult = await runPublishQuery(askCompanyId, rangeQuery);
              
              const minDate = rangeResult.recordset[0]?.MinDate;
              const maxDate = rangeResult.recordset[0]?.MaxDate;
              
              if (minDate || maxDate) {
                nearestDates = {
                  before: minDate ? new Date(minDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null,
                  after: maxDate ? new Date(maxDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null,
                };
                log(`No data found. Earliest: ${nearestDates.before}, Latest: ${nearestDates.after}`, 'ask');
              }
            } catch (nearestError: any) {
              log(`Failed to find available date range: ${nearestError.message}`, 'ask');
            }
          }
        }
      }

      // Generate natural language response from results
      let naturalAnswer: string;
      
      // If we detected an invalid filter value, use that message instead
      if (invalidFilterMessage) {
        naturalAnswer = invalidFilterMessage;
      } else {
        naturalAnswer = await generateNaturalLanguageResponse(
          question, 
          result.recordset, 
          result.recordset.length,
          actualTotalCount
        );
      }

      // Cache successful SQL (cache base SQL before filters, so filters can be reapplied on cache hits)
      cacheSuccessfulSql(question, finalSql, selectedTables);

      res.json({
        answer: naturalAnswer,
        sql: enforcedSql,
        rows: result.recordset,
        rowCount: result.recordset.length,
        actualTotalCount,
        isMock: false,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        nearestDates,
        invalidFilter: invalidFilterMessage ? true : undefined,
        dataLastUpdated: publishDate || null,
      });

    } catch (error: any) {
      log(`Error in /api/ask: ${error.message}`, 'ask');

      // Determine error stage and log appropriately
      if (generatedSql) {
        // Error during SQL execution (use validated SQL if available)
        const validationOptions: ValidationOptions = {};
        const validation = validateAndModifySql(generatedSql, validationOptions);
        const failedSql = validation.modifiedSql || generatedSql;
        
        // Detect invalid column name errors (schema mismatch)
        const invalidColumnMatch = error.message?.match(/Invalid column name '([^']+)'/i);
        if (invalidColumnMatch) {
          const invalidColumn = invalidColumnMatch[1];
          log(`🔴 SCHEMA MISMATCH: OpenAI generated SQL with invalid column '${invalidColumn}'`, 'ask');
          log(`Generated SQL with invalid column: ${failedSql}`, 'ask');
          log(`Question: ${question}`, 'ask');
          
          // Return helpful error message to user
          return res.status(500).json({
            error: `Schema mismatch: Column '${invalidColumn}' does not exist in the database. This is an AI generation error.`,
            sql: failedSql,
            isMock: false,
            schemaError: true,
            invalidColumn,
          });
        }
        
        logQuery({ CompanyId: req.embedSession!.companyId, UserEmail: req.embedSession!.email, QuestionText: question, GeneratedSql: failedSql, RowCount: null, DurationMs: llmMs || 0, LlmMs: llmMs, SqlMs: null, Success: false, ErrorMessage: error.message || 'Failed to execute query', ErrorStage: 'execution' });
      } else {
        logQuery({ CompanyId: req.embedSession!.companyId, UserEmail: req.embedSession!.email, QuestionText: question, GeneratedSql: null, RowCount: null, DurationMs: 0, LlmMs: null, SqlMs: null, Success: false, ErrorMessage: error.message || 'Failed to generate SQL', ErrorStage: 'generation' });
      }

      res.status(500).json({
        error: error.message || 'Failed to process query',
        isMock: false,
      });
    }
  });

  return httpServer;
}

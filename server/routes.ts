import type { Express } from "express";
import { createServer, type Server } from "http";
import { executeQuery } from "./db-azure";
import { validateAndModifySql, runValidatorSelfCheck, type ValidationOptions } from "./sql-validator";
import { generateSqlFromQuestion, generateSuggestions, classifyQuestion, answerGeneralQuestion, generateNaturalLanguageResponse, streamNaturalLanguageResponse, cacheSuccessfulSql } from "./openai-client";
import { log } from "./index";
import {
  createQueryLogContext,
  logSuccess,
  getNegativeFeedback,
  logValidationFailure,
  logExecutionFailure,
  logGenerationFailure,
  trackQueryForFAQ,
  getPopularQuestions,
  storeFeedback,
  getFeedbackStats,
  getAnalytics,
  getFailedQueries,
} from "./query-logger";
import { getValidatedQuickQuestions } from "./quick-questions";
import { getSchemasForMode, formatSchemaForPrompt, TableSchema } from "./schema-introspection";
import { validateSqlColumns } from "./sql-column-validator";
import { readFileSync } from "fs";
import { join } from "path";
import { 
  getDiscoveryStatus, 
  runTableDiscovery 
} from "./table-discovery";
import {
  initPermissions,
  getAllUserPermissions,
  getUserPermissions,
  getUserPermissionsByUsername,
  createOrUpdateUserPermissions,
  deleteUserPermissions,
} from "./permissions-storage";
import { userPermissionsSchema, tableAccessOptions, entitlementSaveSchema, SCOPE_TYPES } from "@shared/schema";
import { enforcePermissions, getPermissionsForRequest, applyGlobalFilters, enforceEntitlements, intersectFilterOptions } from "./query-permissions";
import { handleSessionFromEmbed, requireAdmin } from "./embed-auth";
import {
  getUsersWithEntitlementStatus,
  getEntitlementsForUser,
  getEntitlementsByScope,
  replaceEntitlements,
  upsertUser,
} from "./entitlement-storage";
import { syncMembership } from "./membership-sync";
import { getFavoritesForUser, addFavorite as addFavoriteDb, removeFavorite as removeFavoriteDb } from "./favorites-storage";
import { isWebAppConfigured } from "./db-webapp";
import { executePublishQuery } from "./db-publish";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Embed auth: create session from JWT token
  app.post("/api/session/from-embed", handleSessionFromEmbed);

  // Get current session info
  app.get("/api/session", (req, res) => {
    if (!req.embedSession) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    res.json({
      email: req.embedSession.email,
      companyId: req.embedSession.companyId,
      isCompanyAdmin: req.embedSession.isCompanyAdmin,
      hasAIAnalyticsRole: req.embedSession.hasAIAnalyticsRole,
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
        Product: "SELECT DISTINCT ProductName AS value FROM [publish].[DASHt_Planning] WHERE ProductName IS NOT NULL ORDER BY ProductName",
        Workcenter: "SELECT DISTINCT WorkcenterName AS value FROM [publish].[DASHt_Resources] WHERE WorkcenterName IS NOT NULL ORDER BY WorkcenterName",
      };

      const query = scopeQueries[scopeType];
      if (!query) {
        return res.status(400).json({ error: `No query defined for scope type: ${scopeType}` });
      }

      const companyId = req.embedSession!.companyId;
      let result;
      try {
        result = await executePublishQuery(companyId, query);
      } catch (publishErr: any) {
        log(`[admin-entitlements] Publish DB query failed for company ${companyId}, falling back to default: ${publishErr.message}`, 'admin-entitlements');
        result = await executeQuery(query);
      }
      const values = (result?.recordset || []).map((r: any) => r.value).filter(Boolean);
      res.json({ scopeType, values });
    } catch (error: any) {
      log(`[admin-entitlements] Error fetching scope values: ${error.message}`, 'error');
      res.status(500).json({ error: 'Failed to fetch scope values' });
    }
  });

  // Get entitlements for the current user (for query page filter constraining)
  app.get("/api/my-entitlements", async (req, res) => {
    try {
      if (!req.embedSession) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { companyId, email, isCompanyAdmin } = req.embedSession;

      if (isCompanyAdmin) {
        return res.json({ isAdmin: true, entitlements: [], scopeTypes: SCOPE_TYPES });
      }

      const entitlements = await getEntitlementsForUser(companyId, email);
      res.json({ isAdmin: false, entitlements, scopeTypes: SCOPE_TYPES });
    } catch (error: any) {
      log(`[entitlements] Error fetching my entitlements: ${error.message}`, 'error');
      res.status(500).json({ error: 'Failed to fetch entitlements' });
    }
  });

  app.get("/api/my-favorites", async (req, res) => {
    try {
      if (!req.embedSession) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { companyId, email } = req.embedSession;
      const rows = await getFavoritesForUser(companyId, email);
      const favorites = rows.map(r => ({
        question: r.QuestionText,
        savedAt: r.CreatedAt,
      }));
      res.json({ favorites });
    } catch (error: any) {
      log(`[favorites] Error fetching favorites: ${error.message}`, 'error');
      res.status(500).json({ error: 'Failed to fetch favorites' });
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
      const planningAreaResult = await executeQuery(
        "SELECT DISTINCT PlanningAreaName FROM [publish].[DASHt_Resources] WHERE PlanningAreaName IS NOT NULL ORDER BY PlanningAreaName"
      );
      let planningAreas = (planningAreaResult?.recordset || []).map((r: any) => r.PlanningAreaName).filter(Boolean);

      const scenarioResult = await executeQuery(
        `SELECT DISTINCT NewScenarioId, ScenarioName, ScenarioType 
         FROM [publish].[DASHt_Planning] 
         WHERE NewScenarioId IS NOT NULL 
         ORDER BY ScenarioType, ScenarioName`
      );
      let scenarios = (scenarioResult?.recordset || []).map((r: any) => ({
        id: r.NewScenarioId,
        name: r.ScenarioName,
        type: r.ScenarioType
      })).filter((s: any) => s.id);

      const plantResult = await executeQuery(
        "SELECT DISTINCT PlantName FROM [publish].[DASHt_Resources] WHERE PlantName IS NOT NULL ORDER BY PlantName"
      );
      let plants = (plantResult?.recordset || []).map((r: any) => r.PlantName).filter(Boolean);

      const session = req.embedSession;
      if (session && !session.isCompanyAdmin) {
        try {
          const entitlements = await getEntitlementsForUser(session.companyId, session.email);
          if (entitlements.length === 0) {
            return res.json({
              planningAreas: ["All Planning Areas"],
              scenarios: [],
              plants: ["All Plants"],
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
        } catch (entErr: any) {
          log(`[filter-options] Entitlement lookup failed, showing all options: ${entErr.message}`, 'permissions');
        }
      }

      res.json({
        planningAreas: ["All Planning Areas", ...planningAreas],
        scenarios: scenarios,
        plants: ["All Plants", ...plants]
      });
    } catch (error: any) {
      log(`[filter-options] Error: ${error.message}`, "error");
      res.json({
        planningAreas: ["All Planning Areas"],
        scenarios: [],
        plants: ["All Plants"]
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

  // Get popular questions for FAQ
  app.get("/api/popular-questions", (_req, res) => {
    const questions = getPopularQuestions(10);
    res.json({ questions });
  });

  // Submit feedback for a query result
  app.post("/api/feedback", (req, res) => {
    const { question, sql, feedback, comment } = req.body;

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Question is required' });
    }
    if (!sql || typeof sql !== 'string') {
      return res.status(400).json({ error: 'SQL is required' });
    }
    if (!feedback || (feedback !== 'up' && feedback !== 'down')) {
      return res.status(400).json({ error: 'Feedback must be "up" or "down"' });
    }

    storeFeedback(question, sql, feedback, comment);
    log(`Feedback received: ${feedback} for question: ${question.substring(0, 50)}...`, 'feedback');

    res.json({ success: true });
  });

  // Get feedback statistics
  app.get("/api/feedback/stats", (_req, res) => {
    const stats = getFeedbackStats();
    res.json(stats);
  });

  // Get negative feedback (thumbs down) for analysis
  app.get("/api/feedback/negative", (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const negativeFeedback = getNegativeFeedback(limit);
    res.json({ feedback: negativeFeedback, count: negativeFeedback.length });
  });

  // Get analytics data for dashboard
  app.get("/api/analytics", (req, res) => {
    const timeRange = req.query.timeRange ? parseInt(req.query.timeRange as string, 10) : 1440; // 24 hours
    const analytics = getAnalytics(timeRange);
    res.json(analytics);
  });

  // Get failed queries for analysis (includes full SQL and error details)
  app.get("/api/analytics/failed-queries", (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const failedQueries = getFailedQueries(limit);
    res.json(failedQueries);
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

  // Get validated quick questions for a report/mode
  // Popular queries (with results) are shown first, then static questions fill remaining slots
  app.get("/api/quick-questions/:reportId", async (req, res) => {
    try {
      const reportId = req.params.reportId;
      const maxQuestions = 5;
      
      // Get popular questions (queries run multiple times with results)
      const popularQueries = getPopularQuestions(maxQuestions);
      const variedIcons = ['📊', '📈', '🔍', '💡', '⚡', '🎯', '📋', '✨'];
      const popularAsQuestions = popularQueries.map((q, idx) => ({
        text: q.question,
        icon: idx === 0 ? '🔥' : variedIcons[(idx - 1) % variedIcons.length],
        isPopular: true,
        runCount: q.count
      }));
      
      // Get static quick questions from cache (validated at startup)
      const staticQuestions = getValidatedQuickQuestions(reportId);
      
      // Merge: popular first, then fill with static (avoiding duplicates)
      const popularTexts = new Set(popularQueries.map(q => q.question.toLowerCase()));
      const filteredStatic = staticQuestions.filter(
        q => !popularTexts.has(q.text.toLowerCase())
      );
      
      // Combine: popular queries first, then static to fill remaining slots
      const combined = [
        ...popularAsQuestions,
        ...filteredStatic.slice(0, maxQuestions - popularAsQuestions.length)
      ].slice(0, maxQuestions);
      
      log(`Quick questions for ${reportId}: ${popularAsQuestions.length} popular + ${combined.length - popularAsQuestions.length} static`, 'quick-questions');
      res.json({ questions: combined, reportId });
    } catch (error: any) {
      log(`Failed to get quick questions for report ${req.params.reportId}: ${error.message}`, 'quick-questions');
      res.status(500).json({
        error: 'Failed to load quick questions',
        questions: [] // Return empty array on error
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
  app.get("/api/db-check", async (_req, res) => {
    try {
      const result = await executeQuery(
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

  // Get latest publish date from DASHt_Planning
  app.get("/api/last-update", async (_req, res) => {
    try {
      const result = await executeQuery(
        'SELECT TOP (1) MAX(PublishDate) as lastUpdate FROM [publish].[DASHt_Planning]'
      );
      
      const lastUpdate = result.recordset[0]?.lastUpdate || null;
      log(`PublishDate from database: ${lastUpdate}`, 'last-update');
      
      res.json({
        ok: true,
        lastUpdate,
      });
    } catch (error: any) {
      log(`Last update fetch failed: ${error.message}`, 'last-update');
      res.status(500).json({
        ok: false,
        error: 'Failed to fetch last update date',
      });
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

      const tablesResult = await executeQuery(tablesQuery);
      const tableNames = tablesResult.recordset.map(row => row.name);

      log(`Found ${tableNames.length} DASHt tables`, 'db-diagnostics');

      // Step 2: Test access to each table
      const tableResults = await Promise.all(
        tableNames.map(async (tableName) => {
          try {
            // Use SELECT TOP (0) to avoid reading any actual data
            const testQuery = `SELECT TOP (0) * FROM [publish].[${tableName}]`;
            await executeQuery(testQuery);
            
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
    const filters = { planningArea: filterPlanningArea, scenarioId: filterScenarioId, plant: filterPlant };

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

    let logContext: ReturnType<typeof createQueryLogContext> | undefined;
    let generatedSql: string | undefined;
    let llmStartTime: number | undefined;
    let llmMs: number | undefined;

    try {
      log(`Processing question (streaming): ${question}`, 'ask-stream');
      logContext = createQueryLogContext(req, question);

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
        logValidationFailure(logContext, generatedSql, validation.error || 'Unknown validation error', llmMs);
        sendEvent('error', { error: `SQL validation failed: ${validation.error}`, sql: generatedSql });
        return;
      }

      const finalSql = validation.modifiedSql || generatedSql;
      
      // Validate column references against schema
      const columnValidation = await validateSqlColumns(finalSql, selectedTables);
      if (!columnValidation.valid) {
        log(`Column validation failed (streaming): ${columnValidation.errors.length} errors - ${JSON.stringify(columnValidation.errors)}`, 'ask-stream');
        logValidationFailure(logContext, finalSql, `Column validation failed`, llmMs);
        
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

      // Apply user permission enforcement (filter by planning area, scenario, plant)
      const permContext = getPermissionsForRequest(req);
      const permResult = enforcePermissions(finalSql, permContext);
      
      if (!permResult.allowed) {
        log(`Permission denied: ${permResult.blockedReason}`, 'ask-stream');
        sendEvent('error', { error: permResult.blockedReason || 'Access denied', isPermissionDenied: true });
        return;
      }
      
      let enforcedSql = permResult.modifiedSql || finalSql;
      if (permResult.appliedFilters && permResult.appliedFilters.length > 0) {
        log(`Permission filters applied: ${permResult.appliedFilters.join('; ')}`, 'ask-stream');
      }

      if (req.embedSession) {
        try {
          const entitlements = await getEntitlementsForUser(req.embedSession.companyId, req.embedSession.email);
          const entResult = enforceEntitlements(enforcedSql, entitlements, req.embedSession.isCompanyAdmin);
          if (!entResult.allowed) {
            log(`Entitlement denied: ${entResult.blockedReason}`, 'ask-stream');
            sendEvent('error', { error: entResult.blockedReason || 'Access denied', isPermissionDenied: true });
            return;
          }
          enforcedSql = entResult.modifiedSql || enforcedSql;
          if (entResult.appliedFilters && entResult.appliedFilters.length > 0) {
            log(`Entitlement filters applied: ${entResult.appliedFilters.join('; ')}`, 'ask-stream');
          }
        } catch (entErr: any) {
          log(`[ask-stream] Entitlement lookup failed — blocking query (fail-closed): ${entErr.message}`, 'ask-stream');
          sendEvent('error', { error: 'Unable to verify your data access permissions. Please try again later.', isPermissionDenied: true });
          return;
        }
      }
      
      // Apply user-selected global filters (from dropdown selectors)
      const globalFilterResult = applyGlobalFilters(enforcedSql, {
        planningArea: filters.planningArea,
        scenarioId: filters.scenarioId,
        plant: filters.plant,
      });
      enforcedSql = globalFilterResult.modifiedSql;
      if (globalFilterResult.appliedFilters.length > 0) {
        log(`Global filters applied: ${globalFilterResult.appliedFilters.join('; ')}`, 'ask-stream');
      }

      // Send SQL to client
      sendEvent('sql', { sql: enforcedSql });
      sendEvent('status', { stage: 'executing_sql', message: 'Running query...' });

      // Execute the query
      const sqlStartTime = Date.now();
      const result = await executeQuery(enforcedSql);
      const sqlMs = Date.now() - sqlStartTime;

      if (clientDisconnected) return;

      // Log successful execution
      logSuccess(logContext, enforcedSql, result.recordset.length, llmMs, sqlMs);
      trackQueryForFAQ(question, result.recordset.length);

      // Get actual total count if results were limited to 100
      let actualTotalCount: number | undefined;
      if (result.recordset.length === 100) {
        try {
          const fromIndex = enforcedSql.toUpperCase().indexOf(' FROM ');
          if (fromIndex > -1) {
            let countSql = 'SELECT COUNT(*) AS TotalCount' + enforcedSql.substring(fromIndex);
            countSql = countSql.replace(/ORDER\s+BY\s+[^;]+/i, '');
            const countResult = await executeQuery(countSql);
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
        ...(permResult.appliedFilters || []),
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
      if (logContext) {
        if (generatedSql) {
          const validationOptions: ValidationOptions = {};
          const validation = validateAndModifySql(generatedSql, validationOptions);
          const failedSql = validation.modifiedSql || generatedSql;
          logExecutionFailure(logContext, failedSql, error.message || 'Failed to execute query', llmMs);
        } else {
          logGenerationFailure(logContext, error.message || 'Failed to generate SQL');
        }
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
    const filters = req.body?.filters || { planningArea: null, scenarioId: null, plant: null };

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

    // Create query log context
    const logContext = createQueryLogContext(req, question);
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
        
        // Log validation failure
        logValidationFailure(
          logContext,
          generatedSql,
          validation.error || 'Unknown validation error',
          llmMs
        );

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
        
        // Log validation failure
        logValidationFailure(
          logContext,
          finalSql,
          `Column validation failed: ${columnValidation.errors.map(e => e.message).join('; ')}`,
          llmMs
        );
        
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
      
      // Apply user permission enforcement (filter by planning area, scenario, plant)
      const permContext = getPermissionsForRequest(req);
      const permResult = enforcePermissions(finalSql, permContext);
      
      if (!permResult.allowed) {
        log(`Permission denied: ${permResult.blockedReason}`, 'ask');
        return res.status(403).json({
          error: permResult.blockedReason || 'Access denied',
          isPermissionDenied: true,
        });
      }
      
      let enforcedSql = permResult.modifiedSql || finalSql;
      if (permResult.appliedFilters && permResult.appliedFilters.length > 0) {
        log(`Permission filters applied: ${permResult.appliedFilters.join('; ')}`, 'ask');
      }

      if (req.embedSession) {
        try {
          const entitlements = await getEntitlementsForUser(req.embedSession.companyId, req.embedSession.email);
          const entResult = enforceEntitlements(enforcedSql, entitlements, req.embedSession.isCompanyAdmin);
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
      }
      
      // Apply user-selected global filters (from dropdown selectors)
      const globalFilterResult = applyGlobalFilters(enforcedSql, {
        planningArea: filters.planningArea,
        scenarioId: filters.scenarioId,
        plant: filters.plant,
      });
      enforcedSql = globalFilterResult.modifiedSql;
      if (globalFilterResult.appliedFilters.length > 0) {
        log(`Global filters applied: ${globalFilterResult.appliedFilters.join('; ')}`, 'ask');
      }
      
      log(`Executing SQL: ${enforcedSql}`, 'ask');

      // Execute the query
      const sqlStartTime = Date.now();
      const result = await executeQuery(enforcedSql);
      const sqlMs = Date.now() - sqlStartTime;

      // Log successful execution (use enforcedSql which is the validated/permission-filtered SQL)
      logSuccess(
        logContext,
        enforcedSql,
        result.recordset.length,
        llmMs,
        sqlMs
      );

      // Track for FAQ popularity (only queries with results)
      trackQueryForFAQ(question, result.recordset.length);

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
            const countResult = await executeQuery(countSql);
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
              const checkResult = await executeQuery(checkQuery);
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
              const rangeResult = await executeQuery(rangeQuery);
              
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
        
        logExecutionFailure(
          logContext,
          failedSql,
          error.message || 'Failed to execute query',
          llmMs
        );
      } else {
        // Error during SQL generation
        logGenerationFailure(
          logContext,
          error.message || 'Failed to generate SQL'
        );
      }

      res.status(500).json({
        error: error.message || 'Failed to process query',
        isMock: false,
      });
    }
  });

  // ===== ADMIN PERMISSIONS ENDPOINTS =====
  // NOTE: These endpoints need authentication/authorization when integrated with parent Blazor app.
  // Currently unprotected for development. In production, verify user identity and isAdmin flag.
  
  // Initialize permissions storage
  initPermissions();

  // Get all users with permissions (admin only)
  app.get("/api/admin/users", (_req, res) => {
    try {
      const users = getAllUserPermissions();
      res.json({ users });
    } catch (error: any) {
      log(`[admin] Error fetching users: ${error.message}`, "error");
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // Get permissions for a specific user (admin only)
  app.get("/api/admin/permissions/:userId", (req, res) => {
    try {
      const { userId } = req.params;
      const permissions = getUserPermissions(userId);
      if (!permissions) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ permissions });
    } catch (error: any) {
      log(`[admin] Error fetching user permissions: ${error.message}`, "error");
      res.status(500).json({ error: "Failed to fetch user permissions" });
    }
  });

  // Create or update user permissions (admin only)
  app.put("/api/admin/permissions/:userId", (req, res) => {
    try {
      const { userId } = req.params;
      const body = { ...req.body, userId };
      
      const parseResult = userPermissionsSchema.safeParse(body);
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: "Invalid permissions data", 
          details: parseResult.error.format() 
        });
      }

      const permissions = createOrUpdateUserPermissions(parseResult.data);
      res.json({ permissions });
    } catch (error: any) {
      log(`[admin] Error updating user permissions: ${error.message}`, "error");
      res.status(500).json({ error: "Failed to update user permissions" });
    }
  });

  // Create a new user with permissions (admin only)
  app.post("/api/admin/permissions", (req, res) => {
    try {
      const parseResult = userPermissionsSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: "Invalid permissions data", 
          details: parseResult.error.format() 
        });
      }

      // Check if username already exists
      const existing = getUserPermissionsByUsername(parseResult.data.username);
      if (existing) {
        return res.status(409).json({ error: "Username already exists" });
      }

      const permissions = createOrUpdateUserPermissions(parseResult.data);
      res.json({ permissions });
    } catch (error: any) {
      log(`[admin] Error creating user: ${error.message}`, "error");
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  // Delete user permissions (admin only)
  app.delete("/api/admin/permissions/:userId", (req, res) => {
    try {
      const { userId } = req.params;
      const deleted = deleteUserPermissions(userId);
      if (!deleted) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ success: true });
    } catch (error: any) {
      log(`[admin] Error deleting user: ${error.message}`, "error");
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // Get permission options (table access types)
  app.get("/api/admin/permission-options", (_req, res) => {
    res.json({
      tableAccessOptions: [...tableAccessOptions]
    });
  });

  // Run validator self-check on startup in development mode
  if (process.env.NODE_ENV !== 'production') {
    log('Running validator self-check...', 'startup');
    const { passed, results } = runValidatorSelfCheck();
    results.forEach(result => log(result, 'validator-check'));
    if (!passed) {
      log('⚠️  WARNING: Validator self-check failed!', 'validator-check');
    } else {
      log('✅ Validator self-check passed', 'validator-check');
    }
  }

  return httpServer;
}

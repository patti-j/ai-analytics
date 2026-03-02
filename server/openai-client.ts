import OpenAI from 'openai';
import { getFormattedSchemaForTables } from './mode-schema-cache';
import { classifyQuestionWithMatrix, getBusinessTermContext } from './matrix-classifier';

// Simple LRU cache for successful SQL queries (max 100 entries)
const sqlCache = new Map<string, { sql: string; selectedTables: string[]; timestamp: number }>();
const SQL_CACHE_MAX_SIZE = 100;
const SQL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCacheKey(question: string): string {
  return question.trim().toLowerCase();
}

function getCachedSql(question: string): { sql: string; selectedTables: string[] } | null {
  const key = getCacheKey(question);
  const cached = sqlCache.get(key);
  if (cached && Date.now() - cached.timestamp < SQL_CACHE_TTL_MS) {
    console.log(`[openai-client] Cache hit for: "${question.substring(0, 50)}..."`);
    return { sql: cached.sql, selectedTables: cached.selectedTables };
  }
  if (cached) {
    sqlCache.delete(key); // Expired
  }
  return null;
}

function cacheSql(question: string, sql: string, selectedTables: string[]): void {
  const key = getCacheKey(question);
  // Evict oldest if at max size
  if (sqlCache.size >= SQL_CACHE_MAX_SIZE) {
    const oldestKey = sqlCache.keys().next().value;
    if (oldestKey) sqlCache.delete(oldestKey);
  }
  sqlCache.set(key, { sql, selectedTables, timestamp: Date.now() });
}

// Gracefully handle missing OpenAI credentials
const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.warn('⚠️  WARNING: OpenAI API key not found. AI query generation will not work.');
  console.warn('   Set AI_INTEGRATIONS_OPENAI_API_KEY or OPENAI_API_KEY environment variable.');
}

export const openai = new OpenAI({
  apiKey: apiKey || 'dummy-key-for-graceful-startup',
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const CORE_SYSTEM_PROMPT = `
You are a SQL query generator for a manufacturing database.

DATABASE: Microsoft SQL Server (Azure SQL Database) - T-SQL dialect
- Use SELECT TOP (N) for row limiting - NEVER use LIMIT, OFFSET, or FETCH
- Use square brackets for identifiers: [schema].[table]
- All queries MUST be SELECT only (no INSERT, UPDATE, DELETE, DROP)
- INNER JOIN, LEFT JOIN, and RIGHT JOIN are allowed
- NEVER use CROSS JOIN

CRITICAL RULES:
- Always include TOP (100) immediately after SELECT (e.g., SELECT TOP (100) JobName, ... FROM ...)
- Generate ONLY ONE SELECT statement - do NOT add extra SELECT statements
- Use ONLY the columns listed in the schema below for each table
- DO NOT invent or hallucinate column names
- When user says "next" jobs, sort by date (ORDER BY), don't filter to future dates unless explicitly requested

CRITICAL - DASHt_Planning TABLE STRUCTURE:
⚠️ DASHt_Planning has ONE ROW PER OPERATION, NOT per job!
⚠️ Each job can have 1 or more operations (typically 1-10 rows per job). Without GROUP BY, you may get duplicate job rows!
⚠️ ALWAYS use GROUP BY JobName for ANY job-level query to avoid showing the same job multiple times.

MANDATORY GROUPING EXAMPLES:
  * "Show jobs" → SELECT JobName, ... GROUP BY JobName
  * "Show overdue jobs" → SELECT JobName, JobOverdueDays, ... WHERE JobOverdue = 1 GROUP BY JobName, JobOverdueDays
  * "Show late jobs" → SELECT JobName, JobLatenessDays, ... WHERE JobLate = 1 GROUP BY JobName, JobLatenessDays
  * "Show jobs on hold" → SELECT JobName, JobHoldReason, ... WHERE JobOnHold = 'OnHold' GROUP BY JobName, JobHoldReason
  * "Show job dates" → SELECT JobName, MIN(date), MAX(date), ... GROUP BY JobName
  * "List jobs by product" → SELECT JobName, JobProduct, ... GROUP BY JobName, JobProduct

JOB vs OPERATION COUNTING (CRITICAL):
DASHt_Planning is operation-grain (one row per operation, multiple operations per job). Use the right counting method:
  * Job-level questions ("how many jobs", "job count", "jobs by commitment") → COUNT(DISTINCT JobId) or COUNT(DISTINCT JobName)
  * Operation-level questions ("how many operations", "how many steps") → COUNT(*) or COUNT(OPId)
  * CONDITIONAL JOB COUNTS (late jobs, overdue jobs, etc.) → Use COUNT(DISTINCT CASE WHEN...):
      WRONG: SUM(CASE WHEN JobLate = 1 THEN 1 ELSE 0 END) -- counts operations, not jobs!
      RIGHT: COUNT(DISTINCT CASE WHEN JobLate = 1 THEN JobId END) AS LateJobs
    Example for multiple conditions:
      SELECT COUNT(DISTINCT CASE WHEN JobLate = 1 THEN JobId END) AS LateJobs,
             COUNT(DISTINCT CASE WHEN JobOverdue = 1 THEN JobId END) AS OverdueJobs
      FROM [publish].[DASHt_Planning] WHERE JobScheduledStatus <> 'Template'

TEMPLATE FILTERING (ALWAYS APPLY):
  * ALWAYS exclude templates from job/operation counts: WHERE JobScheduledStatus <> 'Template'
  * Templates are job templates used for planning, not actual scheduled jobs

JOB COUNT QUERIES (SPECIAL RULES):
  * "How many jobs are there?" / "total jobs" / "all jobs" / "jobs report" / "commitment overview" / "active jobs" / "jobs in planning" → Use DASHt_Planning:
      SELECT COUNT(DISTINCT JobId) AS JobCount FROM [publish].[DASHt_Planning] WHERE JobScheduledStatus <> 'Template'
  * "Released jobs" / "firm jobs" / "planned jobs" / "estimate jobs" → Filter by JobCommitment:
      SELECT COUNT(DISTINCT JobId) AS JobCount FROM [publish].[DASHt_Planning] WHERE JobCommitment = 'Released' AND JobScheduledStatus <> 'Template'
      (Replace 'Released' with 'Firm', 'Planned', or 'Estimate' based on question)
  * "Jobs by commitment" / "commitment overview" / "released vs firm vs planned" → Group by commitment:
      SELECT JobCommitment, COUNT(DISTINCT JobId) AS Jobs FROM [publish].[DASHt_Planning] WHERE JobScheduledStatus <> 'Template' GROUP BY JobCommitment

PUBLISH.JOBS TABLE - USE FOR JOB-LEVEL METRICS (EXCEPTION TO TIER1 RULE):
  * For job counts involving Late/Scheduled status, use [publish].[Jobs] NOT DASHt_Planning
  * publish.Jobs columns: Late, Scheduled, Qty, ScenarioType, JobId, etc.
  * DASHt_Planning columns: JobLate, JobScheduled, JobQty (different names!)
  * "How many jobs are scheduled?" / "scheduled jobs" / "late jobs count":
      SELECT COUNT(*) AS JobCount FROM [publish].[Jobs] WHERE Scheduled = 1
  * "How many jobs are late?" / "late jobs":
      SELECT COUNT(*) AS LateJobCount FROM [publish].[Jobs] WHERE Late = 1
  * "How many jobs are scheduled and late?":
      SELECT COUNT(*) AS ScheduledLateJobs FROM [publish].[Jobs] WHERE Scheduled = 1 AND Late = 1
  * DO NOT add ScenarioType filter - user filters are applied server-side based on UI selectors

OTIF (ON-TIME IN-FULL) QUERIES:
  * "OTIF" / "Predicted OTIF" / "OTIF JobQty" / "on-time in-full" → MUST USE publish.Jobs table (NOT DASHt_Planning):
      SELECT COALESCE(SUM(CASE WHEN Scheduled = 1 AND Late = 0 THEN Qty ELSE NULL END), 0) AS OTIF_JobQty
      FROM [publish].[Jobs]
  * EXCEPTION: OTIF queries use publish.Jobs (Tier2 table) to match Power BI results
  * OTIF means: Jobs that are SCHEDULED (Scheduled=1) AND NOT LATE (Late=0) - sum their Qty
  * DO NOT add ScenarioType filter - user filters are applied server-side based on UI selectors

PREDICTED ON-TIME COMPLETION QUERIES:
  * "Predicted On-Time Completion" / "on-time completion %" / "on-time percentage" / "OTC" → MUST USE publish.Jobs table:
      SELECT COALESCE(100.0 * SUM(CASE WHEN Scheduled = 1 AND Late = 0 THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN Scheduled = 1 THEN 1 ELSE 0 END), 0), 0) AS Predicted_OnTime_Completion_Pct
      FROM [publish].[Jobs]
  * Returns percentage of scheduled jobs that are on-time (not late)
  * DO NOT add ScenarioType filter - user filters are applied server-side based on UI selectors

NO GROUPING NEEDED (operation-level queries):
  * "Show operations" → no grouping needed, use COUNT(*) for counting
  * "Show operation details" → no grouping needed

DEFAULT RULE: When in doubt, ALWAYS add GROUP BY JobName to prevent duplicate job rows, and ALWAYS filter out templates.

COMMON COLUMN MAPPINGS (if present in schema):
- Plant: ALWAYS use BlockPlant for DASHt_Planning (NOT PlantId which is internal), PlantName for other tables
- Department: PREFER BlockDepartment (user-friendly name) over DepartmentId
- Resource: PREFER BlockResource (user-friendly name) over ResourceId
- Job: Use JobName (readable ID) - NOT JobId or JobNumber
- Product: Use JobProduct, MOProduct, or JobProductDescription - NOT PartNumber
- Dates: Use JobScheduledStartDateTime/JobScheduledEndDateTime - NOT SchedStartDate/SchedEndDate
- Quantity: Use JobQty, MORequiredQty, OPRequiredFinishQty - NOT QtyScheduled/QtyRequired

USER-FRIENDLY OUTPUT RULE (IMPORTANT):
- In DASHt_* tables, ALWAYS use the Name/Block columns for display, not internal IDs:
  - BlockPlant (for DASHt_Planning) or PlantName (for other tables) instead of PlantId
  - BlockDepartment instead of DepartmentId
  - BlockResource instead of ResourceId
  - JobName instead of JobId
  - CustomerName instead of CustomerId
- ExternalId columns exist ONLY in Tier2 tables (publish.Jobs, publish.Resources, etc.), NOT in Tier1 DASHt_* tables
- NEVER add ExternalId to queries against DASHt_* tables - it will cause a column validation error

BUSINESS CONTEXT:
- JobOnHold: 'OnHold' | 'Released'
- JobScheduledStatus: 'Scheduled' | 'Finished' | 'FailedToSchedule' | 'Template'
- JobNeedDateTime: Primary due date field
- JobOverdue: Boolean (1 = overdue)
`;

interface Filters {
  planningArea?: string | null;
  scenario?: string | null;
  plant?: string | null;
}

interface GenerateOptions {
  allowedTables?: string[];
  publishDate?: string; // The effective "today" date for date-relative queries
  filters?: Filters; // Global filters for scenario and plant
}

interface GenerateResult {
  sql: string;
  suggestions?: string[];
  selectedTables?: string[];
}

const SUGGESTION_PROMPT = `
You are a query suggestion assistant for a manufacturing database. Given a user's natural language question, generate 2-3 alternative phrasings or related questions that might help clarify or expand their query.

Rules:
- Suggest variations that are more specific or clearer
- Suggest related queries they might also be interested in
- Keep suggestions concise (under 15 words each)
- Return ONLY a JSON array of strings, no other text
- If the question is already very clear, return fewer suggestions

Example input: "show jobs"
Example output: ["Show all overdue jobs", "Show jobs by plant", "Show jobs scheduled for today"]
`;

export async function generateSuggestions(question: string): Promise<string[]> {
  if (!apiKey) {
    return [];
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SUGGESTION_PROMPT },
        { role: 'user', content: question }
      ],
      temperature: 0.7,
      max_completion_tokens: 200,
    });

    const content = response.choices[0]?.message?.content?.trim() || '[]';
    const suggestions = JSON.parse(content);
    return Array.isArray(suggestions) ? suggestions.slice(0, 3) : [];
  } catch (error) {
    return [];
  }
}

export async function generateSqlFromQuestion(question: string, options: GenerateOptions = {}): Promise<{ sql: string; selectedTables: string[]; confidence: 'high' | 'medium' | 'low' | 'none' }> {
  if (!apiKey) {
    throw new Error('OpenAI API key not configured. Please set AI_INTEGRATIONS_OPENAI_API_KEY environment variable.');
  }

  // Check cache first for consistent results
  const cached = getCachedSql(question);
  if (cached) {
    return { ...cached, confidence: 'high' };
  }

  const { allowedTables = [], publishDate, filters } = options;

  // Use matrix-driven table selection (3-4 tables default, max 6)
  const classification = classifyQuestionWithMatrix(question);
  
  // Get business term context if any terms matched
  const businessTermContext = getBusinessTermContext(classification.matchedTerms);
  
  // Get context hints from matrix matches
  const contextHintsText = classification.contextHints.length > 0
    ? `\nTABLE SELECTION GUIDANCE:\n${classification.contextHints.join('\n')}\n`
    : '';
  
  // Filter selected tables to only those that exist in allowedTables (if provided)
  let relevantTables = classification.selectedTables;
  if (allowedTables.length > 0) {
    relevantTables = classification.selectedTables.filter(t => 
      allowedTables.some(allowed => allowed.toLowerCase() === t.toLowerCase())
    );
    // If no tables match, use the matrix selection as-is (they might be Tier 1 tables)
    if (relevantTables.length === 0) {
      relevantTables = classification.selectedTables;
    }
  }
  
  // Fetch schema for relevant tables only
  let modeSchema = '';
  let stats = { tableCount: 0, columnCount: 0 };
  
  try {
    const startTime = Date.now();
    
    // Fetch schema for matrix-selected tables with column slimming
    if (relevantTables.length > 0) {
      modeSchema = await getFormattedSchemaForTables(relevantTables, question);
      stats = { tableCount: relevantTables.length, columnCount: 0 };
    } else if (allowedTables.length > 0) {
      // Fall back to allowed tables schema
      modeSchema = await getFormattedSchemaForTables(allowedTables, question);
      stats = { tableCount: allowedTables.length, columnCount: 0 };
    } else {
      modeSchema = 'All publish.DASHt_* tables available';
    }
    
    const schemaFetchTime = Date.now() - startTime;
    console.log(`[openai-client] Matrix-selected ${stats.tableCount} tables (fetched in ${schemaFetchTime}ms)`);
  } catch (error: any) {
    console.error(`[openai-client] Failed to fetch schema: ${error.message}. Using fallback.`);
    if (allowedTables.length > 0) {
      modeSchema = `Tables: ${allowedTables.join(', ')}`;
    } else {
      modeSchema = 'All publish.DASHt_* tables available';
    }
  }

  // Consolidated guidance for all table types
  const tableGuidance = `

CRITICAL TABLE RULES:

CAPACITY PLANNING TABLES:
- DASHt_CapacityPlanning_ResourceCapacity: Has capacity data (NormalOnlineHours, OvertimeHours, etc.)
- DASHt_CapacityPlanning_ResourceDemand: Has demand data (DemandHours, LoadedHours, etc.)
- DASHt_CapacityPlanning_ShiftsCombined: Has shift data (ShiftName, StartTime, EndTime, etc.)
- DASHt_Resources: Has resource metadata ONLY (ResourceName, WorkcenterName, DepartmentName, PlantName) - NO demand or capacity columns
- For demand/capacity analysis: JOIN DASHt_Resources with DASHt_CapacityPlanning_ResourceDemand or DASHt_CapacityPlanning_ResourceCapacity

PRODUCTION PLANNING TABLES:
- DASHt_Planning: Main planning table with job/operation data
- JobScheduledStatus values: 'Scheduled', 'FailedToSchedule', 'Finished', 'Unscheduled'
- When user asks for "scheduled jobs": ALWAYS add WHERE JobScheduledStatus = 'Scheduled'
- When user asks for "unscheduled jobs" or "not scheduled": use WHERE JobScheduledStatus IN ('FailedToSchedule', 'Unscheduled') - DO NOT add sentinel date filters (unscheduled jobs have sentinel dates by design)
- SENTINEL DATE RULES: Dates 9000-01-01 and 1800-01-01 indicate unscheduled jobs
  * For UNSCHEDULED job queries: Do NOT filter on JobScheduledStartDateTime or JobScheduledEndDateTime (the status flag is sufficient)
  * For SCHEDULED job queries with date filtering: Add JobScheduledStartDateTime NOT IN ('9000-01-01', '1800-01-01') to exclude invalid dates
- DATE COLUMN SELECTION (CRITICAL - understand the difference):
  * JobEntryDate: When the job was CREATED/ENTERED into the system (historical, often old dates like 2020)
  * JobScheduledStartDateTime/JobScheduledEndDateTime: When the job is SCHEDULED TO RUN (the actual production dates, e.g., 2025)
  * JobNeedDateTime: When the job is NEEDED/DUE (due date, may have sentinel dates for unscheduled jobs)
  * RULE: When user asks "when are jobs scheduled", "schedule dates", "production dates": Use JobScheduledStartDateTime/JobScheduledEndDateTime
  * RULE: When user asks "when was the job created", "entry dates": Use JobEntryDate
  * RULE: For date filtering ALL jobs (scheduled + unscheduled) without specific context: Use JobEntryDate to avoid sentinel dates
  * RULE: For scheduled jobs with date filters: Use JobScheduledEndDateTime AND filter JobScheduledStatus = 'Scheduled' and exclude sentinel dates
- JobOnHold values: 'OnHold', 'Released' - IMPORTANT: "on hold" is NOT the same as "unscheduled"
- When user asks for "jobs on hold" or "held jobs": use WHERE JobOnHold = 'OnHold'
- To include hold reasons: SELECT JobHoldReason column (may be NULL if no reason specified)

SCENARIO FILTERING RULES (for DASHt_Planning and DASHt_SalesOrders):
- Scenario filtering is handled by the user's dropdown selection - do NOT add ScenarioType filters unless the user explicitly asks about scenarios
- Only use ScenarioType = 'What-If' if user explicitly mentions "what-if", "scenario", "copy", or "simulation"
- NEVER mix Production and What-If unless user explicitly asks for comparison

BEST PRACTICES:
- DO NOT invent or hallucinate aggregate columns - compute them via SUM(), COUNT(), AVG()
- When listing items, use SELECT DISTINCT to avoid duplicate rows
- When grouping, always GROUP BY the appropriate columns
- ONLY use columns explicitly listed in the schema below for each table
- DO NOT use single-letter table aliases (a, b, d, etc.) - use full table names or meaningful aliases
- Always use explicit column names from the schema - never abbreviate or guess column names
- For jobs on hold with reasons: SELECT JobName, JobOnHold, JobHoldReason FROM [publish].[DASHt_Planning] WHERE JobOnHold = 'OnHold'
`;

  // Build the effective "today" date context
  const todayContext = publishDate 
    ? `\nTODAY'S DATE: ${publishDate}\nWhen the user asks about "today", "this week", "next week", "tomorrow", etc., use ${publishDate} as the reference date (not the actual current date).`
    : '';

  // NOTE: Global filters (planning area, scenario, plant) are applied SERVER-SIDE after SQL generation.
  // Do NOT tell the LLM to apply these filters - it causes duplicate/conflicting WHERE clauses.
  // The LLM should generate clean SQL without user-selected filters; we inject them in query-permissions.ts

  const systemPrompt = `${CORE_SYSTEM_PROMPT}
${todayContext}
${businessTermContext}${contextHintsText}
AVAILABLE TABLES AND COLUMNS:
${modeSchema}
${tableGuidance}
Generate only the SQL query, no explanation. Do not include markdown formatting or code blocks.`;

  const llmStartTime = Date.now();
  const response = await openai.chat.completions.create({
    model: 'gpt-5.2',
    messages: [
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: question
      }
    ],
    temperature: 0.1,
    max_completion_tokens: 500,
    seed: 42,
  });
  const llmTime = Date.now() - llmStartTime;
  
  console.log(`[openai-client] LLM generation completed in ${llmTime}ms`);

  const sqlQuery = response.choices[0]?.message?.content?.trim() || '';
  
  // Remove markdown code blocks if present
  const cleanedSql = sqlQuery
    .replace(/```sql\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();
  
  return {
    sql: cleanedSql,
    selectedTables: relevantTables,
    confidence: classification.confidence
  };
}

// Export cache function for use after successful query execution
export function cacheSuccessfulSql(question: string, sql: string, selectedTables: string[]): void {
  cacheSql(question, sql, selectedTables);
}

const QUESTION_CLASSIFIER_PROMPT = `
You are a question classifier for a manufacturing analytics system.

Classify the user's question into one of these categories:
- "data_query" - Questions that require fetching data from the database. This includes:
  * Questions with numbers, counts, totals, sums (e.g., "How many hours of backlog?", "What's our total demand?")
  * Questions about specific resources, jobs, workcenters (e.g., "Which resources are busiest?", "Show overdue jobs")
  * Questions with time frames (e.g., "next week", "today", "this month")
  * Questions starting with "Show me", "List", "What are the", "How many", "Which"
  * Any question that implies looking at actual production/planning data
  * KPI requests like "OTIF", "on-time", "predicted OTIF", "JobQty" - these are DATA queries!
  * "What is the OTIF?" or "What is predicted OTIF JobQty?" = DATA QUERY (not a definition)
  
- "general" - ONLY questions about concepts, definitions, or system help that don't reference any actual data. Examples:
  * "What is utilization?" (asking for a definition)
  * "How do I use this system?" (asking for help)
  * "What does on-hold mean?" (asking for a term definition)
  * "Explain capacity planning" (asking for a concept explanation)

IMPORTANT: If the question mentions specific metrics like OTIF, JobQty, lateness, overdue, etc., it's a data_query.
If the question could be answered with data from the database, classify as "data_query".
Only use "general" for pure definitions, concepts, or system help questions.

Return ONLY the category string, nothing else.
`;

export async function classifyQuestion(question: string): Promise<'data_query' | 'general'> {
  if (!apiKey) {
    return 'data_query'; // Default to data query if no API key
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: QUESTION_CLASSIFIER_PROMPT },
        { role: 'user', content: question }
      ],
      temperature: 0,
      max_completion_tokens: 20,
    });

    const result = response.choices[0]?.message?.content?.trim().toLowerCase() || '';
    return result.includes('general') ? 'general' : 'data_query';
  } catch (error) {
    console.error('[openai-client] Question classification failed:', error);
    return 'data_query'; // Default to data query on error
  }
}

const GENERAL_ANSWER_PROMPT = `
You are a helpful assistant for a manufacturing analytics system called Query Insight. This system helps users query planning data from PlanetTogether APS (Advanced Planning and Scheduling).

Answer the user's question in a helpful, conversational way. Keep your response concise (2-4 sentences typically).

MANUFACTURING CONTEXT:
- Resources: Machines, equipment, or labor that perform operations
- Workcenters: Groups of similar resources in a manufacturing facility
- Jobs/Work Orders: Production tasks that need to be scheduled
- Utilization: Percentage of time a resource is being used (demand vs capacity)
- Capacity: The available production time/capability of a resource
- Demand: Work that needs to be done, expressed in hours
- Bottleneck: A resource that limits overall production throughput
- On Hold: Jobs that are paused and not being scheduled
- Scheduled: Jobs that have been assigned times and resources
- Overdue: Jobs past their due date (NeedDateTime)
- Dispatch List: Prioritized list of operations for shop floor execution

SYSTEM CAPABILITIES:
- Users can ask questions in plain English to query manufacturing data
- The system supports three scopes: Capacity Plan (resource planning), Production & Planning (jobs/orders), and Finance (financial analysis)
- Results can be exported to CSV or Excel
- Quick questions provide pre-built common queries

If you don't know something specific to their data, suggest they ask a data query instead.
`;

export async function answerGeneralQuestion(question: string): Promise<string> {
  if (!apiKey) {
    return "I'm unable to answer questions at the moment. Please check that the OpenAI API is configured.";
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: GENERAL_ANSWER_PROMPT },
        { role: 'user', content: question }
      ],
      temperature: 0.7,
      max_completion_tokens: 300,
    });

    return response.choices[0]?.message?.content?.trim() || "I'm not sure how to answer that. Try asking a question about your data instead.";
  } catch (error) {
    console.error('[openai-client] General question answering failed:', error);
    return "I encountered an error trying to answer your question. Please try again.";
  }
}

const NATURAL_LANGUAGE_RESPONSE_PROMPT = `
You are an AI assistant that summarizes database query results in natural, conversational language.

Given a user's question and the query results, provide a clear, human-readable answer.

CRITICAL - USE EXACT DATA VALUES:
- ALWAYS use the EXACT numbers from the Results JSON data provided
- NEVER make up, estimate, or hallucinate any numbers
- If the results show {"JobCount": 6}, say "6 jobs" - NOT any other number
- If the results show {"Total": 20}, say "20" - use that exact value
- The numbers in your response MUST match the numbers in the Results data

FORMATTING RULES:
- Use bullet points (•) when listing multiple items
- Keep responses concise but complete
- Use natural language, not technical jargon
- Format numbers with commas for readability (e.g., 1,234 not 1234)
- Round decimals to 2 places maximum
- IMPORTANT: If the user asked for a specific number (e.g., "top 10", "first 20"), list ALL of those items, not just a subset
- IMPORTANT: Look at ALL distinct values in the results. If there are 2-5 unique products/jobs/items, mention ALL of them in your response
- If there are more than 15 items and user didn't specify a count, summarize the top 10 and mention how many total
- If no results, say so clearly and suggest why (e.g., "No data found for this date range")
- IMPORTANT: Match the scope in your response to the query scope:
  * If the query filters by ScenarioType = 'Production', say "in Production" (e.g., "There are 16 jobs in Production")
  * If the query includes all scenarios or says "across all scenarios", say "across all scenarios" (e.g., "There are 38 jobs across all scenarios")
  * If no scenario filter is mentioned in the query, don't add scenario context to the response

EXAMPLES:
Question: "Which resources are busiest next week?"
Results: [{"ResourceName": "CNC1", "TotalHours": 45}, {"ResourceName": "Mill 2", "TotalHours": 38}]
Response: "The busiest resources next week are:
• CNC1 with 45 hours of scheduled work
• Mill 2 with 38 hours of scheduled work"

Question: "How many jobs are overdue?"
Results: [{"JobCount": 6}]
Response: "There are 6 overdue jobs across all scenarios that need attention."

Question: "List unassigned resources in Plant A"
Results: [{"ResourceName": "Lathe 1"}, {"ResourceName": "Drill 2"}, {"ResourceName": "Press 3"}]
Response: "Unassigned resources in Plant A are:
• Lathe 1
• Drill 2
• Press 3"

Respond with ONLY the natural language answer, no preamble or explanation.
`;

export async function* streamNaturalLanguageResponse(
  question: string, 
  results: any[], 
  rowCount: number,
  actualTotalCount?: number,
  appliedFilters?: string[]
): AsyncGenerator<string, void, unknown> {
  if (!apiKey) {
    yield `Found ${rowCount} result(s).`;
    return;
  }

  // Build filter context for the response
  const filterContext = appliedFilters && appliedFilters.length > 0
    ? `\n\nApplied filters: ${appliedFilters.join(', ')}`
    : '';

  // If no results, generate a context-aware empty message (non-streaming for simplicity)
  if (rowCount === 0) {
    try {
      const filterNote = appliedFilters && appliedFilters.length > 0
        ? `\nThe following global filters were applied: ${appliedFilters.join(', ')}. IMPORTANT: Mention these filters in your response so the user understands why no results were found. For example: "No late jobs were found for Plant A" or "With your current filter (Plant: A), there are no matching records."`
        : '';
      
      const emptyResponse = await openai.responses.create({
        model: 'gpt-4o-mini',
        instructions: `You explain when no data is found. Be concise (1-2 sentences). State what was searched for based on the question, and confirm no matching records exist. If filters were applied, ALWAYS mention them so the user understands the scope of the search. Don't apologize or be overly wordy. Example: "There are no late jobs in Plant A."`,
        input: `Question: "${question}"${filterNote}\n\nNo records were found. Explain this clearly to the user, mentioning any applied filters.`,
        temperature: 0.3,
        max_output_tokens: 150,
      });
      yield emptyResponse.output_text?.trim() || "No matching data was found for your query.";
    } catch {
      const filterMsg = appliedFilters && appliedFilters.length > 0
        ? ` with your current filters (${appliedFilters.join(', ')})`
        : '';
      yield `No matching data was found${filterMsg}. Try adjusting your filters or search criteria.`;
    }
    return;
  }

  // Limit results sent to LLM to avoid token overflow
  const limitedResults = results.slice(0, 20);
  const hasMore = rowCount > 20;
  
  // Determine if results were truncated by TOP 100
  const wasLimited = actualTotalCount && actualTotalCount > rowCount;

  try {
    const limitNote = wasLimited 
      ? `\nIMPORTANT: Results are limited to first ${rowCount} rows. The actual total is ${actualTotalCount}. Mention this in your response, e.g. "Here are the first 100 of ${actualTotalCount} total..."`
      : '';
    
    // Build filter context for non-empty results
    const filterNote = appliedFilters && appliedFilters.length > 0
      ? `\n\nApplied filters: ${appliedFilters.join(', ')}. Mention the filter scope in your response (e.g., "In Plant A, there are..." or "For the selected scenario...").`
      : '\n\nNo filters were applied - this represents ALL data across all plants, planning areas, and scenarios. If results only show one plant/area, clarify that while searching across all, only that subset had matching data.';

    // Build input for Responses API (converted from Chat Completions messages)
    const userInput = `Question: "${question}"
Results (${rowCount} returned${wasLimited ? `, ${actualTotalCount} total in database` : ''}${hasMore ? ', showing first 20 for summary' : ''}):
${JSON.stringify(limitedResults, null, 2)}${limitNote}${filterNote}

Provide a natural language summary of these results.`;

    // Feature flag for JSON structured output mode (future use)
    const useJsonMode = process.env.RESPONSE_JSON_MODE === 'true';
    
    // Use OpenAI Responses API with streaming
    const stream = await openai.responses.create({
      model: 'gpt-4o-mini',
      instructions: NATURAL_LANGUAGE_RESPONSE_PROMPT,
      input: userInput,
      temperature: 0.3,
      max_output_tokens: 800,
      stream: true,
      ...(useJsonMode ? { 
        text: { format: { type: 'json_object' } }
      } : {}),
    });

    // Process Responses API streaming events
    for await (const event of stream) {
      // Handle text delta events
      if (event.type === 'response.output_text.delta') {
        const delta = (event as any).delta;
        if (delta) {
          yield delta;
        }
      }
      
      // Placeholder: Log tool/function call events for future implementation
      if (event.type === 'response.function_call_arguments.delta') {
        console.log('[openai-client] Tool call delta received:', (event as any).delta);
      }
      
      if (event.type === 'response.output_item.added') {
        const item = (event as any).item;
        if (item?.type === 'function_call') {
          console.log('[openai-client] Function call started:', item.name);
        }
      }
      
      // Handle completion
      if (event.type === 'response.completed') {
        console.log('[openai-client] Response stream completed');
      }
      
      // Handle failures
      if (event.type === 'response.failed') {
        console.error('[openai-client] Response stream failed:', event);
      }
    }
    
  } catch (error) {
    console.error('[openai-client] Streaming natural language response failed:', error);
    yield `Found ${rowCount} result(s).`;
  }
}

export async function generateNaturalLanguageResponse(
  question: string, 
  results: any[], 
  rowCount: number,
  actualTotalCount?: number
): Promise<string> {
  if (!apiKey) {
    return `Found ${rowCount} result(s).`;
  }

  // If no results, generate a context-aware empty message
  if (rowCount === 0) {
    try {
      const emptyResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: `You explain when no data is found. Be concise (1-2 sentences). State what was searched for based on the question, and confirm no matching records exist. Don't apologize or be overly wordy. Example: "There are no jobs scheduled for production during the week of January 1, 2025."` },
          { role: 'user', content: `Question: "${question}"\n\nNo records were found. Explain this clearly to the user.` }
        ],
        temperature: 0.3,
        max_completion_tokens: 100,
      });
      return emptyResponse.choices[0]?.message?.content?.trim() || "No matching data was found for your query.";
    } catch {
      return "No matching data was found for your query. Try adjusting the date range or criteria.";
    }
  }

  // Limit results sent to LLM to avoid token overflow
  const limitedResults = results.slice(0, 20);
  const hasMore = rowCount > 20;
  
  // Determine if results were truncated by TOP 100
  const wasLimited = actualTotalCount && actualTotalCount > rowCount;
  const totalToReport = actualTotalCount || rowCount;

  try {
    const limitNote = wasLimited 
      ? `\nIMPORTANT: Results are limited to first ${rowCount} rows. The actual total is ${actualTotalCount}. Mention this in your response, e.g. "Here are the first 100 of ${actualTotalCount} total..."`
      : '';
      
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: NATURAL_LANGUAGE_RESPONSE_PROMPT },
        { 
          role: 'user', 
          content: `Question: "${question}"
Results (${rowCount} returned${wasLimited ? `, ${actualTotalCount} total in database` : ''}${hasMore ? ', showing first 20 for summary' : ''}):
${JSON.stringify(limitedResults, null, 2)}${limitNote}

Provide a natural language summary of these results.`
        }
      ],
      temperature: 0.3,
      max_completion_tokens: 800,
    });

    let answer = response.choices[0]?.message?.content?.trim() || `Found ${totalToReport} result(s).`;
    
    return answer;
  } catch (error) {
    console.error('[openai-client] Natural language response generation failed:', error);
    return `Found ${rowCount} result(s).`;
  }
}

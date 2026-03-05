import sql from 'mssql';
import { executeWebAppQuery, isWebAppConfigured } from './db-webapp';
import { log } from './index';

export interface QueryLogEntry {
  CompanyId: number;
  UserEmail: string;
  QuestionText: string;
  GeneratedSql: string | null;
  RowCount: number | null;
  DurationMs: number;
  LlmMs: number | null;
  SqlMs: number | null;
  Success: boolean;
  ErrorMessage: string | null;
  ErrorStage: string | null;
}

export async function logQuery(entry: QueryLogEntry): Promise<void> {
  if (!isWebAppConfigured()) return;

  try {
    await executeWebAppQuery(
      `INSERT INTO dbo.AiQueryLog
         (CompanyId, UserEmail, QuestionText, GeneratedSql, [RowCount], DurationMs, LlmMs, SqlMs, Success, ErrorMessage, ErrorStage)
       VALUES
         (@companyId, @userEmail, @questionText, @generatedSql, @rowCount, @durationMs, @llmMs, @sqlMs, @success, @errorMessage, @errorStage)`,
      {
        companyId: { type: sql.Int, value: entry.CompanyId },
        userEmail: { type: sql.NVarChar(256), value: entry.UserEmail },
        questionText: { type: sql.NVarChar(2000), value: entry.QuestionText.substring(0, 2000) },
        generatedSql: { type: sql.NVarChar(sql.MAX), value: entry.GeneratedSql },
        rowCount: { type: sql.Int, value: entry.RowCount },
        durationMs: { type: sql.Int, value: entry.DurationMs },
        llmMs: { type: sql.Int, value: entry.LlmMs },
        sqlMs: { type: sql.Int, value: entry.SqlMs },
        success: { type: sql.Bit, value: entry.Success },
        errorMessage: { type: sql.NVarChar(1000), value: entry.ErrorMessage?.substring(0, 1000) ?? null },
        errorStage: { type: sql.NVarChar(50), value: entry.ErrorStage },
      }
    );
  } catch (err: any) {
    log(`[query-log] Failed to log query: ${err.message}`, 'query-log');
  }
}

export interface QueryAnalytics {
  summary: {
    totalQueries: number;
    successfulQueries: number;
    failedQueries: number;
    averageLatency: number;
    averageLlmMs: number;
    averageSqlMs: number;
  };
  errorBreakdown: Array<{ stage: string; count: number; percentage: number }>;
  topErrors: Array<{ message: string; count: number; lastOccurred: string }>;
  recentQueries: Array<{
    timestamp: string;
    question: string;
    userEmail: string;
    companyId: number;
    success: boolean;
    latency: number;
    rowCount: number | null;
    error: string | null;
  }>;
  performanceOverTime: Array<{ timestamp: string; latency: number; llmMs: number; sqlMs: number }>;
}

export async function getQueryAnalytics(timeRangeMinutes: number = 1440): Promise<QueryAnalytics> {
  const result = await executeWebAppQuery(
    `SELECT
       COUNT(*) AS totalQueries,
       SUM(CASE WHEN Success = 1 THEN 1 ELSE 0 END) AS successfulQueries,
       SUM(CASE WHEN Success = 0 THEN 1 ELSE 0 END) AS failedQueries,
       AVG(DurationMs) AS averageLatency,
       AVG(LlmMs) AS averageLlmMs,
       AVG(SqlMs) AS averageSqlMs
     FROM dbo.AiQueryLog
     WHERE CreatedAt >= DATEADD(MINUTE, -@timeRange, GETUTCDATE())`,
    { timeRange: { type: sql.Int, value: timeRangeMinutes } }
  );

  const summary = result.recordset[0] || {};

  const errorResult = await executeWebAppQuery(
    `SELECT ErrorStage AS stage, COUNT(*) AS count
     FROM dbo.AiQueryLog
     WHERE Success = 0
       AND ErrorStage IS NOT NULL
       AND CreatedAt >= DATEADD(MINUTE, -@timeRange, GETUTCDATE())
     GROUP BY ErrorStage
     ORDER BY count DESC`,
    { timeRange: { type: sql.Int, value: timeRangeMinutes } }
  );

  const totalFailed = summary.failedQueries || 0;
  const errorBreakdown = errorResult.recordset.map((r: any) => ({
    stage: r.stage,
    count: r.count,
    percentage: totalFailed > 0 ? (r.count / totalFailed) * 100 : 0,
  }));

  const topErrorsResult = await executeWebAppQuery(
    `SELECT TOP 10
       ErrorMessage AS message,
       COUNT(*) AS count,
       MAX(CreatedAt) AS lastOccurred
     FROM dbo.AiQueryLog
     WHERE Success = 0
       AND ErrorMessage IS NOT NULL
       AND CreatedAt >= DATEADD(MINUTE, -@timeRange, GETUTCDATE())
     GROUP BY ErrorMessage
     ORDER BY count DESC`,
    { timeRange: { type: sql.Int, value: timeRangeMinutes } }
  );

  const topErrors = topErrorsResult.recordset.map((r: any) => ({
    message: r.message,
    count: r.count,
    lastOccurred: r.lastOccurred?.toISOString() || '',
  }));

  const recentResult = await executeWebAppQuery(
    `SELECT TOP 20
       CreatedAt AS timestamp,
       QuestionText AS question,
       UserEmail AS userEmail,
       CompanyId AS companyId,
       Success AS success,
       DurationMs AS latency,
       [RowCount] AS rowCount,
       ErrorMessage AS error
     FROM dbo.AiQueryLog
     WHERE CreatedAt >= DATEADD(MINUTE, -@timeRange, GETUTCDATE())
     ORDER BY CreatedAt DESC`,
    { timeRange: { type: sql.Int, value: timeRangeMinutes } }
  );

  const recentQueries = recentResult.recordset.map((r: any) => ({
    timestamp: r.timestamp?.toISOString() || '',
    question: r.question,
    userEmail: r.userEmail,
    companyId: r.companyId,
    success: !!r.success,
    latency: r.latency,
    rowCount: r.rowCount,
    error: r.error,
  }));

  const perfResult = await executeWebAppQuery(
    `SELECT TOP 50
       CreatedAt AS timestamp,
       DurationMs AS latency,
       ISNULL(LlmMs, 0) AS llmMs,
       ISNULL(SqlMs, 0) AS sqlMs
     FROM dbo.AiQueryLog
     WHERE Success = 1
       AND CreatedAt >= DATEADD(MINUTE, -@timeRange, GETUTCDATE())
     ORDER BY CreatedAt DESC`,
    { timeRange: { type: sql.Int, value: timeRangeMinutes } }
  );

  const performanceOverTime = perfResult.recordset.map((r: any) => ({
    timestamp: r.timestamp?.toISOString() || '',
    latency: r.latency,
    llmMs: r.llmMs,
    sqlMs: r.sqlMs,
  }));

  return {
    summary: {
      totalQueries: summary.totalQueries || 0,
      successfulQueries: summary.successfulQueries || 0,
      failedQueries: summary.failedQueries || 0,
      averageLatency: Math.round(summary.averageLatency || 0),
      averageLlmMs: Math.round(summary.averageLlmMs || 0),
      averageSqlMs: Math.round(summary.averageSqlMs || 0),
    },
    errorBreakdown,
    topErrors,
    recentQueries,
    performanceOverTime,
  };
}

export async function getPopularQuestions(limit: number = 10): Promise<Array<{ question: string; count: number; lastUsed: string }>> {
  const result = await executeWebAppQuery(
    `SELECT TOP (@limit)
       QuestionText AS question,
       COUNT(*) AS count,
       MAX(CreatedAt) AS lastUsed
     FROM dbo.AiQueryLog
     WHERE Success = 1
     GROUP BY QuestionText
     ORDER BY count DESC`,
    { limit: { type: sql.Int, value: limit } }
  );

  return result.recordset.map((r: any) => ({
    question: r.question,
    count: r.count,
    lastUsed: r.lastUsed?.toISOString() || '',
  }));
}

export async function getFailedQueries(limit: number = 50): Promise<Array<{
  timestamp: string;
  question: string;
  sql: string | null;
  error: string | null;
  errorStage: string | null;
  userEmail: string;
  companyId: number;
}>> {
  const result = await executeWebAppQuery(
    `SELECT TOP (@limit)
       CreatedAt AS timestamp,
       QuestionText AS question,
       GeneratedSql AS sql,
       ErrorMessage AS error,
       ErrorStage AS errorStage,
       UserEmail AS userEmail,
       CompanyId AS companyId
     FROM dbo.AiQueryLog
     WHERE Success = 0
     ORDER BY CreatedAt DESC`,
    { limit: { type: sql.Int, value: limit } }
  );

  return result.recordset.map((r: any) => ({
    timestamp: r.timestamp?.toISOString() || '',
    question: r.question,
    sql: r.sql,
    error: r.error,
    errorStage: r.errorStage,
    userEmail: r.userEmail,
    companyId: r.companyId,
  }));
}


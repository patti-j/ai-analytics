import sql from 'mssql';
import { executeWebAppQuery, getWebAppPool } from './db-webapp';
import { AiAnalyticsUser, AiUserEntitlement, ScopeType, SCOPE_TYPES } from '@shared/schema';
import { log } from './index';

export async function getUsersForCompany(companyId: number): Promise<AiAnalyticsUser[]> {
  const result = await executeWebAppQuery(
    `SELECT CompanyId, UserEmail, IsActive
     FROM dbo.AiAnalyticsUser
     WHERE CompanyId = @companyId
     ORDER BY UserEmail`,
    { companyId: { type: sql.Int, value: companyId } }
  );
  return result.recordset;
}

export async function getUser(companyId: number, email: string): Promise<AiAnalyticsUser | null> {
  const result = await executeWebAppQuery(
    `SELECT CompanyId, UserEmail, IsActive
     FROM dbo.AiAnalyticsUser
     WHERE CompanyId = @companyId AND UserEmail = @email`,
    {
      companyId: { type: sql.Int, value: companyId },
      email: { type: sql.NVarChar(256), value: email },
    }
  );
  return result.recordset[0] || null;
}

export async function upsertUser(companyId: number, email: string, isActive: boolean = true): Promise<void> {
  await executeWebAppQuery(
    `MERGE dbo.AiAnalyticsUser AS target
     USING (SELECT @companyId AS CompanyId, @email AS UserEmail) AS source
     ON target.CompanyId = source.CompanyId AND target.UserEmail = source.UserEmail
     WHEN MATCHED THEN
       UPDATE SET IsActive = @isActive
     WHEN NOT MATCHED THEN
       INSERT (CompanyId, UserEmail, IsActive)
       VALUES (@companyId, @email, @isActive);`,
    {
      companyId: { type: sql.Int, value: companyId },
      email: { type: sql.NVarChar(256), value: email },
      isActive: { type: sql.Bit, value: isActive },
    }
  );
  log(`[entitlements] Upserted user ${email} for company ${companyId}`, 'entitlements');
}

export async function getEntitlementsForUser(companyId: number, email: string): Promise<AiUserEntitlement[]> {
  log(`[entitlements] Querying entitlements for email="${email}" companyId=${companyId}`, 'entitlements');
  const result = await executeWebAppQuery(
    `SELECT CompanyId, UserEmail, ScopeType, ScopeValue
     FROM dbo.AiUserEntitlement
     WHERE CompanyId = @companyId AND UserEmail = @email
     ORDER BY ScopeType, ScopeValue`,
    {
      companyId: { type: sql.Int, value: companyId },
      email: { type: sql.NVarChar(256), value: email },
    }
  );
  log(`[entitlements] Query returned ${result.recordset.length} rows for email="${email}" companyId=${companyId}`, 'entitlements');
  if (result.recordset.length === 0) {
    try {
      const diagResult = await executeWebAppQuery(
        `SELECT TOP 1 UserEmail, COUNT(*) AS cnt
         FROM dbo.AiUserEntitlement
         WHERE CompanyId = @companyId
         GROUP BY UserEmail
         HAVING UserEmail LIKE @emailPattern
         ORDER BY cnt DESC`,
        {
          companyId: { type: sql.Int, value: companyId },
          emailPattern: { type: sql.NVarChar(256), value: `%${email.split('@')[0]}%` },
        }
      );
      if (diagResult.recordset.length > 0) {
        const dbEmail = diagResult.recordset[0].UserEmail;
        const dbCount = diagResult.recordset[0].cnt;
        log(`[entitlements] MISMATCH? DB has ${dbCount} entitlements for "${dbEmail}" but JWT email is "${email}"`, 'entitlements');
      } else {
        const totalResult = await executeWebAppQuery(
          `SELECT COUNT(*) AS total FROM dbo.AiUserEntitlement WHERE CompanyId = @companyId`,
          { companyId: { type: sql.Int, value: companyId } }
        );
        log(`[entitlements] No entitlements found. Total entitlements for company ${companyId}: ${totalResult.recordset[0]?.total || 0}`, 'entitlements');
      }
    } catch (diagErr: any) {
      log(`[entitlements] Diagnostic query failed: ${diagErr.message}`, 'entitlements');
    }
  }
  return result.recordset;
}

export async function getEntitlementsByScope(companyId: number, email: string, scopeType: ScopeType): Promise<string[]> {
  const result = await executeWebAppQuery(
    `SELECT ScopeValue
     FROM dbo.AiUserEntitlement
     WHERE CompanyId = @companyId AND UserEmail = @email AND ScopeType = @scopeType
     ORDER BY ScopeValue`,
    {
      companyId: { type: sql.Int, value: companyId },
      email: { type: sql.NVarChar(256), value: email },
      scopeType: { type: sql.NVarChar(50), value: scopeType },
    }
  );
  return result.recordset.map((r: any) => r.ScopeValue);
}

export async function replaceEntitlements(
  companyId: number,
  userEmail: string,
  scopes: { scopeType: ScopeType; scopeValue: string }[],
  grantedByEmail: string
): Promise<void> {
  const pool = await getWebAppPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const deleteReq = new sql.Request(transaction);
    deleteReq.input('companyId', sql.Int, companyId);
    deleteReq.input('email', sql.NVarChar(256), userEmail);
    await deleteReq.query(`DELETE FROM dbo.AiUserEntitlement WHERE CompanyId = @companyId AND UserEmail = @email`);

    let inserted = 0;
    for (const scope of scopes) {
      if (!SCOPE_TYPES.includes(scope.scopeType)) {
        log(`[entitlements] Invalid scope type: ${scope.scopeType}, skipping`, 'entitlements');
        continue;
      }
      const insertReq = new sql.Request(transaction);
      insertReq.input('companyId', sql.Int, companyId);
      insertReq.input('email', sql.NVarChar(256), userEmail);
      insertReq.input('scopeType', sql.NVarChar(50), scope.scopeType);
      insertReq.input('scopeValue', sql.NVarChar(256), scope.scopeValue);
      await insertReq.query(
        `INSERT INTO dbo.AiUserEntitlement (CompanyId, UserEmail, ScopeType, ScopeValue)
         VALUES (@companyId, @email, @scopeType, @scopeValue)`
      );
      inserted++;
    }

    await transaction.commit();
    log(`[entitlements] Replaced entitlements for ${userEmail} (company ${companyId}) by ${grantedByEmail}: deleted old, inserted ${inserted}`, 'entitlements');
  } catch (err: any) {
    try { await transaction.rollback(); } catch {}
    log(`[entitlements] Transaction FAILED for ${userEmail} (company ${companyId}): ${err.message}`, 'error');
    throw err;
  }
}

export async function getAllEntitlementsForCompany(companyId: number): Promise<AiUserEntitlement[]> {
  const result = await executeWebAppQuery(
    `SELECT CompanyId, UserEmail, ScopeType, ScopeValue
     FROM dbo.AiUserEntitlement
     WHERE CompanyId = @companyId
     ORDER BY UserEmail, ScopeType, ScopeValue`,
    { companyId: { type: sql.Int, value: companyId } }
  );
  return result.recordset;
}

export interface UserWithEntitlementStatus extends AiAnalyticsUser {
  hasEntitlements: boolean;
  entitlementCount: number;
}

export async function getUsersWithEntitlementStatus(companyId: number): Promise<UserWithEntitlementStatus[]> {
  const result = await executeWebAppQuery(
    `SELECT u.CompanyId, u.UserEmail, u.IsActive,
            CASE WHEN COUNT(e.ScopeType) > 0 THEN 1 ELSE 0 END AS hasEntitlements,
            COUNT(e.ScopeType) AS entitlementCount
     FROM dbo.AiAnalyticsUser u
     LEFT JOIN dbo.AiUserEntitlement e ON u.CompanyId = e.CompanyId AND u.UserEmail = e.UserEmail
     WHERE u.CompanyId = @companyId
     GROUP BY u.CompanyId, u.UserEmail, u.IsActive
     ORDER BY u.UserEmail`,
    { companyId: { type: sql.Int, value: companyId } }
  );
  return result.recordset.map((r: any) => ({
    ...r,
    hasEntitlements: r.hasEntitlements === 1,
  }));
}

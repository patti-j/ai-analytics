import sql from 'mssql';
import { executeWebAppQuery } from './db-webapp';
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
  const result = await executeWebAppQuery(
    `SELECT CompanyId, UserEmail, ScopeType, ScopeValue, GrantedByEmail, GrantedAt
     FROM dbo.AiUserEntitlement
     WHERE CompanyId = @companyId AND UserEmail = @email
     ORDER BY ScopeType, ScopeValue`,
    {
      companyId: { type: sql.Int, value: companyId },
      email: { type: sql.NVarChar(256), value: email },
    }
  );
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
  await executeWebAppQuery(
    `DELETE FROM dbo.AiUserEntitlement WHERE CompanyId = @companyId AND UserEmail = @email`,
    {
      companyId: { type: sql.Int, value: companyId },
      email: { type: sql.NVarChar(256), value: userEmail },
    }
  );

  for (const scope of scopes) {
    if (!SCOPE_TYPES.includes(scope.scopeType)) {
      log(`[entitlements] Invalid scope type: ${scope.scopeType}, skipping`, 'entitlements');
      continue;
    }
    await executeWebAppQuery(
      `INSERT INTO dbo.AiUserEntitlement (CompanyId, UserEmail, ScopeType, ScopeValue, GrantedByEmail, GrantedAt)
       VALUES (@companyId, @email, @scopeType, @scopeValue, @grantedBy, GETUTCDATE())`,
      {
        companyId: { type: sql.Int, value: companyId },
        email: { type: sql.NVarChar(256), value: userEmail },
        scopeType: { type: sql.NVarChar(50), value: scope.scopeType },
        scopeValue: { type: sql.NVarChar(256), value: scope.scopeValue },
        grantedBy: { type: sql.NVarChar(256), value: grantedByEmail },
      }
    );
  }

  log(`[entitlements] Replaced ${scopes.length} entitlements for ${userEmail} (company ${companyId}) by ${grantedByEmail}`, 'entitlements');
}

export async function getAllEntitlementsForCompany(companyId: number): Promise<AiUserEntitlement[]> {
  const result = await executeWebAppQuery(
    `SELECT CompanyId, UserEmail, ScopeType, ScopeValue, GrantedByEmail, GrantedAt
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

import sql from 'mssql';
import { executeWebAppQuery } from './db-webapp';
import { upsertUser } from './entitlement-storage';
import { log } from './index';

interface WebAppUser {
  Email: string;
  FirstName: string;
  LastName: string;
}

export async function getEligibleUsersFromWebApp(companyId: number): Promise<WebAppUser[]> {
  const result = await executeWebAppQuery(
    `SELECT DISTINCT u.Email, u.FirstName, u.LastName
     FROM dbo.[User] u
     INNER JOIN dbo.[UserRole] ur ON u.UsersId = ur.UsersId
     INNER JOIN dbo.[Role] r ON ur.RoleId = r.RoleId
     WHERE u.CompanyId = @companyId
       AND r.Name = 'AI_Analytics'
       AND u.Email IS NOT NULL
     ORDER BY u.Email`,
    { companyId: { type: sql.Int, value: companyId } }
  );
  return result.recordset;
}

export async function syncMembership(companyId: number): Promise<{ synced: number; eligible: WebAppUser[] }> {
  log(`[membership-sync] Starting sync for company ${companyId}`, 'membership-sync');

  const eligibleUsers = await getEligibleUsersFromWebApp(companyId);
  log(`[membership-sync] Found ${eligibleUsers.length} eligible users with AI_Analytics role`, 'membership-sync');

  let synced = 0;
  for (const user of eligibleUsers) {
    try {
      await upsertUser(companyId, user.Email, true);
      synced++;
    } catch (error: any) {
      log(`[membership-sync] Failed to upsert user ${user.Email}: ${error.message}`, 'membership-sync');
    }
  }

  log(`[membership-sync] Sync complete: ${synced}/${eligibleUsers.length} users synced`, 'membership-sync');
  return { synced, eligible: eligibleUsers };
}

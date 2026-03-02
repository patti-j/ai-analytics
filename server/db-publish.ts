import sql from 'mssql';
import { SecretClient } from '@azure/keyvault-secrets';
import { ClientSecretCredential } from '@azure/identity';
import { executeWebAppQuery } from './db-webapp';
import { log } from './index';

interface CompanyDbRow {
  CompanyId: number;
  DbType: string;
  DBServerName: string;
  DBName: string;
  DBUserName: string;
  DBPasswordKey: string;
}

const publishPools = new Map<number, sql.ConnectionPool>();
const secretCache = new Map<string, string>();
let kvClient: SecretClient | null = null;

function getKeyVaultClient(): SecretClient | null {
  if (kvClient) return kvClient;

  const vaultUrl = process.env.AZURE_KEYVAULT_URL;
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!vaultUrl || !tenantId || !clientId || !clientSecret) {
    log('[db-publish] Key Vault not configured (missing AZURE_KEYVAULT_URL, AZURE_TENANT_ID, AZURE_CLIENT_ID, or AZURE_CLIENT_SECRET)', 'db-publish');
    return null;
  }

  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  kvClient = new SecretClient(vaultUrl, credential);
  log(`[db-publish] Key Vault client initialized for ${vaultUrl}`, 'db-publish');
  return kvClient;
}

async function getSecretFromKeyVault(secretName: string): Promise<string | null> {
  const cached = secretCache.get(secretName);
  if (cached) return cached;

  const client = getKeyVaultClient();
  if (!client) return null;

  try {
    const secret = await client.getSecret(secretName);
    if (secret.value) {
      secretCache.set(secretName, secret.value);
      log(`[db-publish] Retrieved secret '${secretName}' from Key Vault`, 'db-publish');
      return secret.value;
    }
    log(`[db-publish] Secret '${secretName}' found in Key Vault but has no value`, 'db-publish');
    return null;
  } catch (err: any) {
    log(`[db-publish] Key Vault lookup failed for '${secretName}': ${err.message}`, 'db-publish');
    return null;
  }
}

export async function getPublishDbConfig(companyId: number): Promise<CompanyDbRow> {
  const result = await executeWebAppQuery(
    `SELECT CompanyId, DbType, DBServerName, DBName, DBUserName, DBPasswordKey
     FROM dbo.CompanyDbs
     WHERE CompanyId = @companyId AND DbType = 2`,
    { companyId: { type: sql.Int, value: companyId } }
  );

  const rows = result.recordset;

  if (rows.length === 0) {
    throw new Error(`Publish DB not configured for company ${companyId}`);
  }

  if (rows.length > 1) {
    throw new Error(`Multiple Publish DBs configured for company ${companyId}; planning area context required`);
  }

  return rows[0];
}

async function getPublishDbPassword(passwordKey: string): Promise<string> {
  const fromEnv = process.env.PUBLISH_DB_PASSWORD;
  if (fromEnv) {
    log(`[db-publish] Password resolved from PUBLISH_DB_PASSWORD env var`, 'db-publish');
    return fromEnv;
  }

  const fromKeyEnv = process.env[passwordKey];
  if (fromKeyEnv) {
    log(`[db-publish] Password resolved from ${passwordKey} env var`, 'db-publish');
    return fromKeyEnv;
  }

  const fromVault = await getSecretFromKeyVault(passwordKey);
  if (fromVault) {
    log(`[db-publish] Password resolved from Key Vault secret '${passwordKey}'`, 'db-publish');
    return fromVault;
  }

  throw new Error(`Publish DB password not found. Checked: PUBLISH_DB_PASSWORD env, ${passwordKey} env, Key Vault secret '${passwordKey}'.`);
}

export async function getPublishPool(companyId: number): Promise<sql.ConnectionPool> {
  const existing = publishPools.get(companyId);
  if (existing && existing.connected) {
    return existing;
  }

  const dbConfig = await getPublishDbConfig(companyId);
  const password = await getPublishDbPassword(dbConfig.DBPasswordKey);

  const config: sql.config = {
    server: dbConfig.DBServerName,
    database: dbConfig.DBName,
    user: dbConfig.DBUserName,
    password,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      connectTimeout: 30000,
      requestTimeout: 30000,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };

  const pool = await new sql.ConnectionPool(config).connect();
  publishPools.set(companyId, pool);
  log(`[db-publish] Connected to Publish DB for company ${companyId}: ${dbConfig.DBName} on ${dbConfig.DBServerName}`, 'db-publish');
  return pool;
}

export async function executePublishQuery(companyId: number, query: string): Promise<sql.IResult<any>> {
  const pool = await getPublishPool(companyId);
  const request = pool.request();
  return request.query(query);
}

export async function closeAllPublishPools(): Promise<void> {
  for (const [companyId, pool] of publishPools) {
    try {
      await pool.close();
      log(`[db-publish] Closed pool for company ${companyId}`, 'db-publish');
    } catch (e) {}
  }
  publishPools.clear();
}

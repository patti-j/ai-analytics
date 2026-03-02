import sql from 'mssql';
import { log } from './index';

function resolveConnectionString(): string | undefined {
  return process.env.WEBAPP_DB_CONNECTION_STRING
    || process.env.SQLAZURECONNSTR_WEBAPP_DB_CONNECTION_STRING
    || process.env.CUSTOMCONNSTR_WEBAPP_DB_CONNECTION_STRING
    || process.env.SQLCONNSTR_WEBAPP_DB_CONNECTION_STRING;
}

function getWebAppConfig(): sql.config {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    return { server: '', database: '', user: '', password: '', options: { encrypt: true } } as sql.config;
  }
  log(`[db-webapp] Connection string resolved (length: ${connectionString.length})`, 'db-webapp');

  const params: Record<string, string> = {};
  connectionString.split(';').forEach(pair => {
    const eqIndex = pair.indexOf('=');
    if (eqIndex > 0) {
      const key = pair.substring(0, eqIndex).trim().toLowerCase();
      const value = pair.substring(eqIndex + 1).trim();
      if (key && value) params[key] = value;
    }
  });

  const server = (params['server'] || params['data source'] || params['addr'] || params['address'] || '')
    .replace('tcp:', '').split(',')[0];
  const database = params['initial catalog'] || params['database'] || '';
  const user = params['user id'] || params['uid'] || params['user'] || '';
  const password = params['password'] || params['pwd'] || '';

  log(`[db-webapp] Parsed: server=${server ? server.substring(0, 20) + '...' : '(empty)'}, database=${database || '(empty)'}, user=${user || '(empty)'}, hasPassword=${!!password}`, 'db-webapp');

  return {
    server,
    database,
    user,
    password,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      connectTimeout: 30000,
      requestTimeout: 30000,
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };
}

const webAppConfig = getWebAppConfig();

const hasWebAppCredentials = Boolean(
  webAppConfig.server && webAppConfig.database && webAppConfig.user && webAppConfig.password
);

if (!hasWebAppCredentials) {
  log('[db-webapp] WARNING: WEBAPP_DB_CONNECTION_STRING not found. User/entitlement/favorites management will not work.', 'db-webapp');
  log('[db-webapp] Set WEBAPP_DB_CONNECTION_STRING as an App Setting or Connection String.', 'db-webapp');
}

let webAppPool: sql.ConnectionPool | null = null;

export async function getWebAppPool(): Promise<sql.ConnectionPool> {
  if (!hasWebAppCredentials) {
    throw new Error('WEBAPP_DB_CONNECTION_STRING not configured.');
  }

  if (webAppPool && webAppPool.connected) {
    return webAppPool;
  }

  webAppPool = await new sql.ConnectionPool(webAppConfig).connect();
  log(`[db-webapp] Connected to ${webAppConfig.database} on ${webAppConfig.server}`, 'db-webapp');
  return webAppPool;
}

export async function executeWebAppQuery(query: string, params?: Record<string, { type: any; value: any }>): Promise<sql.IResult<any>> {
  const pool = await getWebAppPool();
  const request = pool.request();

  if (params) {
    for (const [name, param] of Object.entries(params)) {
      request.input(name, param.type, param.value);
    }
  }

  return request.query(query);
}

export async function closeWebAppPool(): Promise<void> {
  if (webAppPool) {
    await webAppPool.close();
    webAppPool = null;
  }
}

export function isWebAppConfigured(): boolean {
  return hasWebAppCredentials;
}

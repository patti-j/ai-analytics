import sql from 'mssql';
import { log } from './index';

function getWebAppConfig(): sql.config {
  const databaseUrl = process.env.WEBAPP_DATABASE_URL;
  if (databaseUrl) {
    const params: Record<string, string> = {};
    databaseUrl.split(';').forEach(pair => {
      const eqIndex = pair.indexOf('=');
      if (eqIndex > 0) {
        const key = pair.substring(0, eqIndex).trim().toLowerCase();
        const value = pair.substring(eqIndex + 1).trim();
        if (key && value) params[key] = value;
      }
    });

    return {
      server: params['server']?.replace('tcp:', '').split(',')[0] || '',
      database: params['initial catalog'] || params['database'] || '',
      user: params['user id'] || params['uid'] || '',
      password: params['password'] || params['pwd'] || '',
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

  return {
    server: process.env.WEBAPP_SQL_SERVER || '',
    database: process.env.WEBAPP_SQL_DATABASE || 'pt_webapp_dev',
    user: process.env.WEBAPP_SQL_USER || '',
    password: process.env.WEBAPP_SQL_PASSWORD || '',
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
  log('[db-webapp] WARNING: WebApp database credentials not found. User management will not work.', 'db-webapp');
  log('[db-webapp] Set WEBAPP_DATABASE_URL or WEBAPP_SQL_SERVER/DATABASE/USER/PASSWORD in secrets.', 'db-webapp');
}

let webAppPool: sql.ConnectionPool | null = null;

export async function getWebAppPool(): Promise<sql.ConnectionPool> {
  if (!hasWebAppCredentials) {
    throw new Error('WebApp database credentials not configured. Set WEBAPP_DATABASE_URL or discrete WEBAPP_SQL_* secrets.');
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

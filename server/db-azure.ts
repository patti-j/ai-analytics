import sql from 'mssql';

// Azure SQL connection configuration
// Precedence: DATABASE_URL > discrete secrets (SQL_SERVER, SQL_DATABASE, etc.)

function parseConnectionString(connectionString: string): sql.config {
  // Parse Azure SQL connection string into mssql config
  const params: Record<string, string> = {};
  
  connectionString.split(';').forEach(pair => {
    const [key, value] = pair.split('=').map(s => s.trim());
    if (key && value) {
      params[key.toLowerCase()] = value;
    }
  });

  return {
    server: params['server']?.replace('tcp:', '').split(',')[0] || '',
    database: params['initial catalog'] || params['database'] || '',
    user: params['user id'] || params['uid'] || '',
    password: params['password'] || params['pwd'] || '',
    options: {
      encrypt: params['encrypt'] === 'True' || params['encrypt'] === 'true',
      trustServerCertificate: params['trustservercertificate'] === 'True' || params['trustservercertificate'] === 'true',
      connectTimeout: parseInt(params['connection timeout'] || '30', 10) * 1000,
      requestTimeout: 30000,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };
}

function getConfig(): sql.config {
  // Option 1: Use DATABASE_URL if available (preferred)
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const config = parseConnectionString(databaseUrl);
    console.log(`[db-azure] Connecting to database: ${config.database} on server: ${config.server}`);
    return config;
  }

  // Option 2: Build from discrete environment variables (backward compatible)
  return {
    server: process.env.SQL_SERVER || process.env.AZURE_SQL_SERVER || '',
    database: process.env.SQL_DATABASE || process.env.AZURE_SQL_DATABASE || '',
    user: process.env.SQL_USER || process.env.AZURE_SQL_USER || '',
    password: process.env.SQL_PASSWORD || process.env.AZURE_SQL_PASSWORD || '',
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
}

export const config = getConfig();

// Check if database credentials are configured (without logging sensitive values)
const hasCredentials = Boolean(
  config.server && config.database && config.user && config.password
);

if (!hasCredentials) {
  console.warn('⚠️  WARNING: Database credentials not found. Database queries will fail.');
  console.warn('   Set DATABASE_URL (recommended) or SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD environment variables.');
}

let pool: sql.ConnectionPool | null = null;

export async function getPool(): Promise<sql.ConnectionPool> {
  if (!hasCredentials) {
    throw new Error('Database credentials not configured. Please set DATABASE_URL or discrete SQL_* environment variables.');
  }

  if (pool && pool.connected) {
    return pool;
  }

  pool = await new sql.ConnectionPool(config).connect();
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

export async function executeQuery(query: string): Promise<sql.IResult<any>> {
  const connection = await getPool();
  const result = await connection.request().query(query);
  return result;
}

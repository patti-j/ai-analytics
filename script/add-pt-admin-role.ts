import sql from 'mssql';

const EMAIL = process.argv[2];
if (!EMAIL) {
  console.error('Usage: npx tsx script/add-pt-admin-role.ts <email>');
  process.exit(1);
}

function getWebAppConfig(): sql.config {
  const connectionString = process.env.WEBAPP_DB_CONNECTION_STRING;
  if (!connectionString) throw new Error('WEBAPP_DB_CONNECTION_STRING not set');

  const params: Record<string, string> = {};
  connectionString.split(';').forEach(pair => {
    const eqIndex = pair.indexOf('=');
    if (eqIndex > 0) {
      const key = pair.substring(0, eqIndex).trim().toLowerCase();
      const value = pair.substring(eqIndex + 1).trim();
      if (key && value) params[key] = value;
    }
  });

  const serverRaw = params['server'] || params['data source'] || '';
  return {
    server: serverRaw.replace('tcp:', '').split(',')[0] || '',
    port: serverRaw.includes(',') ? parseInt(serverRaw.split(',')[1]) : 1433,
    database: params['initial catalog'] || params['database'] || '',
    user: params['user id'] || params['uid'] || '',
    password: params['password'] || params['pwd'] || '',
    options: { encrypt: true, trustServerCertificate: false, connectTimeout: 30000, requestTimeout: 30000 },
  };
}

async function main() {
  const config = getWebAppConfig();
  console.log(`Connecting to ${config.database} on ${config.server}...`);
  const pool = await sql.connect(config);

  try {
    const userResult = await pool.request()
      .input('email', sql.NVarChar(256), EMAIL)
      .query(`SELECT Id, Email, CompanyId, IsPTAdmin FROM dbo.Users WHERE Email = @email`);

    if (userResult.recordset.length === 0) {
      console.error(`ERROR: No user found with email '${EMAIL}'`);
      process.exit(1);
    }

    const user = userResult.recordset[0];
    console.log(`Found user: Id=${user.Id}, Email=${user.Email}, CompanyId=${user.CompanyId}, IsPTAdmin=${user.IsPTAdmin}`);

    const ptAdminRole = await pool.request()
      .query(`SELECT Id, Name FROM dbo.Roles WHERE Name = 'PTAdmin'`);

    if (ptAdminRole.recordset.length === 0) {
      console.error('ERROR: PTAdmin role not found in dbo.Roles');
      process.exit(1);
    }

    const roleId = ptAdminRole.recordset[0].Id;
    console.log(`Found PTAdmin role: Id=${roleId}`);

    const existingUR = await pool.request()
      .input('usersId', sql.Int, user.Id)
      .input('roleId', sql.Int, roleId)
      .query(`SELECT * FROM dbo.UserRole WHERE UsersId = @usersId AND RoleId = @roleId`);

    if (existingUR.recordset.length > 0) {
      console.log(`User already has PTAdmin role in UserRole table.`);
    } else {
      await pool.request()
        .input('usersId', sql.Int, user.Id)
        .input('roleId', sql.Int, roleId)
        .query(`INSERT INTO dbo.UserRole (UsersId, RoleId) VALUES (@usersId, @roleId)`);
      console.log(`Inserted UserRole: UsersId=${user.Id}, RoleId=${roleId}`);
    }

    if (!user.IsPTAdmin) {
      await pool.request()
        .input('userId', sql.Int, user.Id)
        .query(`UPDATE dbo.Users SET IsPTAdmin = 1 WHERE Id = @userId`);
      console.log(`Set IsPTAdmin = 1 on Users.Id=${user.Id}`);
    } else {
      console.log(`IsPTAdmin already set to 1.`);
    }

    console.log(`\nDone. ${EMAIL} now has PT admin access.`);
  } finally {
    await pool.close();
  }
}

main().catch(err => { console.error('Script failed:', err.message); process.exit(1); });

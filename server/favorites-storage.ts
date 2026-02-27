import sql from 'mssql';
import { executeWebAppQuery } from './db-webapp';
import { log } from './index';

export interface AiUserFavorite {
  CompanyId: number;
  UserEmail: string;
  QuestionText: string;
  CreatedAt: string;
}

export async function getFavoritesForUser(companyId: number, email: string): Promise<AiUserFavorite[]> {
  const result = await executeWebAppQuery(
    `SELECT CompanyId, UserEmail, QuestionText, CreatedAt
     FROM dbo.AiUserFavorite
     WHERE CompanyId = @companyId AND UserEmail = @email
     ORDER BY CreatedAt DESC`,
    {
      companyId: { type: sql.Int, value: companyId },
      email: { type: sql.NVarChar(256), value: email },
    }
  );
  return result.recordset;
}

export async function addFavorite(companyId: number, email: string, questionText: string): Promise<void> {
  await executeWebAppQuery(
    `IF NOT EXISTS (
       SELECT 1 FROM dbo.AiUserFavorite
       WHERE CompanyId = @companyId AND UserEmail = @email AND QuestionText = @questionText
     )
     INSERT INTO dbo.AiUserFavorite (CompanyId, UserEmail, QuestionText, CreatedAt)
     VALUES (@companyId, @email, @questionText, GETUTCDATE())`,
    {
      companyId: { type: sql.Int, value: companyId },
      email: { type: sql.NVarChar(256), value: email },
      questionText: { type: sql.NVarChar(1000), value: questionText },
    }
  );
  log(`[favorites] Added favorite for ${email}: "${questionText.substring(0, 50)}"`, 'favorites');
}

export async function removeFavorite(companyId: number, email: string, questionText: string): Promise<void> {
  await executeWebAppQuery(
    `DELETE FROM dbo.AiUserFavorite
     WHERE CompanyId = @companyId AND UserEmail = @email AND QuestionText = @questionText`,
    {
      companyId: { type: sql.Int, value: companyId },
      email: { type: sql.NVarChar(256), value: email },
      questionText: { type: sql.NVarChar(1000), value: questionText },
    }
  );
  log(`[favorites] Removed favorite for ${email}: "${questionText.substring(0, 50)}"`, 'favorites');
}

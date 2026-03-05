import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { EmbedTokenPayload, EmbedSession, SCOPE_TYPES } from '@shared/schema';
import { log } from './index';
import { getEntitlementsForUser } from './entitlement-storage';
import { getFavoritesForUser } from './favorites-storage';
import { getSecretFromKeyVault } from './keyvault';

const SESSION_COOKIE_NAME = 'pt_embed_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

const sessions = new Map<string, EmbedSession>();
let cachedEmbedSecret: string | null = null;

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

async function getEmbedSecret(): Promise<string> {
  if (cachedEmbedSecret) return cachedEmbedSecret;

  const fromEnv = process.env.EMBED_TOKEN_SECRET;
  if (fromEnv) {
    log('[embed-auth] EMBED_TOKEN_SECRET resolved from env var', 'embed-auth');
    cachedEmbedSecret = fromEnv;
    return fromEnv;
  }

  const fromVault = await getSecretFromKeyVault('EMBED-TOKEN-SECRET');
  if (fromVault) {
    log('[embed-auth] EMBED_TOKEN_SECRET resolved from Key Vault (EMBED-TOKEN-SECRET)', 'embed-auth');
    cachedEmbedSecret = fromVault;
    return fromVault;
  }

  throw new Error('EMBED_TOKEN_SECRET not found. Checked: EMBED_TOKEN_SECRET env var, Key Vault secret "EMBED-TOKEN-SECRET".');
}

export async function validateEmbedToken(token: string): Promise<EmbedTokenPayload> {
  const secret = await getEmbedSecret();

  const decoded = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: 'PlanetTogether.WebApp',
    audience: 'PlanetTogether.EmbedApp',
  }) as Record<string, any>;

  const claimKeys = Object.keys(decoded);
  log(`[embed-auth] Token claims: ${JSON.stringify(claimKeys)}`, 'embed-auth');

  const findClaim = (names: string[]): any => {
    for (const name of names) {
      const key = claimKeys.find(k => k.toLowerCase() === name.toLowerCase());
      if (key !== undefined && decoded[key] !== undefined) return decoded[key];
    }
    return undefined;
  };

  const email = findClaim(['email', 'Email', 'sub', 'emailaddress', 'unique_name',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']);
  const rawCompanyId = findClaim(['companyId', 'CompanyId', 'company_id', 'companyid', 'CompanyID']);
  const rawHasRole = findClaim(['hasAIAnalyticsRole', 'HasAIAnalyticsRole', 'has_ai_analytics_role', 'hasaianalyticsrole']);
  const rawIsAdmin = findClaim(['isCompanyAdmin', 'IsCompanyAdmin', 'is_company_admin', 'iscompanyadmin']);

  log(`[embed-auth] Resolved: email=${email}, companyId=${rawCompanyId} (${typeof rawCompanyId}), hasAIAnalyticsRole=${rawHasRole} (${typeof rawHasRole}), isCompanyAdmin=${rawIsAdmin} (${typeof rawIsAdmin})`, 'embed-auth');

  const numericCompanyId = typeof rawCompanyId === 'string' ? parseInt(rawCompanyId, 10) : rawCompanyId;
  const boolHasRole = typeof rawHasRole === 'string' ? rawHasRole.toLowerCase() === 'true' : (rawHasRole === 1 ? true : rawHasRole === 0 ? false : rawHasRole);
  const boolIsAdmin = typeof rawIsAdmin === 'string' ? rawIsAdmin.toLowerCase() === 'true' : (rawIsAdmin === 1 ? true : rawIsAdmin === 0 ? false : rawIsAdmin);

  if (!email || typeof email !== 'string') {
    throw new Error(`Token missing required claim: email. Available claims: ${claimKeys.join(', ')}`);
  }
  if (typeof numericCompanyId !== 'number' || isNaN(numericCompanyId)) {
    throw new Error(`Token missing required claim: companyId. Available claims: ${claimKeys.join(', ')}`);
  }
  if (typeof boolHasRole !== 'boolean') {
    throw new Error(`Token missing required claim: hasAIAnalyticsRole. Available claims: ${claimKeys.join(', ')}`);
  }
  if (!boolHasRole) {
    throw new Error('User does not have AI Analytics role');
  }
  if (typeof boolIsAdmin !== 'boolean') {
    throw new Error(`Token missing required claim: isCompanyAdmin. Available claims: ${claimKeys.join(', ')}`);
  }

  return {
    ...decoded,
    email,
    companyId: numericCompanyId,
    hasAIAnalyticsRole: boolHasRole,
    isCompanyAdmin: boolIsAdmin,
  } as EmbedTokenPayload;
}

export function createSession(tokenPayload: EmbedTokenPayload): EmbedSession {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();

  const session: EmbedSession = {
    sessionId,
    email: tokenPayload.email,
    companyId: tokenPayload.companyId,
    isCompanyAdmin: tokenPayload.isCompanyAdmin,
    hasAIAnalyticsRole: tokenPayload.hasAIAnalyticsRole,
    createdAt: now,
    expiresAt: now + SESSION_DURATION_MS,
  };

  sessions.set(sessionId, session);
  log(`[embed-auth] Session created for ${tokenPayload.email} (company ${tokenPayload.companyId})`, 'embed-auth');
  return session;
}

export function getSession(sessionId: string): EmbedSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

export function destroySession(sessionId: string): void {
  sessions.delete(sessionId);
}

export async function handleSessionFromEmbed(req: Request, res: Response): Promise<void> {
  try {
    const { embedToken } = req.body;
    if (!embedToken || typeof embedToken !== 'string') {
      res.status(400).json({ error: 'embedToken is required' });
      return;
    }

    const tokenPayload = await validateEmbedToken(embedToken);
    const session = createSession(tokenPayload);

    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';

    res.cookie(SESSION_COOKIE_NAME, session.sessionId, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? 'none' : 'lax',
      maxAge: SESSION_DURATION_MS,
      path: '/',
    });
    log(`[embed-auth] Cookie set: secure=${isSecure}, sameSite=${isSecure ? 'none' : 'lax'}`, 'embed-auth');

    log(`[embed-auth] Loading entitlements for ${session.email} (company ${session.companyId}), isCompanyAdmin=${session.isCompanyAdmin}`, 'embed-auth');

    const [entitlements, favRows] = await Promise.all([
      session.isCompanyAdmin
        ? Promise.resolve([])
        : getEntitlementsForUser(session.companyId, session.email).catch(err => {
            log(`[embed-auth] FAILED to load entitlements for ${session.email}: ${err.message}\n${err.stack}`, 'error');
            return [];
          }),
      getFavoritesForUser(session.companyId, session.email).catch(err => {
        log(`[embed-auth] Failed to load favorites: ${err.message}`, 'embed-auth');
        return [];
      }),
    ]);

    if (!session.isCompanyAdmin) {
      log(`[embed-auth] Entitlements loaded for ${session.email}: ${entitlements.length} scopes`, 'embed-auth');
    }
    log(`[embed-auth] Session for ${session.email}: isCompanyAdmin=${session.isCompanyAdmin}, entitlements=${entitlements.length}`, 'embed-auth');

    const favorites = favRows.map(r => ({
      question: r.QuestionText,
      savedAt: r.CreatedAt,
    }));

    res.json({
      ok: true,
      session: {
        email: session.email,
        companyId: session.companyId,
        isCompanyAdmin: session.isCompanyAdmin,
        expiresAt: session.expiresAt,
      },
      sessionId: session.sessionId,
      isAdmin: session.isCompanyAdmin,
      entitlements,
      scopeTypes: SCOPE_TYPES,
      favorites,
    });
  } catch (error: any) {
    log(`[embed-auth] Token validation failed: ${error.message}`, 'embed-auth');
    res.status(401).json({ error: error.message || 'Invalid embed token' });
  }
}

declare global {
  namespace Express {
    interface Request {
      embedSession?: EmbedSession;
    }
  }
}

const UNPROTECTED_ROUTES = [
  '/api/session/from-embed',
  '/api/health',
  '/api/config',
];

export function getSessionIdFromCookie(req: Request): string | undefined {
  return req.cookies?.[SESSION_COOKIE_NAME];
}

export function embedSessionMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  if (UNPROTECTED_ROUTES.includes(req.path)) {
    next();
    return;
  }

  const isStreamRoute = req.path === '/api/ask/stream';
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME] || (isStreamRoute ? (req.query._sid as string) : undefined);
  if (!sessionId) {
    res.status(401).json({ error: 'No session. Please authenticate via embed token.' });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(401).json({ error: 'Session expired or invalid. Please re-authenticate.' });
    return;
  }

  req.embedSession = session;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.embedSession) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (req.embedSession.isCompanyAdmin) {
    next();
    return;
  }
  res.status(403).json({ error: 'Company Admin access required' });
}

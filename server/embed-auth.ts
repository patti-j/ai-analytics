import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { EmbedTokenPayload, EmbedSession, SCOPE_TYPES } from '@shared/schema';
import { log } from './index';
import { getEntitlementsForUser } from './entitlement-storage';
import { getFavoritesForUser } from './favorites-storage';

const SESSION_COOKIE_NAME = 'pt_embed_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

const sessions = new Map<string, EmbedSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

function getEmbedSecret(): string {
  const secret = process.env.EMBED_TOKEN_SECRET;
  if (!secret) {
    throw new Error('EMBED_TOKEN_SECRET environment variable is not set');
  }
  return secret;
}

export function validateEmbedToken(token: string): EmbedTokenPayload {
  const secret = getEmbedSecret();

  const decoded = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: 'PlanetTogether.WebApp',
    audience: 'PlanetTogether.EmbedApp',
  }) as EmbedTokenPayload;

  if (!decoded.email || typeof decoded.email !== 'string') {
    throw new Error('Token missing required claim: email');
  }
  if (typeof decoded.companyId !== 'number') {
    throw new Error('Token missing required claim: companyId');
  }
  if (typeof decoded.hasAIAnalyticsRole !== 'boolean') {
    throw new Error('Token missing required claim: hasAIAnalyticsRole');
  }
  if (!decoded.hasAIAnalyticsRole) {
    throw new Error('User does not have AI Analytics role');
  }
  if (typeof decoded.isCompanyAdmin !== 'boolean') {
    throw new Error('Token missing required claim: isCompanyAdmin');
  }

  return decoded;
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

    const tokenPayload = validateEmbedToken(embedToken);
    const session = createSession(tokenPayload);

    const isProduction = process.env.NODE_ENV === 'production';

    res.cookie(SESSION_COOKIE_NAME, session.sessionId, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: SESSION_DURATION_MS,
      path: '/',
    });

    const [entitlements, favRows] = await Promise.all([
      session.isCompanyAdmin
        ? Promise.resolve([])
        : getEntitlementsForUser(session.companyId, session.email).catch(err => {
            log(`[embed-auth] Failed to load entitlements: ${err.message}`, 'embed-auth');
            return [];
          }),
      getFavoritesForUser(session.companyId, session.email).catch(err => {
        log(`[embed-auth] Failed to load favorites: ${err.message}`, 'embed-auth');
        return [];
      }),
    ]);

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
];

export function embedSessionMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  if (UNPROTECTED_ROUTES.includes(req.path)) {
    next();
    return;
  }

  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
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
  if (!req.embedSession.isCompanyAdmin || !req.embedSession.hasAIAnalyticsRole) {
    res.status(403).json({ error: 'Company Admin access required' });
    return;
  }
  next();
}

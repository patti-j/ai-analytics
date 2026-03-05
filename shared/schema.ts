import { z } from "zod";

// ── Entitlement scope types ──────────────────────────────────────────
// These 6 scope types map 1:1 to the global filter dropdowns and to
// the column families used by enforceEntitlements() in query-permissions.ts.
export const SCOPE_TYPES = ['PlanningArea', 'Plant', 'Scenario', 'Resource', 'Product', 'Workcenter'] as const;
export type ScopeType = typeof SCOPE_TYPES[number];

// ── Webapp DB row types (dbo.AiAnalyticsUser, dbo.AiUserEntitlement) ─
export interface AiAnalyticsUser {
  CompanyId: number;
  UserEmail: string;
  IsActive: boolean;
}

export interface AiUserEntitlement {
  CompanyId: number;
  UserEmail: string;
  ScopeType: ScopeType;
  ScopeValue: string;
}

// ── Embed auth (JWT + session) ───────────────────────────────────────
// EmbedTokenPayload: Claims decoded from the JWT sent by the Blazor parent.
// Admin status is determined solely by the isCompanyAdmin claim.
export interface EmbedTokenPayload {
  email: string;
  companyId: number;
  hasAIAnalyticsRole: boolean;
  isCompanyAdmin: boolean;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

// EmbedSession: Server-side session created after JWT validation.
// Stored in-memory Map keyed by sessionId, expires after 8 hours.
export interface EmbedSession {
  sessionId: string;
  email: string;
  companyId: number;
  isCompanyAdmin: boolean;
  hasAIAnalyticsRole: boolean;
  expiresAt: number;
}

// ── API validation schemas ───────────────────────────────────────────
export const entitlementSaveSchema = z.object({
  scopes: z.array(z.object({
    scopeType: z.enum(SCOPE_TYPES),
    scopeValue: z.string(),
  })),
});

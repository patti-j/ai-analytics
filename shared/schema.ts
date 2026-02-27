import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const popularQueries = pgTable("popular_queries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  question: text("question").notNull().unique(),
  count: integer("count").notNull().default(1),
  lastUsed: timestamp("last_used").notNull().default(sql`now()`),
});

export const insertPopularQuerySchema = createInsertSchema(popularQueries).omit({
  id: true,
});

export type InsertPopularQuery = z.infer<typeof insertPopularQuerySchema>;
export type PopularQuery = typeof popularQueries.$inferSelect;

// User Permissions schema for admin management
export const SCOPE_TYPES = ['PlanningArea', 'Plant', 'Scenario', 'Resource', 'Product', 'Workcenter'] as const;
export type ScopeType = typeof SCOPE_TYPES[number];

export interface AiAnalyticsUser {
  CompanyId: number;
  UserEmail: string;
  IsActive: boolean;
  CreatedAt: string;
  UpdatedAt: string;
}

export interface AiUserEntitlement {
  CompanyId: number;
  UserEmail: string;
  ScopeType: ScopeType;
  ScopeValue: string;
  GrantedByEmail: string;
  GrantedAt: string;
}

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

export interface EmbedSession {
  sessionId: string;
  email: string;
  companyId: number;
  isCompanyAdmin: boolean;
  hasAIAnalyticsRole: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface EmbedAuthMessage {
  type: 'PT.EMBED.AUTH';
  version: number;
  payload: {
    embedToken: string;
    ui: {
      theme: 'dark' | 'light';
    };
  };
}

export const entitlementSaveSchema = z.object({
  scopes: z.array(z.object({
    scopeType: z.enum(SCOPE_TYPES),
    scopeValue: z.string(),
  })),
});

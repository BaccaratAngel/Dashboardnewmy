import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),

  // ── Layer 1: single active session token ────────────────────────────────────
  // Null means logged out. On every new login this is replaced, instantly
  // invalidating any prior session (the anti-sharing core mechanism).
  activeSessionId: text("active_session_id"),

  // ── Layer 2: session fingerprint ────────────────────────────────────────────
  // Recorded at login; verified on every authenticated request.
  // Mismatch → 401 + auto-kick (stolen-cookie protection).
  sessionUserAgent: text("session_user_agent"),
  sessionIp: text("session_ip"),

  // ── Layer 3: heartbeat presence ─────────────────────────────────────────────
  // Updated every 30 s by the dashboard. If the same session token is seen
  // from a second IP within 60 s, both are kicked and the account is flagged.
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastSeenIp: text("last_seen_ip"),
  flaggedAt: timestamp("flagged_at", { withTimezone: true }),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  lastLoginAt: true,
  activeSessionId: true,
  sessionUserAgent: true,
  sessionIp: true,
  lastSeenAt: true,
  lastSeenIp: true,
  flaggedAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { adminSessions } from "../lib/adminSessions.js";
import { clearSession } from "../lib/engines/session.js";

const router = Router();

const IS_PROD = process.env["NODE_ENV"] === "production";

const ADMIN_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: IS_PROD,
  maxAge: 4 * 60 * 60 * 1000, // 4 hours
};

function buildUserList(users: (typeof usersTable.$inferSelect)[]) {
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    expiresAt: u.expiresAt.toISOString(),
    createdAt: u.createdAt.toISOString(),
    isOnline: u.activeSessionId !== null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    // Layer 3: presence + flag fields
    lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
    lastSeenIp: u.lastSeenIp ?? null,
    sessionIp: u.sessionIp ?? null,
    sessionUserAgent: u.sessionUserAgent ?? null,
    flaggedAt: u.flaggedAt?.toISOString() ?? null,
  }));
}

// POST /admin/login
router.post("/login", async (req, res) => {
  const { password } = req.body as { password?: string };
  const adminPassword = process.env["ADMIN_PASSWORD"];
  if (!adminPassword) {
    req.log.error("Admin login unavailable: ADMIN_PASSWORD is not configured");
    res.status(500).json({ error: "Admin password not configured" });
    return;
  }
  if (!password || password !== adminPassword) {
    req.log.warn("Admin login rejected: invalid password");
    res.status(401).json({ error: "Wrong admin password" });
    return;
  }
  const token = randomUUID();
  adminSessions.add(token);
  res.cookie("admin_session", token, ADMIN_COOKIE_OPTS);
  req.log.info("Admin login accepted");
  res.json({ ok: true });
});

// POST /admin/logout
router.post("/logout", requireAdmin, (req, res) => {
  const token = req.cookies?.["admin_session"] as string | undefined;
  if (token) adminSessions.delete(token);
  res.clearCookie("admin_session");
  req.log.info("Admin logout completed");
  res.status(204).send();
});

// GET /admin/users
router.get("/users", requireAdmin, async (req, res) => {
  const users = await db.select().from(usersTable).orderBy(usersTable.id);
  req.log.info({ userCount: users.length }, "Admin listed users");
  res.json(buildUserList(users));
});

// POST /admin/users
router.post("/users", requireAdmin, async (req, res) => {
  const { username, password, expiresAt } = req.body as {
    username?: string;
    password?: string;
    expiresAt?: string;
  };
  const normalizedUsername = username?.trim();
  if (!normalizedUsername || !password || !expiresAt) {
    req.log.warn("Admin create-user rejected: missing required fields");
    res.status(400).json({ error: "username, password, and expiresAt required" });
    return;
  }
  if (password.length < 6) {
    req.log.warn({ username: normalizedUsername }, "Admin create-user rejected: password too short");
    res.status(400).json({ error: "password must be at least 6 characters" });
    return;
  }
  const expiryDate = new Date(expiresAt);
  if (isNaN(expiryDate.getTime())) {
    req.log.warn({ username: normalizedUsername }, "Admin create-user rejected: invalid expiry");
    res.status(400).json({ error: "Invalid expiresAt date" });
    return;
  }

  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, normalizedUsername))
    .limit(1);
  if (existing.length > 0) {
    req.log.warn({ username: normalizedUsername }, "Admin create-user rejected: username already exists");
    res.status(400).json({ error: "Username already taken" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const inserted = await db
      .insert(usersTable)
      .values({ username: normalizedUsername, passwordHash, expiresAt: expiryDate })
      .returning();

    const u = inserted[0];
    req.log.info({ userId: u.id, username: u.username }, "Admin created user");
    res.status(201).json({
      id: u.id,
      username: u.username,
      expiresAt: u.expiresAt.toISOString(),
      createdAt: u.createdAt.toISOString(),
      isOnline: false,
      lastLoginAt: null,
      lastSeenAt: null,
      lastSeenIp: null,
      sessionIp: null,
      sessionUserAgent: null,
      flaggedAt: null,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      req.log.warn({ username: normalizedUsername }, "Admin create-user rejected: concurrent duplicate username");
      res.status(400).json({ error: "Username already taken" });
      return;
    }
    req.log.error({ err: error, username: normalizedUsername }, "Admin create-user failed");
    res.status(500).json({ error: "Unable to create user. Check the server log for details." });
  }
});

// PATCH /admin/users/:id
router.patch("/users/:id", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? "0"), 10);
  const { username, password, expiresAt } = req.body as {
    username?: string;
    password?: string;
    expiresAt?: string;
  };

  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (username) updates.username = username;
  if (password) {
    if (password.length < 6) {
      res.status(400).json({ error: "password must be at least 6 characters" });
      return;
    }
    updates.passwordHash = await bcrypt.hash(password, 12);
  }
  if (expiresAt) {
    const d = new Date(expiresAt);
    if (isNaN(d.getTime())) {
      res.status(400).json({ error: "Invalid expiresAt date" });
      return;
    }
    updates.expiresAt = d;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const updated = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, id))
    .returning();

  if (updated.length === 0) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const u = updated[0];
  res.json({
    id: u.id,
    username: u.username,
    expiresAt: u.expiresAt.toISOString(),
    createdAt: u.createdAt.toISOString(),
    isOnline: u.activeSessionId !== null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
    lastSeenIp: u.lastSeenIp ?? null,
    sessionIp: u.sessionIp ?? null,
    sessionUserAgent: u.sessionUserAgent ?? null,
    flaggedAt: u.flaggedAt?.toISOString() ?? null,
  });
});

// DELETE /admin/users/:id
router.delete("/users/:id", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? "0"), 10);
  const deleted = await db
    .delete(usersTable)
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  clearSession(id);
  res.status(204).send();
});

// POST /admin/users/:id/kick
router.post("/users/:id/kick", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? "0"), 10);
  const updated = await db
    .update(usersTable)
    .set({ activeSessionId: null, sessionUserAgent: null, sessionIp: null })
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id });
  if (updated.length === 0) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.status(204).send();
});

// POST /admin/users/:id/unflag  — clears the sharing-detection flag
router.post("/users/:id/unflag", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? "0"), 10);
  const updated = await db
    .update(usersTable)
    .set({ flaggedAt: null })
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id });
  if (updated.length === 0) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.status(204).send();
});

export default router;

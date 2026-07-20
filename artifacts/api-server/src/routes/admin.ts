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

const ADMIN_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 4 * 60 * 60 * 1000, // 4 hours
};

// Load current active sessions for isOnline check (in-memory map of userId → sessionId)
// We compare activeSessionId against what we stored to determine isOnline
async function buildUserList() {
  const users = await db.select().from(usersTable).orderBy(usersTable.id);
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    expiresAt: u.expiresAt.toISOString(),
    createdAt: u.createdAt.toISOString(),
    isOnline: u.activeSessionId !== null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  }));
}

// POST /admin/login
router.post("/login", async (req, res) => {
  const { password } = req.body as { password?: string };
  const adminPassword = process.env["ADMIN_PASSWORD"];
  if (!adminPassword) {
    res.status(500).json({ error: "Admin password not configured" });
    return;
  }
  if (!password || password !== adminPassword) {
    res.status(401).json({ error: "Wrong admin password" });
    return;
  }
  const token = randomUUID();
  adminSessions.add(token);
  res.cookie("admin_session", token, ADMIN_COOKIE_OPTS);
  res.json({ ok: true });
});

// POST /admin/logout
router.post("/logout", requireAdmin, (req, res) => {
  const token = req.cookies?.["admin_session"] as string | undefined;
  if (token) adminSessions.delete(token);
  res.clearCookie("admin_session");
  res.status(204).send();
});

// GET /admin/users
router.get("/users", requireAdmin, async (_req, res) => {
  const list = await buildUserList();
  res.json(list);
});

// POST /admin/users
router.post("/users", requireAdmin, async (req, res) => {
  const { username, password, expiresAt } = req.body as {
    username?: string;
    password?: string;
    expiresAt?: string;
  };
  if (!username || !password || !expiresAt) {
    res.status(400).json({ error: "username, password, and expiresAt required" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "password must be at least 6 characters" });
    return;
  }
  const expiryDate = new Date(expiresAt);
  if (isNaN(expiryDate.getTime())) {
    res.status(400).json({ error: "Invalid expiresAt date" });
    return;
  }

  // Check uniqueness
  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);
  if (existing.length > 0) {
    res.status(400).json({ error: "Username already taken" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const inserted = await db
    .insert(usersTable)
    .values({ username, passwordHash, expiresAt: expiryDate })
    .returning();

  const u = inserted[0];
  res.status(201).json({
    id: u.id,
    username: u.username,
    expiresAt: u.expiresAt.toISOString(),
    createdAt: u.createdAt.toISOString(),
    isOnline: false,
    lastLoginAt: null,
  });
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
    .set({ activeSessionId: null })
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id });
  if (updated.length === 0) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.status(204).send();
});

export default router;

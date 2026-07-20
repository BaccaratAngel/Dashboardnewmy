import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireUser } from "../middleware/requireUser.js";

const router = Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

// POST /auth/login
router.post("/login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: "Username and password required" });
    return;
  }

  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  const user = users[0];
  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  if (new Date() > user.expiresAt) {
    res.status(401).json({ error: "Account expired. Contact admin." });
    return;
  }

  // Generate new session token — invalidates any existing session (anti-sharing)
  const token = randomUUID();
  await db
    .update(usersTable)
    .set({ activeSessionId: token, lastLoginAt: new Date() })
    .where(eq(usersTable.id, user.id));

  res.cookie("session", token, COOKIE_OPTS);
  res.json({
    id: user.id,
    username: user.username,
    expiresAt: user.expiresAt.toISOString(),
  });
});

// POST /auth/logout
router.post("/logout", requireUser, async (req, res) => {
  const userId = req.user!.id;
  await db
    .update(usersTable)
    .set({ activeSessionId: null })
    .where(eq(usersTable.id, userId));
  res.clearCookie("session");
  res.status(204).send();
});

// GET /auth/me
router.get("/me", requireUser, (req, res) => {
  const user = req.user!;
  res.json({
    id: user.id,
    username: user.username,
    expiresAt: user.expiresAt.toISOString(),
  });
});

export default router;

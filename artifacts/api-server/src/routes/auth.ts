import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireUser } from "../middleware/requireUser.js";
import { checkLoginRateLimit, clearLoginRateLimit } from "../lib/rateLimiter.js";
import { getClientIp } from "../lib/clientIp.js";

const router = Router();

const IS_PROD = process.env["NODE_ENV"] === "production";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "strict" as const,   // Layer 1: no cross-site cookie leakage
  secure: IS_PROD,               // Layer 1: HTTPS-only in production
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

// ── POST /auth/login ─────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const ip = getClientIp(req);

  // Layer 1: rate limit — 5 attempts per IP per 15 minutes
  const rate = checkLoginRateLimit(ip);
  if (!rate.allowed) {
    const retryAfterSec = Math.ceil((rate.resetAt - Date.now()) / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: `Too many login attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.`,
    });
    return;
  }

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
    // Generic message — don't reveal whether the username exists
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

  // Success — clear rate limit bucket for this IP
  clearLoginRateLimit(ip);

  // Layer 1: new token invalidates any existing session (single-session enforcement)
  // Layer 2: record UA + IP fingerprint at login time
  const token = randomUUID();
  const ua = (req.headers["user-agent"] ?? "").slice(0, 512); // cap length

  await db
    .update(usersTable)
    .set({
      activeSessionId: token,
      lastLoginAt: new Date(),
      // Layer 2 fingerprint
      sessionUserAgent: ua,
      sessionIp: ip,
      // Clear any previous heartbeat / flag state on fresh login
      lastSeenAt: new Date(),
      lastSeenIp: ip,
      flaggedAt: null,
    })
    .where(eq(usersTable.id, user.id));

  res.cookie("session", token, COOKIE_OPTS);
  res.json({
    id: user.id,
    username: user.username,
    expiresAt: user.expiresAt.toISOString(),
  });
});

// ── POST /auth/logout ────────────────────────────────────────────────────────
router.post("/logout", requireUser, async (req, res) => {
  const userId = req.user!.id;
  await db
    .update(usersTable)
    .set({ activeSessionId: null, sessionUserAgent: null, sessionIp: null })
    .where(eq(usersTable.id, userId));
  res.clearCookie("session");
  res.status(204).send();
});

// ── GET /auth/me ─────────────────────────────────────────────────────────────
router.get("/me", requireUser, (req, res) => {
  const user = req.user!;
  res.json({
    id: user.id,
    username: user.username,
    expiresAt: user.expiresAt.toISOString(),
  });
});

// ── POST /auth/heartbeat ─────────────────────────────────────────────────────
// Layer 3: called by dashboard every 30 s.
// Updates lastSeenAt/lastSeenIp. Detects same session appearing from two
// different IPs within 60 s → kicks both + flags the account.
router.post("/heartbeat", requireUser, async (req, res) => {
  const userId = req.user!.id;
  const ip = getClientIp(req);
  const now = new Date();

  // Fetch the full row to check prior IP
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    res.status(401).json({ error: "Session invalid" });
    return;
  }

  const CONCURRENT_WINDOW_MS = 60_000; // 60 seconds
  const priorIp = row.lastSeenIp;
  const priorSeen = row.lastSeenAt;

  const differentIp = priorIp && priorIp !== ip;
  const recentlySeen =
    priorSeen && now.getTime() - priorSeen.getTime() < CONCURRENT_WINDOW_MS;

  if (differentIp && recentlySeen) {
    // Concurrent session from different IP detected → kick + flag
    await db
      .update(usersTable)
      .set({
        activeSessionId: null,
        sessionUserAgent: null,
        sessionIp: null,
        flaggedAt: now,
      })
      .where(eq(usersTable.id, userId));

    res.clearCookie("session");
    res
      .status(401)
      .json({ error: "Concurrent session detected. Account suspended. Contact admin." });
    return;
  }

  // Normal heartbeat — update presence
  await db
    .update(usersTable)
    .set({ lastSeenAt: now, lastSeenIp: ip })
    .where(eq(usersTable.id, userId));

  res.json({ ok: true });
});

export default router;

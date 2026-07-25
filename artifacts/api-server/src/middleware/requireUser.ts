/**
 * requireUser middleware
 *
 * 1. Reads the session cookie.
 * 2. Validates it against DB (single-session enforcement).
 * 3. Checks account expiry.
 * 4. Layer 2 — verifies User-Agent fingerprint matches what was recorded at
 *    login. Mismatch means a cookie was stolen and used on another device.
 *    Auto-kicks the session on mismatch.
 */
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export interface AuthUser {
  id: number;
  username: string;
  expiresAt: Date;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.cookies?.["session"] as string | undefined;
  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.activeSessionId, token))
    .limit(1);

  const user = users[0];
  if (!user) {
    res.status(401).json({ error: "Session invalid" });
    return;
  }

  if (new Date() > user.expiresAt) {
    res.status(401).json({ error: "Account expired" });
    return;
  }

  // ── Layer 2: User-Agent fingerprint check ──────────────────────────────────
  // If we recorded a UA at login and the current request UA doesn't match,
  // treat it as a stolen cookie — kick the session immediately.
  if (user.sessionUserAgent) {
    const currentUa = (req.headers["user-agent"] ?? "").slice(0, 512);
    if (currentUa !== user.sessionUserAgent) {
      // Auto-kick: clear the session so the real owner is also prompted to log back in
      await db
        .update(usersTable)
        .set({ activeSessionId: null, sessionUserAgent: null, sessionIp: null })
        .where(eq(usersTable.id, user.id));
      res.clearCookie("session");
      res.status(401).json({ error: "Session fingerprint mismatch. Please log in again." });
      return;
    }
  }

  req.user = { id: user.id, username: user.username, expiresAt: user.expiresAt };
  next();
}

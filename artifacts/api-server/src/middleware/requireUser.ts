/**
 * requireUser middleware
 * Reads the session cookie, validates it against the DB, and attaches
 * the user object to req. Returns 401 if invalid or expired.
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

  req.user = { id: user.id, username: user.username, expiresAt: user.expiresAt };
  next();
}

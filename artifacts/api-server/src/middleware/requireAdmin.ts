/**
 * requireAdmin middleware
 * Reads the admin session cookie and validates it against the in-memory store.
 * Returns 401 if invalid.
 */
import type { Request, Response, NextFunction } from "express";
import { adminSessions } from "../lib/adminSessions.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      isAdmin?: boolean;
    }
  }
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = req.cookies?.["admin_session"] as string | undefined;
  if (!token || !adminSessions.has(token)) {
    req.log.warn("Admin request rejected: missing or invalid admin session");
    res.status(401).json({ error: "Not authenticated as admin" });
    return;
  }
  req.isAdmin = true;
  next();
}

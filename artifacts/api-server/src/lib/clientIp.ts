import type { Request } from "express";

/**
 * Extract the real client IP, honouring X-Forwarded-For from proxies
 * (Replit terminates TLS at the edge and forwards the real IP).
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return raw.split(",")[0].trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

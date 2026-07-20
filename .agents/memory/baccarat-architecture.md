---
name: Baccarat App Architecture
description: High-level system design for the Baccarat prediction dashboard — routing, sessions, anti-sharing, admin.
---

## Routing
- API server on port 8080, paths = ["/api"] in artifact.toml → shared proxy routes /api/* there.
- Dashboard on port 23183 (env PORT), paths = ["/"] → serves React SPA.
- Frontend uses relative URLs (/api/...) — no Vite proxy needed, shared proxy handles it.

## Auth
- Cookie name: "session" (httpOnly, sameSite=lax, 30 days)
- Anti-sharing: each new login generates a new UUID token stored in users.activeSessionId; old sessions are invalidated immediately.
- Account expiry: checked on every requireUser call against users.expiresAt.
- Admin cookie: "admin_session" (httpOnly, 4 hours); backed by in-memory Set<string> (cleared on restart).
- Admin password from ADMIN_PASSWORD env secret.

## Per-user Game State
- GameSession class orchestrates all engines; one instance per user stored in a Map<number, GameSession>.
- State is in-memory only; cleared on server restart.
- clearSession(userId) deletes a user's game state (called on user delete).

## DB Schema (users table)
- id, username (unique), passwordHash, expiresAt, createdAt, lastLoginAt, activeSessionId (nullable)
- bcryptjs for hashing (pure JS, avoids native build issues on Replit).

**Why:** Browser never sees source code; all engine logic runs server-side only.

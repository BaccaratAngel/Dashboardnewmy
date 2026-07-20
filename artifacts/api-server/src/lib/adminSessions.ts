/**
 * In-memory admin session store.
 * Admin sessions are invalidated on server restart (intentional).
 */
export const adminSessions = new Set<string>();

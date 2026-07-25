/**
 * In-memory login rate limiter.
 * Allows MAX_ATTEMPTS per IP within WINDOW_MS before blocking.
 * Resets automatically after the window expires.
 */

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

const store = new Map<string, Bucket>();

// Periodically clean up expired buckets to avoid memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of store.entries()) {
    if (now > bucket.resetAt) store.delete(ip);
  }
}, 5 * 60 * 1000); // sweep every 5 minutes

export function checkLoginRateLimit(ip: string): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  const now = Date.now();
  let bucket = store.get(ip);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    store.set(ip, bucket);
  }

  bucket.count++;
  const remaining = Math.max(0, MAX_ATTEMPTS - bucket.count);
  return { allowed: bucket.count <= MAX_ATTEMPTS, remaining, resetAt: bucket.resetAt };
}

/** Call on successful login to clear the bucket for this IP. */
export function clearLoginRateLimit(ip: string): void {
  store.delete(ip);
}

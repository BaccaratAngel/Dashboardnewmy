/**
 * Auto-scan endpoint — accepts an image POSTed by Tasker/MacroDroid,
 * runs server-side colour detection, and auto-submits the outcome
 * to the user's game session. Auth via Bearer token (no cookie needed).
 */
import { Router } from "express";
import multer from "multer";
import { Jimp } from "jimp";
import { randomUUID } from "crypto";
import { requireUser } from "../middleware/requireUser.js";
import { getOrCreateSession } from "../lib/engines/session.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ── In-memory stores ──────────────────────────────────────────────────────────
const scanTokens = new Map<number, string>();

// Deduplication: track last submitted outcome + time per user.
// Same outcome within 20 s = duplicate from the same popup → reject.
// Different outcome → always accept immediately (next hand started).
// Same outcome after 20 s → accept (new hand with same result).
const lastSubmit = new Map<number, { outcome: string; time: number }>();
const DEDUP_MS = 20_000;

function isDuplicate(userId: number, outcome: string): boolean {
  const prev = lastSubmit.get(userId);
  if (!prev) return false;
  return prev.outcome === outcome && Date.now() - prev.time < DEDUP_MS;
}

function recordSubmit(userId: number, outcome: string) {
  lastSubmit.set(userId, { outcome, time: Date.now() });
}

// ── GET /game/scan-token ─────────────────────────────────────────────────────
// Returns (or generates) the bearer token for this user's auto-scan requests.
// Requires the normal cookie session so the user must be logged in on the web.
router.get("/scan-token", requireUser, (req, res) => {
  const userId = req.user!.id;
  if (!scanTokens.has(userId)) {
    scanTokens.set(userId, randomUUID());
  }
  res.json({ token: scanTokens.get(userId) });
});

// ── POST /game/auto-scan ─────────────────────────────────────────────────────
// Accepts:  multipart/form-data  with field "image" (any image file)
// Auth:     Authorization: Bearer <token>  (from GET /game/scan-token)
router.post("/auto-scan", upload.single("image"), async (req, res) => {
  // 1. Bearer token auth
  const authHeader = (req.headers["authorization"] ?? "") as string;
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    res.status(401).json({ error: "Missing Authorization: Bearer <token> header" });
    return;
  }

  let userId: number | null = null;
  for (const [uid, tok] of scanTokens) {
    if (tok === token) { userId = uid; break; }
  }

  if (userId === null) {
    res.status(401).json({ error: "Invalid or expired token. Open tracker → AUTO SCAN → TASKER SETUP to get a fresh token." });
    return;
  }

  // 2. Image required
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No image file. Send image as multipart field named 'image'." });
    return;
  }

  // 3. Detect outcome from pixels
  let outcome: "B" | "P" | "T" | null = null;
  try {
    const image = await Jimp.read(file.buffer);
    outcome = detectOutcome(image);
  } catch (err) {
    res.status(422).json({ error: "Could not decode image: " + String(err) });
    return;
  }

  if (!outcome) {
    res.json({ detected: null, submitted: false, message: "No clear BANKER/PLAYER/TIE detected in image — nothing submitted." });
    return;
  }

  // 4. Deduplication — same result within 20 s = same popup still showing
  if (isDuplicate(userId, outcome)) {
    res.json({ detected: outcome, submitted: false, message: "Duplicate suppressed — same result within 20 s." });
    return;
  }

  // 5. Auto-submit to game session
  recordSubmit(userId, outcome);
  const session = getOrCreateSession(userId);
  const snap = session.handleInput(outcome);
  req.log.info({ userId, outcome }, "auto-scan submitted outcome");

  res.json({ detected: outcome, submitted: true, handCount: snap.road?.length ?? 0 });
});

// ── Server-side colour detection (mirrors client-side logic) ─────────────────
function detectOutcome(image: Jimp): "B" | "P" | "T" | null {
  const { width, height, data } = image.bitmap; // data = raw RGBA Buffer

  // Scan ONLY top 35% of image — result banner is here (over dealer head).
  // The permanent PLAYER/BANKER betting labels are in the bottom 40% and are ignored.
  const scanH  = Math.floor(height * 0.35);
  const xFrom  = Math.floor(width  * 0.05);
  const xTo    = Math.floor(width  * 0.95);

  let red = 0, blue = 0, green = 0, sampled = 0;

  for (let y = 0; y < scanH; y++) {
    for (let x = xFrom; x < xTo; x++) {
      const i = (y * width + x) * 4;
      const r = (data as Buffer)[i]!;
      const g = (data as Buffer)[i + 1]!;
      const b = (data as Buffer)[i + 2]!;

      const brightness = (r + g + b) / 3;
      if (brightness < 20 || brightness > 235) continue;

      // Banker: vivid red / crimson
      if (r > 120 && r > g * 1.6 && r > b * 1.6) red++;
      // Player: deep blue / navy
      else if (b > 100 && b > r * 1.4 && b > g * 1.1) blue++;
      // Player alt: cyan / teal
      else if (g > 120 && b > 120 && r < 110 && b > g * 0.85) blue++;
      // Tie: green
      else if (g > 110 && g > r * 1.5 && g > b * 1.3) green++;

      sampled++;
    }
  }

  if (sampled < 200) return null;

  const THRESHOLD = 0.045;
  const rPct = red   / sampled;
  const bPct = blue  / sampled;
  const gPct = green / sampled;

  if (rPct > THRESHOLD && rPct > bPct * 1.2 && rPct > gPct * 1.2) return "B";
  if (bPct > THRESHOLD && bPct > rPct * 1.2 && bPct > gPct * 1.2) return "P";
  if (gPct > THRESHOLD && gPct > rPct * 1.2 && gPct > bPct * 1.2) return "T";

  return null;
}

// ── POST /game/auto-input ─────────────────────────────────────────────────────
// Accepts:  JSON  { "value": "B" | "P" | "T" }
// Auth:     Authorization: Bearer <token>
// Used by MacroDroid accessibility trigger — no screenshot needed at all.
router.post("/auto-input", async (req, res) => {
  // Bearer token auth
  const authHeader = (req.headers["authorization"] ?? "") as string;
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    res.status(401).json({ error: "Missing Authorization: Bearer <token> header" });
    return;
  }

  let userId: number | null = null;
  for (const [uid, tok] of scanTokens) {
    if (tok === token) { userId = uid; break; }
  }

  if (userId === null) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const { value } = req.body as { value?: string };
  const outcome = (value ?? "").toUpperCase() as "B" | "P" | "T";

  if (!["B", "P", "T"].includes(outcome)) {
    res.status(400).json({ error: "value must be B, P, or T" });
    return;
  }

  // Deduplication — same result within 20 s = duplicate popup trigger
  if (isDuplicate(userId, outcome)) {
    res.json({ submitted: false, outcome, message: "Duplicate suppressed — same result within 20 s." });
    return;
  }

  recordSubmit(userId, outcome);
  const session = getOrCreateSession(userId);
  const snap = session.handleInput(outcome);
  req.log.info({ userId, outcome }, "auto-input submitted outcome");

  res.json({ submitted: true, outcome, handCount: snap.road?.length ?? 0 });
});

export default router;

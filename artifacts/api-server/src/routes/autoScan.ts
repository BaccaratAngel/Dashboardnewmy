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

// ── In-memory token store: userId → token ────────────────────────────────────
// Tokens survive server restarts only within the same process. If the user
// needs a fresh token they call GET /game/scan-token again.
const scanTokens = new Map<number, string>();

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

  // 4. Auto-submit to game session
  const session = getOrCreateSession(userId);
  const snap = session.handleInput(outcome);
  req.log.info({ userId, outcome }, "auto-scan submitted outcome");

  res.json({ detected: outcome, submitted: true, handCount: snap.road?.length ?? 0 });
});

// ── Server-side colour detection (mirrors client-side logic) ─────────────────
function detectOutcome(image: Jimp): "B" | "P" | "T" | null {
  const { width, height, data } = image.bitmap; // data = raw RGBA Buffer

  // Scan top 55% of image, 5–95% width
  const scanH  = Math.floor(height * 0.55);
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

export default router;

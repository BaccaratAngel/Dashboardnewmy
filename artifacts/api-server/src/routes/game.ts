import { Router } from "express";
import { requireUser } from "../middleware/requireUser.js";
import { getOrCreateSession } from "../lib/engines/session.js";

const router = Router();

// All game routes require auth
router.use(requireUser);

// GET /game/snapshot
router.get("/snapshot", (req, res) => {
  const session = getOrCreateSession(req.user!.id);
  res.json(session.getSnapshot());
});

// POST /game/input — hand recording never waits for Crisis AI
router.post("/input", (req, res) => {
  const { value } = req.body as { value?: string };
  if (!value || !["B", "P", "T"].includes(value.toUpperCase())) {
    res.status(400).json({ error: "value must be B, P, or T" });
    return;
  }
  const session = getOrCreateSession(req.user!.id);
  const snap = session.handleInput(value.toUpperCase());
  res.json(snap);
});

// POST /game/undo
router.post("/undo", (req, res) => {
  const session = getOrCreateSession(req.user!.id);
  const snap = session.undo();
  res.json(snap);
});

// POST /game/reset
router.post("/reset", (req, res) => {
  const session = getOrCreateSession(req.user!.id);
  const snap = session.reset();
  res.json(snap);
});

// POST /game/oracle-mode — toggle adaptive weight system on/off
router.post("/oracle-mode", (req, res) => {
  const { adaptive } = req.body as { adaptive?: boolean };
  if (typeof adaptive !== "boolean") {
    res.status(400).json({ error: "adaptive must be a boolean" });
    return;
  }
  const session = getOrCreateSession(req.user!.id);
  const snap = session.setOracleAdaptiveMode(adaptive);
  res.json(snap);
});

// POST /game/window
router.post("/window", (req, res) => {
  const { window: w } = req.body as { window?: number };
  if (!w || ![8, 12, 16].includes(Number(w))) {
    res.status(400).json({ error: "window must be 8, 12, or 16" });
    return;
  }
  const session = getOrCreateSession(req.user!.id);
  const snap = session.setWindow(Number(w));
  res.json(snap);
});

export default router;

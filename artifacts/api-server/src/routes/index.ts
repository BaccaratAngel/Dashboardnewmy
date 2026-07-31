import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import gameRouter from "./game.js";
import adminRouter from "./admin.js";
import autoScanRouter from "./autoScan.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/game", gameRouter);
router.use("/admin", adminRouter);
router.use("/game", autoScanRouter);

export default router;

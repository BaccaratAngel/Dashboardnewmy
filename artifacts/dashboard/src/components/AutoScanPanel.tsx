import { useState, useEffect, useRef, useCallback } from 'react';

type Outcome = 'P' | 'B' | 'T';

interface AutoScanPanelProps {
  onDetected: (outcome: Outcome) => void;
  isMutating: boolean;
}

// ── Color detection ─────────────────────────────────────────────────────────
// Analyses the top 45% of the captured frame (casino area in split screen)
// focusing on the centre 60% horizontally where the result banner appears.

function detectByColor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): { outcome: Outcome | null; confidence: number } {
  const scanH = Math.floor(height * 0.45);
  const xFrom = Math.floor(width * 0.15);
  const xTo   = Math.floor(width * 0.85);
  const regionW = xTo - xFrom;

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(xFrom, 0, regionW, scanH);
  } catch {
    return { outcome: null, confidence: 0 };
  }

  const d = imageData.data;
  let red = 0, blue = 0, green = 0, total = 0;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // Skip near-black / near-white pixels (UI chrome, not banner content)
    const brightness = (r + g + b) / 3;
    if (brightness < 20 || brightness > 235) continue;

    // Banker banner: vivid red / crimson / dark red
    if (r > 140 && r > g * 1.8 && r > b * 1.8) red++;
    // Player banner: vivid blue / navy
    else if (b > 130 && b > r * 1.6 && b > g * 1.2) blue++;
    // Player banner: cyan / teal (some providers)
    else if (g > 140 && b > 140 && r < 90) blue++;
    // Tie banner: green
    else if (g > 130 && g > r * 1.6 && g > b * 1.4) green++;

    total++;
  }

  if (total === 0) return { outcome: null, confidence: 0 };

  const rPct = red   / total;
  const bPct = blue  / total;
  const gPct = green / total;
  const THRESHOLD = 0.06; // 6% of sampled pixels must match

  if (rPct > THRESHOLD && rPct > bPct * 1.4 && rPct > gPct * 1.4)
    return { outcome: 'B', confidence: rPct };
  if (bPct > THRESHOLD && bPct > rPct * 1.4 && bPct > gPct * 1.4)
    return { outcome: 'P', confidence: bPct };
  if (gPct > THRESHOLD && gPct > rPct * 1.4 && gPct > bPct * 1.4)
    return { outcome: 'T', confidence: gPct };

  return { outcome: null, confidence: 0 };
}

// ── Tesseract fallback ───────────────────────────────────────────────────────
// Lazy-loaded only the first time it's needed, then reused.

let tesseractWorker: { recognize: (img: string) => Promise<{ data: { text: string } }> } | null = null;
let tesseractLoading = false;
let tesseractReady = false;

async function getTesseractWorker() {
  if (tesseractReady && tesseractWorker) return tesseractWorker;
  if (tesseractLoading) {
    // Wait for it to finish
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (tesseractReady || !tesseractLoading) { clearInterval(check); resolve(); }
      }, 200);
    });
    return tesseractWorker;
  }
  tesseractLoading = true;
  try {
    const { createWorker } = await import('tesseract.js');
    const w = await createWorker('eng', 1, {
      logger: () => {}, // suppress logs
    });
    tesseractWorker = w as typeof tesseractWorker;
    tesseractReady = true;
  } catch {
    tesseractReady = false;
  } finally {
    tesseractLoading = false;
  }
  return tesseractWorker;
}

async function detectByOCR(canvas: HTMLCanvasElement, width: number, height: number): Promise<Outcome | null> {
  // Crop to just the top 40% for speed
  const cropH = Math.floor(height * 0.40);
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width  = width;
  cropCanvas.height = cropH;
  const cropCtx = cropCanvas.getContext('2d');
  if (!cropCtx) return null;
  cropCtx.drawImage(canvas, 0, 0, width, cropH, 0, 0, width, cropH);

  try {
    const worker = await getTesseractWorker();
    if (!worker) return null;
    const result = await worker.recognize(cropCanvas.toDataURL('image/jpeg', 0.7));
    const text = result.data.text.toUpperCase();
    if (text.includes('BANKER')) return 'B';
    if (text.includes('PLAYER')) return 'P';
    if (text.includes('TIE'))    return 'T';
  } catch {
    // silently fail — colour detection is primary
  }
  return null;
}

// ── Component ────────────────────────────────────────────────────────────────

type ScanState = 'idle' | 'requesting' | 'scanning' | 'preview' | 'cooldown';

export function AutoScanPanel({ onDetected, isMutating }: AutoScanPanelProps) {
  const [scanState, setScanState]           = useState<ScanState>('idle');
  const [frameCount, setFrameCount]         = useState(0);
  const [pendingOutcome, setPendingOutcome] = useState<Outcome | null>(null);
  const [countdown, setCountdown]           = useState(0); // 0-100 (progress bar)
  const [detectionMethod, setDetectionMethod] = useState<'color' | 'ocr' | ''>('');
  const [errorMsg, setErrorMsg]             = useState('');
  const [cooldownLeft, setCooldownLeft]     = useState(0);

  const streamRef         = useRef<MediaStream | null>(null);
  const videoRef          = useRef<HTMLVideoElement | null>(null);
  const canvasRef         = useRef<HTMLCanvasElement | null>(null);
  const scanTimerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cooldownTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastOutcomeRef    = useRef<{ outcome: Outcome; time: number } | null>(null);
  const pendingRef        = useRef<Outcome | null>(null);
  const scanStateRef      = useRef<ScanState>('idle');

  // Keep ref in sync so interval callbacks read latest state
  useEffect(() => { scanStateRef.current = scanState; }, [scanState]);

  const stopScan = useCallback(() => {
    if (scanTimerRef.current)      { clearInterval(scanTimerRef.current);      scanTimerRef.current = null; }
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    if (cooldownTimerRef.current)  { clearInterval(cooldownTimerRef.current);  cooldownTimerRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setScanState('idle');
    setPendingOutcome(null);
    pendingRef.current = null;
    setFrameCount(0);
    setCooldownLeft(0);
    setCountdown(0);
    setErrorMsg('');
  }, []);

  // Cancel the pending preview — go back to scanning
  const cancelPreview = useCallback(() => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    setPendingOutcome(null);
    pendingRef.current = null;
    setCountdown(0);
    setScanState('scanning');
  }, []);

  // Commit the detected outcome and start cooldown
  const commitOutcome = useCallback((outcome: Outcome) => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    lastOutcomeRef.current = { outcome, time: Date.now() };
    pendingRef.current = null;
    setPendingOutcome(null);
    setCountdown(0);
    onDetected(outcome);

    // 3-second cooldown before scanning again
    setScanState('cooldown');
    let left = 3;
    setCooldownLeft(left);
    cooldownTimerRef.current = setInterval(() => {
      left--;
      setCooldownLeft(left);
      if (left <= 0) {
        if (cooldownTimerRef.current) { clearInterval(cooldownTimerRef.current); cooldownTimerRef.current = null; }
        if (scanStateRef.current === 'cooldown') setScanState('scanning');
      }
    }, 1000);
  }, [onDetected]);

  // Start 1-second preview countdown
  const startPreview = useCallback((outcome: Outcome, method: 'color' | 'ocr') => {
    if (pendingRef.current) return; // already in preview
    pendingRef.current = outcome;
    setPendingOutcome(outcome);
    setDetectionMethod(method);
    setScanState('preview');
    setCountdown(0);

    const DURATION = 1000; // ms
    const TICK = 40;       // ms
    let elapsed = 0;

    countdownTimerRef.current = setInterval(() => {
      elapsed += TICK;
      setCountdown(Math.min((elapsed / DURATION) * 100, 100));
      if (elapsed >= DURATION) {
        if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
        // Auto-commit — but only if not mutating
        commitOutcome(outcome);
      }
    }, TICK);
  }, [commitOutcome]);

  // Core scan tick
  const doScan = useCallback(async () => {
    const state = scanStateRef.current;
    if (state !== 'scanning') return; // skip during preview / cooldown
    if (isMutating) return; // tracker is processing — wait

    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    const W = video.videoWidth;
    const H = video.videoHeight;
    if (!W || !H) return;

    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, W, H);
    setFrameCount(c => c + 1);

    // ── Primary: colour detection ────────────────────────────────────────
    const colorResult = detectByColor(ctx, W, H);

    if (colorResult.outcome && colorResult.confidence > 0.09) {
      // Dedup: ignore same outcome within 5 seconds
      const last = lastOutcomeRef.current;
      if (last && last.outcome === colorResult.outcome && Date.now() - last.time < 5000) return;
      startPreview(colorResult.outcome, 'color');
      return;
    }

    // ── Fallback: Tesseract OCR (only when colour is ambiguous) ─────────
    // Run OCR every 5th frame to avoid overload on budget phone
    setFrameCount(c => {
      if (c % 5 !== 0) return c;
      detectByOCR(canvas, W, H).then(ocr => {
        if (!ocr) return;
        if (scanStateRef.current !== 'scanning') return;
        const last = lastOutcomeRef.current;
        if (last && last.outcome === ocr && Date.now() - last.time < 5000) return;
        startPreview(ocr, 'ocr');
      });
      return c;
    });
  }, [isMutating, startPreview]);

  const startScan = useCallback(async () => {
    setErrorMsg('');
    setScanState('requesting');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('denied') || msg.toLowerCase().includes('permission')) {
        setErrorMsg('Screen share permission denied. Tap Start Scan and allow when Android asks.');
      } else if (msg.toLowerCase().includes('cancel') || msg.toLowerCase().includes('abort')) {
        setErrorMsg('Cancelled. Tap Start Scan to try again.');
      } else {
        setErrorMsg('Could not start screen capture. Try again.');
      }
      setScanState('idle');
      return;
    }

    streamRef.current = stream;

    // Create hidden video element to receive the stream
    if (!videoRef.current) {
      videoRef.current = document.createElement('video');
      videoRef.current.muted    = true;
      videoRef.current.autoplay = true;
      videoRef.current.playsInline = true;
      videoRef.current.style.display = 'none';
      document.body.appendChild(videoRef.current);
    }
    videoRef.current.srcObject = stream;
    await videoRef.current.play().catch(() => {});

    // Create offscreen canvas
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }

    // Handle user stopping screen share from OS UI
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      stopScan();
    });

    setScanState('scanning');
    setFrameCount(0);
    scanTimerRef.current = setInterval(doScan, 1500);

    // Pre-load Tesseract in background so it's ready when needed
    getTesseractWorker().catch(() => {});
  }, [doScan, stopScan]);

  // Cleanup on unmount
  useEffect(() => () => stopScan(), [stopScan]);

  // ── UI helpers ────────────────────────────────────────────────────────────

  const outcomeLabel = (o: Outcome | null) =>
    o === 'B' ? 'BANKER' : o === 'P' ? 'PLAYER' : o === 'T' ? 'TIE' : '';

  const outcomeColor = (o: Outcome | null) =>
    o === 'B' ? '#f87171' : o === 'P' ? '#22d3ee' : o === 'T' ? '#4ade80' : '#71717a';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="rounded-sm border flex flex-col overflow-hidden"
      style={{ backgroundColor: '#0a0a12', borderColor: scanState === 'scanning' || scanState === 'preview' || scanState === 'cooldown' ? 'rgba(34,211,238,0.35)' : 'rgba(255,255,255,0.1)' }}>

      {/* Header */}
      <div className="px-4 py-2.5 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', backgroundColor: 'rgba(34,211,238,0.03)' }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold tracking-widest" style={{ color: '#22d3ee' }}>
            📡 AUTO SCAN
          </span>
          <span className="text-xs px-1.5 py-0 rounded-sm"
            style={{ color: '#52525b', backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontSize: 9 }}>
            COLOR + OCR
          </span>
        </div>

        {/* Status badge */}
        {scanState === 'scanning' && (
          <span className="text-xs font-bold px-2 py-0.5 rounded-sm"
            style={{ color: '#4ade80', backgroundColor: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.3)', animation: 'pulse 2s infinite' }}>
            🟢 LIVE · {frameCount}f
          </span>
        )}
        {scanState === 'requesting' && (
          <span className="text-xs" style={{ color: '#eab308' }}>Allow screen share…</span>
        )}
        {scanState === 'cooldown' && (
          <span className="text-xs font-bold px-2 py-0.5 rounded-sm"
            style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.1)', border: '1px solid rgba(251,146,60,0.3)' }}>
            ⏳ COOLDOWN {cooldownLeft}s
          </span>
        )}
        {scanState === 'preview' && pendingOutcome && (
          <span className="text-xs font-bold px-2 py-0.5 rounded-sm"
            style={{ color: outcomeColor(pendingOutcome), backgroundColor: `${outcomeColor(pendingOutcome)}14`, border: `1px solid ${outcomeColor(pendingOutcome)}40` }}>
            {detectionMethod === 'color' ? '🎨' : '🔤'} {detectionMethod.toUpperCase()}
          </span>
        )}
        {scanState === 'idle' && frameCount > 0 && (
          <span className="text-xs" style={{ color: '#3f3f46' }}>Stopped · {frameCount}f</span>
        )}
      </div>

      {/* Preview overlay — 1-second countdown */}
      {scanState === 'preview' && pendingOutcome && (
        <div className="flex flex-col items-center gap-3 px-4 py-4"
          style={{ backgroundColor: `${outcomeColor(pendingOutcome)}08` }}>
          <div className="text-xs tracking-widest" style={{ color: '#71717a' }}>DETECTED</div>
          <div className="text-4xl font-black tracking-wider"
            style={{ color: outcomeColor(pendingOutcome), textShadow: `0 0 20px ${outcomeColor(pendingOutcome)}60` }}>
            {outcomeLabel(pendingOutcome)}
          </div>

          {/* Countdown bar */}
          <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
            <div className="h-full rounded-full transition-none"
              style={{ width: `${countdown}%`, backgroundColor: outcomeColor(pendingOutcome), boxShadow: `0 0 6px ${outcomeColor(pendingOutcome)}80` }} />
          </div>

          <div className="flex w-full gap-3">
            {/* Cancel */}
            <button onClick={cancelPreview}
              className="flex-1 py-2.5 text-sm font-bold rounded-sm tracking-wider transition-all active:scale-95"
              style={{ border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.6)', backgroundColor: 'rgba(255,255,255,0.04)', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
              ✕ CANCEL
            </button>
            {/* Submit now */}
            <button onClick={() => commitOutcome(pendingOutcome)}
              className="flex-1 py-2.5 text-sm font-bold rounded-sm tracking-wider transition-all active:scale-95"
              style={{ border: `2px solid ${outcomeColor(pendingOutcome)}`, color: outcomeColor(pendingOutcome), backgroundColor: `${outcomeColor(pendingOutcome)}12`, fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
              ✓ SUBMIT NOW
            </button>
          </div>
        </div>
      )}

      {/* Idle / controls */}
      {(scanState === 'idle' || scanState === 'requesting') && (
        <div className="px-4 py-3 flex flex-col gap-2">
          {errorMsg && (
            <div className="text-xs px-3 py-2 rounded-sm"
              style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.2)' }}>
              {errorMsg}
            </div>
          )}
          <div className="text-xs mb-1" style={{ color: '#52525b' }}>
            Tap Start → allow screen share → scanner watches your casino screen automatically
          </div>
          <button onClick={startScan} disabled={scanState === 'requesting'}
            className="w-full py-3 text-sm font-black rounded-sm tracking-wider transition-all active:scale-95"
            style={{
              border: '2px solid rgba(34,211,238,0.5)',
              color: scanState === 'requesting' ? '#52525b' : '#22d3ee',
              backgroundColor: scanState === 'requesting' ? 'rgba(255,255,255,0.02)' : 'rgba(34,211,238,0.08)',
              fontFamily: "'JetBrains Mono', monospace",
              cursor: scanState === 'requesting' ? 'not-allowed' : 'pointer',
              boxShadow: scanState === 'requesting' ? 'none' : '0 0 16px rgba(34,211,238,0.15)',
            }}>
            {scanState === 'requesting' ? '⏳ WAITING FOR PERMISSION…' : '📡 START SCAN'}
          </button>
        </div>
      )}

      {/* Scanning — show stop button */}
      {(scanState === 'scanning' || scanState === 'cooldown') && (
        <div className="px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs" style={{ color: '#52525b' }}>
              {scanState === 'cooldown'
                ? 'Submitted — waiting before next scan…'
                : 'Watching screen · auto-submits on detection'}
            </span>
            <span className="text-xs" style={{ color: '#3f3f46', fontFamily: 'monospace' }}>
              Frames: {frameCount} · Cooldown: 3s · Preview: 1s
            </span>
          </div>
          <button onClick={stopScan}
            className="px-4 py-2 text-xs font-bold rounded-sm tracking-wider transition-all active:scale-95"
            style={{ border: '1px solid rgba(248,113,113,0.35)', color: 'rgba(248,113,113,0.7)', backgroundColor: 'rgba(248,113,113,0.05)', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
            ■ STOP
          </button>
        </div>
      )}
    </div>
  );
}

import { useState, useRef, useCallback, useEffect } from 'react';

type Outcome = 'P' | 'B' | 'T';
type Mode = 'screenshot' | 'live';

interface AutoScanPanelProps {
  onDetected: (outcome: Outcome) => void;
  isMutating: boolean;
}

// ── Color detection ──────────────────────────────────────────────────────────
// Works on any canvas region. For screenshots from split-screen, the casino
// result banner is in the top 45%; for live capture it's also in the top half.

function detectByColor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  topFraction = 0.45,
): { outcome: Outcome | null; confidence: number } {
  const scanH  = Math.floor(height * topFraction);
  const xFrom  = Math.floor(width * 0.10);
  const xTo    = Math.floor(width * 0.90);
  const regionW = xTo - xFrom;

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(xFrom, 0, regionW, scanH);
  } catch {
    return { outcome: null, confidence: 0 };
  }

  const d = imageData.data;
  let red = 0, blue = 0, green = 0, sampled = 0;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const brightness = (r + g + b) / 3;
    if (brightness < 25 || brightness > 230) continue; // skip near-black / near-white

    // Banker: vivid red / crimson / maroon
    if (r > 130 && r > g * 1.7 && r > b * 1.7) red++;
    // Player: deep blue / navy
    else if (b > 120 && b > r * 1.5 && b > g * 1.1) blue++;
    // Player alt: cyan / teal (some casino skins)
    else if (g > 130 && b > 130 && r < 100) blue++;
    // Tie: green
    else if (g > 120 && g > r * 1.6 && g > b * 1.3) green++;

    sampled++;
  }

  if (sampled < 200) return { outcome: null, confidence: 0 };

  const rPct = red   / sampled;
  const bPct = blue  / sampled;
  const gPct = green / sampled;
  const THRESHOLD = 0.055;

  if (rPct > THRESHOLD && rPct > bPct * 1.3 && rPct > gPct * 1.3)
    return { outcome: 'B', confidence: rPct };
  if (bPct > THRESHOLD && bPct > rPct * 1.3 && bPct > gPct * 1.3)
    return { outcome: 'P', confidence: bPct };
  if (gPct > THRESHOLD && gPct > rPct * 1.3 && gPct > bPct * 1.3)
    return { outcome: 'T', confidence: gPct };

  return { outcome: null, confidence: 0 };
}

// ── Tesseract OCR (lazy-loaded) ───────────────────────────────────────────────
let tesseractWorker: { recognize: (img: string) => Promise<{ data: { text: string } }> } | null = null;
let tesseractState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';

async function getTesseractWorker() {
  if (tesseractState === 'ready' && tesseractWorker) return tesseractWorker;
  if (tesseractState === 'loading') {
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (tesseractState !== 'loading') { clearInterval(t); resolve(); }
      }, 300);
    });
    return tesseractWorker;
  }
  if (tesseractState === 'failed') return null;
  tesseractState = 'loading';
  try {
    const { createWorker } = await import('tesseract.js');
    const w = await createWorker('eng', 1, { logger: () => {} });
    tesseractWorker = w as typeof tesseractWorker;
    tesseractState = 'ready';
  } catch {
    tesseractState = 'failed';
  }
  return tesseractWorker;
}

async function detectByOCR(canvas: HTMLCanvasElement, width: number, height: number): Promise<Outcome | null> {
  const cropH = Math.floor(height * 0.45);
  const tmp = document.createElement('canvas');
  tmp.width = width; tmp.height = cropH;
  tmp.getContext('2d')?.drawImage(canvas, 0, 0, width, cropH, 0, 0, width, cropH);
  try {
    const worker = await getTesseractWorker();
    if (!worker) return null;
    const result = await worker.recognize(tmp.toDataURL('image/jpeg', 0.75));
    const text = result.data.text.toUpperCase();
    if (text.includes('BANKER')) return 'B';
    if (text.includes('PLAYER')) return 'P';
    if (text.includes('TIE'))    return 'T';
  } catch { /* silent */ }
  return null;
}

// ── Analyse a canvas and return outcome ──────────────────────────────────────
async function analyseCanvas(
  canvas: HTMLCanvasElement,
  topFraction = 0.45,
): Promise<{ outcome: Outcome | null; method: 'color' | 'ocr' | null }> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { outcome: null, method: null };

  const color = detectByColor(ctx, canvas.width, canvas.height, topFraction);
  if (color.outcome && color.confidence > 0.07) {
    return { outcome: color.outcome, method: 'color' };
  }

  const ocr = await detectByOCR(canvas, canvas.width, canvas.height);
  if (ocr) return { outcome: ocr, method: 'ocr' };

  return { outcome: null, method: null };
}

// ── Component ────────────────────────────────────────────────────────────────

type PanelState = 'idle' | 'processing' | 'preview' | 'cooldown' | 'live-requesting' | 'live-scanning' | 'live-cooldown';

const OUTCOME_LABEL: Record<Outcome, string> = { P: 'PLAYER', B: 'BANKER', T: 'TIE' };
const OUTCOME_COLOR: Record<Outcome, string> = { P: '#22d3ee', B: '#f87171', T: '#4ade80' };

export function AutoScanPanel({ onDetected, isMutating }: AutoScanPanelProps) {
  const [mode, setMode]                     = useState<Mode>('screenshot');
  const [panelState, setPanelState]         = useState<PanelState>('idle');
  const [pendingOutcome, setPendingOutcome] = useState<Outcome | null>(null);
  const [detMethod, setDetMethod]           = useState<'color' | 'ocr' | null>(null);
  const [countdown, setCountdown]           = useState(0);
  const [cooldownLeft, setCooldownLeft]     = useState(0);
  const [frameCount, setFrameCount]         = useState(0);
  const [errorMsg, setErrorMsg]             = useState('');
  const [noResultMsg, setNoResultMsg]       = useState('');

  const fileInputRef      = useRef<HTMLInputElement | null>(null);
  const canvasRef         = useRef<HTMLCanvasElement | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cooldownTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanIntervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef         = useRef<MediaStream | null>(null);
  const videoRef          = useRef<HTMLVideoElement | null>(null);
  const lastSubmitRef     = useRef<{ outcome: Outcome; time: number } | null>(null);
  const pendingRef        = useRef<Outcome | null>(null);
  const panelStateRef     = useRef<PanelState>('idle');

  useEffect(() => { panelStateRef.current = panelState; }, [panelState]);

  // ── Commit outcome → onDetected + cooldown ───────────────────────────────
  const commitOutcome = useCallback((outcome: Outcome) => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    lastSubmitRef.current = { outcome, time: Date.now() };
    pendingRef.current = null;
    setPendingOutcome(null);
    setCountdown(0);
    onDetected(outcome);

    const isLive = panelStateRef.current === 'preview' && mode === 'live';
    setPanelState(isLive ? 'live-cooldown' : 'cooldown');
    let left = 3;
    setCooldownLeft(left);
    cooldownTimerRef.current = setInterval(() => {
      left--;
      setCooldownLeft(left);
      if (left <= 0) {
        if (cooldownTimerRef.current) { clearInterval(cooldownTimerRef.current); cooldownTimerRef.current = null; }
        setPanelState(p => p === 'live-cooldown' ? 'live-scanning' : 'idle');
      }
    }, 1000);
  }, [onDetected, mode]);

  // ── Cancel preview → go back ─────────────────────────────────────────────
  const cancelPreview = useCallback(() => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    pendingRef.current = null;
    setPendingOutcome(null);
    setCountdown(0);
    setPanelState(p => p === 'preview' && mode === 'live' ? 'live-scanning' : 'idle');
  }, [mode]);

  // ── Start 1-second preview countdown ─────────────────────────────────────
  const startPreview = useCallback((outcome: Outcome, method: 'color' | 'ocr') => {
    if (pendingRef.current) return;
    pendingRef.current = outcome;
    setPendingOutcome(outcome);
    setDetMethod(method);
    setPanelState('preview');
    setCountdown(0);
    const DURATION = 1000, TICK = 40;
    let elapsed = 0;
    countdownTimerRef.current = setInterval(() => {
      elapsed += TICK;
      setCountdown(Math.min((elapsed / DURATION) * 100, 100));
      if (elapsed >= DURATION) {
        if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
        commitOutcome(outcome);
      }
    }, TICK);
  }, [commitOutcome]);

  // ── Stop live scan ───────────────────────────────────────────────────────
  const stopLive = useCallback(() => {
    if (scanIntervalRef.current)    { clearInterval(scanIntervalRef.current);    scanIntervalRef.current = null; }
    if (countdownTimerRef.current)  { clearInterval(countdownTimerRef.current);  countdownTimerRef.current = null; }
    if (cooldownTimerRef.current)   { clearInterval(cooldownTimerRef.current);   cooldownTimerRef.current = null; }
    if (streamRef.current)          { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (videoRef.current)           { videoRef.current.srcObject = null; }
    setPanelState('idle');
    setPendingOutcome(null);
    pendingRef.current = null;
    setFrameCount(0);
    setCooldownLeft(0);
  }, []);

  useEffect(() => () => { stopLive(); }, [stopLive]);

  // ── Screenshot mode: file picked ─────────────────────────────────────────
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = ''; // reset so same file can be picked again
    if (!file) return;

    setErrorMsg('');
    setNoResultMsg('');
    setPanelState('processing');

    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = async () => {
      URL.revokeObjectURL(url);
      const canvas = canvasRef.current ?? document.createElement('canvas');
      canvasRef.current = canvas;
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) { setPanelState('idle'); return; }
      ctx.drawImage(img, 0, 0);

      const { outcome, method } = await analyseCanvas(canvas, 0.45);
      if (outcome && method) {
        startPreview(outcome, method);
      } else {
        setNoResultMsg('No result detected. Try a clearer screenshot where BANKER/PLAYER text is visible.');
        setPanelState('idle');
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setErrorMsg('Could not read image. Try again.');
      setPanelState('idle');
    };
    img.src = url;
  }, [startPreview]);

  // ── Live scan: doScan tick ────────────────────────────────────────────────
  const doScan = useCallback(async () => {
    if (panelStateRef.current !== 'live-scanning') return;
    if (isMutating) return;
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const W = video.videoWidth, H = video.videoHeight;
    if (!W || !H) return;

    const canvas = canvasRef.current ?? document.createElement('canvas');
    canvasRef.current = canvas;
    canvas.width = W; canvas.height = H;
    canvas.getContext('2d')?.drawImage(video, 0, 0, W, H);
    setFrameCount(c => c + 1);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const color = detectByColor(ctx, W, H, 0.45);
    if (color.outcome && color.confidence > 0.09) {
      const last = lastSubmitRef.current;
      if (last && last.outcome === color.outcome && Date.now() - last.time < 5000) return;
      startPreview(color.outcome, 'color');
    }
  }, [isMutating, startPreview]);

  // ── Live scan: start ──────────────────────────────────────────────────────
  const startLive = useCallback(async () => {
    setErrorMsg('');
    setPanelState('live-requesting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5 } }, audio: false });
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (msg.includes('denied') || msg.includes('permission')) {
        setErrorMsg('Permission denied. Allow screen sharing when Android asks.');
      } else if (msg.includes('cancel') || msg.includes('abort') || msg.includes('user')) {
        setErrorMsg('Cancelled. Tap Live Scan to try again.');
      } else if (msg.includes('support') || msg.includes('implement')) {
        setErrorMsg('Screen capture not supported on this browser/device. Use Screenshot mode instead.');
      } else {
        setErrorMsg(`Screen capture failed: ${err instanceof Error ? err.message : 'unknown error'}. Use Screenshot mode instead.`);
      }
      setPanelState('idle');
      return;
    }
    streamRef.current = stream;
    if (!videoRef.current) {
      const v = document.createElement('video');
      v.muted = true; v.autoplay = true; v.playsInline = true;
      v.style.display = 'none';
      document.body.appendChild(v);
      videoRef.current = v;
    }
    videoRef.current.srcObject = stream;
    await videoRef.current.play().catch(() => {});
    stream.getVideoTracks()[0]?.addEventListener('ended', stopLive);
    setPanelState('live-scanning');
    setFrameCount(0);
    scanIntervalRef.current = setInterval(doScan, 1500);
    getTesseractWorker().catch(() => {}); // warm up
  }, [doScan, stopLive]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const isLive = mode === 'live';
  const isScanning = panelState === 'live-scanning' || panelState === 'live-cooldown';
  const isPreview = panelState === 'preview';
  const isProcessing = panelState === 'processing';

  const outcomeColor = (o: Outcome) => OUTCOME_COLOR[o];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="rounded-sm border flex flex-col overflow-hidden"
      style={{
        backgroundColor: '#09090f',
        borderColor: isScanning || isPreview
          ? 'rgba(34,211,238,0.4)'
          : isProcessing
          ? 'rgba(250,204,21,0.3)'
          : 'rgba(255,255,255,0.1)',
        transition: 'border-color 0.3s',
      }}>

      {/* ── Header ── */}
      <div className="px-4 py-2.5 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', backgroundColor: 'rgba(34,211,238,0.025)' }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold tracking-widest" style={{ color: '#22d3ee' }}>📡 AUTO SCAN</span>
          <span className="text-xs px-1.5 rounded-sm"
            style={{ color: '#52525b', backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontSize: 9 }}>
            COLOR + OCR
          </span>
        </div>

        {/* Mode toggle */}
        <div className="flex rounded-sm overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
          {(['screenshot', 'live'] as Mode[]).map((m) => (
            <button key={m} onClick={() => { setMode(m); setErrorMsg(''); setNoResultMsg(''); }}
              disabled={isScanning || isPreview || isProcessing}
              className="px-2.5 py-1 text-xs font-bold tracking-wider transition-all"
              style={{
                color: mode === m ? '#22d3ee' : '#52525b',
                backgroundColor: mode === m ? 'rgba(34,211,238,0.1)' : 'transparent',
                fontFamily: "'JetBrains Mono', monospace",
                cursor: isScanning || isPreview || isProcessing ? 'not-allowed' : 'pointer',
                fontSize: 9,
              }}>
              {m === 'screenshot' ? '📸 SCREENSHOT' : '🔴 LIVE'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Preview overlay ── */}
      {isPreview && pendingOutcome && (
        <div className="flex flex-col items-center gap-3 px-4 py-4"
          style={{ backgroundColor: `${outcomeColor(pendingOutcome)}08` }}>
          <div className="text-xs tracking-widest" style={{ color: '#71717a' }}>
            DETECTED {detMethod === 'color' ? '🎨 COLOR' : '🔤 OCR'}
          </div>
          <div className="text-4xl font-black tracking-wider"
            style={{ color: outcomeColor(pendingOutcome), textShadow: `0 0 20px ${outcomeColor(pendingOutcome)}60` }}>
            {OUTCOME_LABEL[pendingOutcome]}
          </div>

          {/* Countdown bar */}
          <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}>
            <div className="h-full rounded-full"
              style={{ width: `${countdown}%`, backgroundColor: outcomeColor(pendingOutcome), boxShadow: `0 0 6px ${outcomeColor(pendingOutcome)}80`, transition: 'none' }} />
          </div>
          <div className="text-xs" style={{ color: '#52525b' }}>Auto-submitting in 1 second…</div>

          <div className="flex w-full gap-3">
            <button onClick={cancelPreview}
              className="flex-1 py-2.5 text-sm font-bold rounded-sm tracking-wider transition-all active:scale-95"
              style={{ border: '1px solid rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.55)', backgroundColor: 'rgba(255,255,255,0.04)', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
              ✕ CANCEL
            </button>
            <button onClick={() => commitOutcome(pendingOutcome)}
              className="flex-1 py-2.5 text-sm font-bold rounded-sm tracking-wider transition-all active:scale-95"
              style={{ border: `2px solid ${outcomeColor(pendingOutcome)}`, color: outcomeColor(pendingOutcome), backgroundColor: `${outcomeColor(pendingOutcome)}12`, fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
              ✓ SUBMIT NOW
            </button>
          </div>
        </div>
      )}

      {/* ── Screenshot mode body ── */}
      {!isLive && !isPreview && (
        <div className="px-4 py-3 flex flex-col gap-2.5">

          {/* How-to */}
          <div className="flex flex-col gap-1 px-3 py-2.5 rounded-sm"
            style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <span className="text-xs font-bold tracking-wider" style={{ color: '#71717a' }}>HOW TO USE</span>
            <div className="flex flex-col gap-0.5 mt-0.5">
              {[
                '1. Wait for BANKER / PLAYER result to appear',
                '2. Take screenshot  (Vol Down + Power)',
                '3. Tap SCAN SCREENSHOT button below',
                '4. Select the screenshot from gallery',
              ].map((s, i) => (
                <span key={i} className="text-xs" style={{ color: '#52525b', fontFamily: "'JetBrains Mono', monospace" }}>{s}</span>
              ))}
            </div>
          </div>

          {/* Error / no-result messages */}
          {errorMsg && (
            <div className="text-xs px-3 py-2 rounded-sm"
              style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.2)' }}>
              {errorMsg}
            </div>
          )}
          {noResultMsg && !errorMsg && (
            <div className="text-xs px-3 py-2 rounded-sm"
              style={{ color: '#eab308', backgroundColor: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.2)' }}>
              {noResultMsg}
            </div>
          )}

          {/* Cooldown */}
          {panelState === 'cooldown' && (
            <div className="text-xs text-center py-1.5 rounded-sm font-bold"
              style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.07)', border: '1px solid rgba(251,146,60,0.2)' }}>
              ⏳ Ready again in {cooldownLeft}s…
            </div>
          )}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />

          {/* Main button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing || isMutating || panelState === 'cooldown'}
            className="w-full py-4 font-black text-base rounded-sm tracking-wider transition-all active:scale-95"
            style={{
              border: '2px solid rgba(34,211,238,0.5)',
              color: isProcessing || isMutating || panelState === 'cooldown' ? '#3f3f46' : '#22d3ee',
              backgroundColor: isProcessing || isMutating || panelState === 'cooldown' ? 'rgba(255,255,255,0.02)' : 'rgba(34,211,238,0.08)',
              fontFamily: "'JetBrains Mono', monospace",
              cursor: isProcessing || isMutating || panelState === 'cooldown' ? 'not-allowed' : 'pointer',
              boxShadow: isProcessing || isMutating || panelState === 'cooldown' ? 'none' : '0 0 16px rgba(34,211,238,0.12)',
            }}>
            {isProcessing ? '⏳ ANALYSING…' : '📸 SCAN SCREENSHOT'}
          </button>
        </div>
      )}

      {/* ── Live mode body ── */}
      {isLive && !isPreview && (
        <div className="px-4 py-3 flex flex-col gap-2.5">
          {errorMsg && (
            <div className="text-xs px-3 py-2 rounded-sm"
              style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.2)' }}>
              {errorMsg}
            </div>
          )}

          {(panelState === 'idle' || panelState === 'live-requesting') && (
            <>
              <div className="text-xs px-3 py-2 rounded-sm"
                style={{ color: '#71717a', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                Tap Start → allow screen share → scanner watches automatically.
                May not work on all Android devices — use Screenshot mode if it fails.
              </div>
              <button onClick={startLive} disabled={panelState === 'live-requesting'}
                className="w-full py-4 font-black text-base rounded-sm tracking-wider transition-all active:scale-95"
                style={{
                  border: '2px solid rgba(34,211,238,0.5)',
                  color: panelState === 'live-requesting' ? '#3f3f46' : '#22d3ee',
                  backgroundColor: panelState === 'live-requesting' ? 'rgba(255,255,255,0.02)' : 'rgba(34,211,238,0.08)',
                  fontFamily: "'JetBrains Mono', monospace",
                  cursor: panelState === 'live-requesting' ? 'not-allowed' : 'pointer',
                }}>
                {panelState === 'live-requesting' ? '⏳ WAITING FOR PERMISSION…' : '🔴 START LIVE SCAN'}
              </button>
            </>
          )}

          {(isScanning) && (
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-bold" style={{ color: '#4ade80' }}>
                  🟢 LIVE SCANNING · {frameCount} frames
                </span>
                <span className="text-xs" style={{ color: '#3f3f46', fontFamily: 'monospace' }}>
                  {panelState === 'live-cooldown' ? `Cooldown ${cooldownLeft}s` : 'Watching for result…'}
                </span>
              </div>
              <button onClick={stopLive}
                className="px-4 py-2 text-xs font-bold rounded-sm tracking-wider transition-all active:scale-95"
                style={{ border: '1px solid rgba(248,113,113,0.35)', color: 'rgba(248,113,113,0.7)', backgroundColor: 'rgba(248,113,113,0.05)', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
                ■ STOP
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useState, useRef, useCallback, useEffect } from 'react';

type Outcome = 'P' | 'B' | 'T';

interface AutoScanPanelProps {
  onDetected: (outcome: Outcome) => void;
  isMutating: boolean;
}

// ── Color detection ──────────────────────────────────────────────────────────
function detectByColor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  topFraction = 0.55,
): { outcome: Outcome | null; confidence: number } {
  const scanH   = Math.floor(height * topFraction);
  const xFrom   = Math.floor(width * 0.05);
  const xTo     = Math.floor(width * 0.95);
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
    if (brightness < 20 || brightness > 235) continue;

    // Banker: vivid red / crimson / maroon
    if (r > 120 && r > g * 1.6 && r > b * 1.6) red++;
    // Player: deep blue / navy / royal blue
    else if (b > 100 && b > r * 1.4 && b > g * 1.1) blue++;
    // Player alt: cyan / teal
    else if (g > 120 && b > 120 && r < 110 && b > g * 0.85) blue++;
    // Tie: green
    else if (g > 110 && g > r * 1.5 && g > b * 1.3) green++;

    sampled++;
  }

  if (sampled < 150) return { outcome: null, confidence: 0 };

  const rPct = red   / sampled;
  const bPct = blue  / sampled;
  const gPct = green / sampled;
  const THRESHOLD = 0.045;

  if (rPct > THRESHOLD && rPct > bPct * 1.2 && rPct > gPct * 1.2)
    return { outcome: 'B', confidence: rPct };
  if (bPct > THRESHOLD && bPct > rPct * 1.2 && bPct > gPct * 1.2)
    return { outcome: 'P', confidence: bPct };
  if (gPct > THRESHOLD && gPct > rPct * 1.2 && gPct > bPct * 1.2)
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

async function detectByOCR(canvas: HTMLCanvasElement): Promise<Outcome | null> {
  const cropH = Math.floor(canvas.height * 0.55);
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width; tmp.height = cropH;
  tmp.getContext('2d')?.drawImage(canvas, 0, 0, canvas.width, cropH, 0, 0, canvas.width, cropH);
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
): Promise<{ outcome: Outcome | null; method: 'color' | 'ocr' | null }> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { outcome: null, method: null };

  const color = detectByColor(ctx, canvas.width, canvas.height, 0.55);
  if (color.outcome && color.confidence > 0.06) {
    return { outcome: color.outcome, method: 'color' };
  }

  const ocr = await detectByOCR(canvas);
  if (ocr) return { outcome: ocr, method: 'ocr' };

  return { outcome: null, method: null };
}

// ── Draw blob/file to a canvas ───────────────────────────────────────────────
async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ── Component ────────────────────────────────────────────────────────────────

type PanelState = 'idle' | 'processing' | 'preview' | 'cooldown';

const OUTCOME_LABEL: Record<Outcome, string> = { P: 'PLAYER', B: 'BANKER', T: 'TIE' };
const OUTCOME_COLOR: Record<Outcome, string> = { P: '#22d3ee', B: '#f87171', T: '#4ade80' };

// Check clipboard API availability
function hasClipboardRead() {
  return !!(navigator.clipboard && typeof (navigator.clipboard as { read?: unknown }).read === 'function');
}

export function AutoScanPanel({ onDetected, isMutating }: AutoScanPanelProps) {
  const [panelState, setPanelState]         = useState<PanelState>('idle');
  const [pendingOutcome, setPendingOutcome] = useState<Outcome | null>(null);
  const [detMethod, setDetMethod]           = useState<'color' | 'ocr' | null>(null);
  const [countdown, setCountdown]           = useState(0);
  const [cooldownLeft, setCooldownLeft]     = useState(0);
  const [errorMsg, setErrorMsg]             = useState('');
  const [noResultMsg, setNoResultMsg]       = useState('');
  const [clipboardSupported]                = useState(() => hasClipboardRead());

  const fileInputRef      = useRef<HTMLInputElement | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cooldownTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSubmitRef     = useRef<{ outcome: Outcome; time: number } | null>(null);
  const pendingRef        = useRef<Outcome | null>(null);
  const panelStateRef     = useRef<PanelState>('idle');

  useEffect(() => { panelStateRef.current = panelState; }, [panelState]);

  // ── Cooldown after submit ────────────────────────────────────────────────
  const startCooldown = useCallback(() => {
    setPanelState('cooldown');
    let left = 3;
    setCooldownLeft(left);
    cooldownTimerRef.current = setInterval(() => {
      left--;
      setCooldownLeft(left);
      if (left <= 0) {
        if (cooldownTimerRef.current) { clearInterval(cooldownTimerRef.current); cooldownTimerRef.current = null; }
        setPanelState('idle');
      }
    }, 1000);
  }, []);

  // ── Commit outcome ───────────────────────────────────────────────────────
  const commitOutcome = useCallback((outcome: Outcome) => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    lastSubmitRef.current = { outcome, time: Date.now() };
    pendingRef.current = null;
    setPendingOutcome(null);
    setCountdown(0);
    onDetected(outcome);
    startCooldown();
  }, [onDetected, startCooldown]);

  // ── Cancel preview ───────────────────────────────────────────────────────
  const cancelPreview = useCallback(() => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    pendingRef.current = null;
    setPendingOutcome(null);
    setCountdown(0);
    setPanelState('idle');
  }, []);

  // ── Start 1-second preview countdown ────────────────────────────────────
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

  useEffect(() => () => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    if (cooldownTimerRef.current)  clearInterval(cooldownTimerRef.current);
  }, []);

  // ── Core: analyse a blob and trigger preview ──────────────────────────────
  const processBlob = useCallback(async (blob: Blob, source: string) => {
    setErrorMsg('');
    setNoResultMsg('');
    setPanelState('processing');

    const canvas = await blobToCanvas(blob);
    if (!canvas) {
      setErrorMsg(`Could not read ${source}. Try again.`);
      setPanelState('idle');
      return;
    }

    const { outcome, method } = await analyseCanvas(canvas);
    if (outcome && method) {
      startPreview(outcome, method);
    } else {
      setNoResultMsg('No result detected — make sure BANKER / PLAYER text is clearly visible and try again.');
      setPanelState('idle');
    }
  }, [startPreview]);

  // ── PASTE from clipboard ─────────────────────────────────────────────────
  const handlePaste = useCallback(async () => {
    setErrorMsg('');
    setNoResultMsg('');
    try {
      // @ts-ignore — clipboard.read() not in all TS libs
      const items: ClipboardItem[] = await navigator.clipboard.read();
      let imageBlob: Blob | null = null;
      for (const item of items) {
        const imgType = item.types.find((t: string) => t.startsWith('image/'));
        if (imgType) {
          imageBlob = await item.getType(imgType);
          break;
        }
      }
      if (!imageBlob) {
        setErrorMsg('No image on clipboard. Take a screenshot first, then tap Copy in the Samsung toolbar, then tap PASTE.');
        return;
      }
      await processBlob(imageBlob, 'clipboard image');
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (msg.includes('permission') || msg.includes('denied') || msg.includes('not allowed')) {
        setErrorMsg('Clipboard permission denied. Tap PASTE again and allow access when Chrome asks.');
      } else {
        setErrorMsg('Could not read clipboard. Use the GALLERY button below instead.');
      }
    }
  }, [processBlob]);

  // ── GALLERY file picker ──────────────────────────────────────────────────
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    await processBlob(file, 'image');
  }, [processBlob]);

  // ── State helpers ─────────────────────────────────────────────────────────
  const isPreview    = panelState === 'preview';
  const isProcessing = panelState === 'processing';
  const isCooldown   = panelState === 'cooldown';
  const isDisabled   = isProcessing || isMutating || isCooldown || isPreview;

  const outcomeColor = (o: Outcome) => OUTCOME_COLOR[o];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="rounded-sm border flex flex-col overflow-hidden"
      style={{
        backgroundColor: '#09090f',
        borderColor: isPreview
          ? 'rgba(34,211,238,0.45)'
          : isProcessing
          ? 'rgba(250,204,21,0.3)'
          : 'rgba(255,255,255,0.1)',
        transition: 'border-color 0.3s',
      }}
    >
      {/* ── Header ── */}
      <div
        className="px-4 py-2.5 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', backgroundColor: 'rgba(34,211,238,0.025)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold tracking-widest" style={{ color: '#22d3ee' }}>📡 AUTO SCAN</span>
          <span
            className="text-xs px-1.5 rounded-sm"
            style={{ color: '#52525b', backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontSize: 9 }}
          >
            COLOR + OCR
          </span>
        </div>
        {isCooldown && (
          <span className="text-xs font-bold" style={{ color: '#fb923c', fontFamily: 'monospace' }}>
            ⏳ {cooldownLeft}s
          </span>
        )}
        {isProcessing && (
          <span className="text-xs font-bold" style={{ color: '#facc15', fontFamily: 'monospace' }}>
            ANALYSING…
          </span>
        )}
      </div>

      {/* ── Preview overlay ── */}
      {isPreview && pendingOutcome && (
        <div
          className="flex flex-col items-center gap-3 px-4 py-4"
          style={{ backgroundColor: `${outcomeColor(pendingOutcome)}08` }}
        >
          <div className="text-xs tracking-widest" style={{ color: '#71717a' }}>
            DETECTED {detMethod === 'color' ? '🎨 COLOR' : '🔤 OCR'}
          </div>
          <div
            className="text-4xl font-black tracking-wider"
            style={{ color: outcomeColor(pendingOutcome), textShadow: `0 0 20px ${outcomeColor(pendingOutcome)}60` }}
          >
            {OUTCOME_LABEL[pendingOutcome]}
          </div>

          {/* Countdown bar */}
          <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${countdown}%`,
                backgroundColor: outcomeColor(pendingOutcome),
                boxShadow: `0 0 6px ${outcomeColor(pendingOutcome)}80`,
                transition: 'none',
              }}
            />
          </div>
          <div className="text-xs" style={{ color: '#52525b' }}>Auto-submitting in 1 second…</div>

          <div className="flex w-full gap-3">
            <button
              onClick={cancelPreview}
              className="flex-1 py-2.5 text-sm font-bold rounded-sm tracking-wider transition-all active:scale-95"
              style={{
                border: '1px solid rgba(255,255,255,0.18)',
                color: 'rgba(255,255,255,0.55)',
                backgroundColor: 'rgba(255,255,255,0.04)',
                fontFamily: "'JetBrains Mono', monospace",
                cursor: 'pointer',
              }}
            >
              ✕ CANCEL
            </button>
            <button
              onClick={() => commitOutcome(pendingOutcome)}
              className="flex-1 py-2.5 text-sm font-bold rounded-sm tracking-wider transition-all active:scale-95"
              style={{
                border: `2px solid ${outcomeColor(pendingOutcome)}`,
                color: outcomeColor(pendingOutcome),
                backgroundColor: `${outcomeColor(pendingOutcome)}12`,
                fontFamily: "'JetBrains Mono', monospace",
                cursor: 'pointer',
              }}
            >
              ✓ NOW
            </button>
          </div>
        </div>
      )}

      {/* ── Main body ── */}
      {!isPreview && (
        <div className="px-3 py-3 flex flex-col gap-2.5">

          {/* ── Workflow instructions ── */}
          <div
            className="px-3 py-2.5 rounded-sm flex flex-col gap-1"
            style={{ backgroundColor: 'rgba(34,211,238,0.04)', border: '1px solid rgba(34,211,238,0.12)' }}
          >
            <span className="text-xs font-bold tracking-wider" style={{ color: '#22d3ee' }}>
              FASTEST WORKFLOW
            </span>
            <div className="flex flex-col gap-0.5 mt-0.5">
              {[
                '1. Result appears  →  Vol Down + Power',
                '2. Tap  Copy  in the Samsung toolbar',
                '3. Switch to tracker  →  tap PASTE',
              ].map((s, i) => (
                <span key={i} className="text-xs" style={{ color: '#71717a', fontFamily: "'JetBrains Mono', monospace" }}>{s}</span>
              ))}
            </div>
          </div>

          {/* Error / no-result messages */}
          {errorMsg && (
            <div
              className="text-xs px-3 py-2 rounded-sm"
              style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.2)' }}
            >
              {errorMsg}
            </div>
          )}
          {noResultMsg && !errorMsg && (
            <div
              className="text-xs px-3 py-2 rounded-sm"
              style={{ color: '#eab308', backgroundColor: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.2)' }}
            >
              {noResultMsg}
            </div>
          )}

          {/* ── PASTE button (primary) ── */}
          {clipboardSupported ? (
            <button
              onClick={handlePaste}
              disabled={isDisabled}
              className="w-full py-4 font-black text-lg rounded-sm tracking-wider transition-all active:scale-95"
              style={{
                border: isDisabled ? '2px solid rgba(255,255,255,0.08)' : '2px solid rgba(34,211,238,0.7)',
                color: isDisabled ? '#3f3f46' : '#22d3ee',
                backgroundColor: isDisabled ? 'rgba(255,255,255,0.02)' : 'rgba(34,211,238,0.10)',
                fontFamily: "'JetBrains Mono', monospace",
                cursor: isDisabled ? 'not-allowed' : 'pointer',
                boxShadow: isDisabled ? 'none' : '0 0 20px rgba(34,211,238,0.18)',
                fontSize: 16,
              }}
            >
              {isProcessing ? '⏳ ANALYSING…' : isCooldown ? `⏳ WAIT ${cooldownLeft}s` : '📋 PASTE & SCAN'}
            </button>
          ) : (
            <div
              className="text-xs px-3 py-2 rounded-sm"
              style={{ color: '#71717a', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              Clipboard paste not available on this browser. Use the gallery button below.
            </div>
          )}

          {/* ── Gallery fallback ── */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isDisabled}
            className="w-full py-2.5 font-bold text-sm rounded-sm tracking-wider transition-all active:scale-95"
            style={{
              border: '1px solid rgba(255,255,255,0.1)',
              color: isDisabled ? '#27272a' : '#52525b',
              backgroundColor: 'transparent',
              fontFamily: "'JetBrains Mono', monospace",
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              fontSize: 11,
            }}
          >
            📂 PICK FROM GALLERY (FALLBACK)
          </button>

          {/* Duplicate / cooldown notice */}
          {isCooldown && (
            <div
              className="text-xs text-center py-1 rounded-sm font-bold"
              style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.07)', border: '1px solid rgba(251,146,60,0.2)' }}
            >
              ⏳ Submitted — next scan ready in {cooldownLeft}s
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

type Outcome = 'P' | 'B' | 'T';

interface AutoScanPanelProps {
  onDetected: (outcome: Outcome) => void;
  isMutating: boolean;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

// ── Fetch scan token from server ─────────────────────────────────────────────
async function fetchScanToken(): Promise<string> {
  const r = await fetch(`${BASE}/api/game/scan-token`, { credentials: 'include' });
  if (!r.ok) throw new Error('Could not load token');
  const d = await r.json() as { token: string };
  return d.token;
}

// ── Color detection ──────────────────────────────────────────────────────────
function detectByColor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): { outcome: Outcome | null; confidence: number } {
  const scanH   = Math.floor(height * 0.55);
  const xFrom   = Math.floor(width * 0.05);
  const xTo     = Math.floor(width * 0.95);
  const regionW = xTo - xFrom;

  let imageData: ImageData;
  try { imageData = ctx.getImageData(xFrom, 0, regionW, scanH); }
  catch { return { outcome: null, confidence: 0 }; }

  const d = imageData.data;
  let red = 0, blue = 0, green = 0, sampled = 0;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
    const brightness = (r + g + b) / 3;
    if (brightness < 20 || brightness > 235) continue;
    if (r > 120 && r > g * 1.6 && r > b * 1.6) red++;
    else if (b > 100 && b > r * 1.4 && b > g * 1.1) blue++;
    else if (g > 120 && b > 120 && r < 110 && b > g * 0.85) blue++;
    else if (g > 110 && g > r * 1.5 && g > b * 1.3) green++;
    sampled++;
  }

  if (sampled < 150) return { outcome: null, confidence: 0 };
  const rPct = red / sampled, bPct = blue / sampled, gPct = green / sampled;
  const T = 0.045;
  if (rPct > T && rPct > bPct * 1.2 && rPct > gPct * 1.2) return { outcome: 'B', confidence: rPct };
  if (bPct > T && bPct > rPct * 1.2 && bPct > gPct * 1.2) return { outcome: 'P', confidence: bPct };
  if (gPct > T && gPct > rPct * 1.2 && gPct > bPct * 1.2) return { outcome: 'T', confidence: gPct };
  return { outcome: null, confidence: 0 };
}

// ── Tesseract OCR (lazy) ─────────────────────────────────────────────────────
let tWorker: { recognize: (img: string) => Promise<{ data: { text: string } }> } | null = null;
let tState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';

async function getTesseract() {
  if (tState === 'ready' && tWorker) return tWorker;
  if (tState === 'loading') {
    await new Promise<void>((res) => { const t = setInterval(() => { if (tState !== 'loading') { clearInterval(t); res(); } }, 300); });
    return tWorker;
  }
  if (tState === 'failed') return null;
  tState = 'loading';
  try {
    const { createWorker } = await import('tesseract.js');
    tWorker = await createWorker('eng', 1, { logger: () => {} }) as typeof tWorker;
    tState = 'ready';
  } catch { tState = 'failed'; }
  return tWorker;
}

async function detectByOCR(canvas: HTMLCanvasElement): Promise<Outcome | null> {
  const cropH = Math.floor(canvas.height * 0.55);
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width; tmp.height = cropH;
  tmp.getContext('2d')?.drawImage(canvas, 0, 0, canvas.width, cropH, 0, 0, canvas.width, cropH);
  try {
    const w = await getTesseract();
    if (!w) return null;
    const { data: { text } } = await w.recognize(tmp.toDataURL('image/jpeg', 0.75));
    const t = text.toUpperCase();
    if (t.includes('BANKER')) return 'B';
    if (t.includes('PLAYER')) return 'P';
    if (t.includes('TIE'))    return 'T';
  } catch { /**/ }
  return null;
}

async function analyseCanvas(canvas: HTMLCanvasElement): Promise<{ outcome: Outcome | null; method: 'color' | 'ocr' | null }> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { outcome: null, method: null };
  const color = detectByColor(ctx, canvas.width, canvas.height);
  if (color.outcome && color.confidence > 0.06) return { outcome: color.outcome, method: 'color' };
  const ocr = await detectByOCR(canvas);
  if (ocr) return { outcome: ocr, method: 'ocr' };
  return { outcome: null, method: null };
}

async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d')?.drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ── Component ────────────────────────────────────────────────────────────────
type Tab = 'manual' | 'tasker';
type PanelState = 'idle' | 'processing' | 'preview' | 'cooldown';
const OUTCOME_LABEL: Record<Outcome, string> = { P: 'PLAYER', B: 'BANKER', T: 'TIE' };
const OUTCOME_COLOR: Record<Outcome, string> = { P: '#22d3ee', B: '#f87171', T: '#4ade80' };

export function AutoScanPanel({ onDetected, isMutating }: AutoScanPanelProps) {
  const [tab, setTab]                       = useState<Tab>('tasker');
  const [panelState, setPanelState]         = useState<PanelState>('idle');
  const [pendingOutcome, setPendingOutcome] = useState<Outcome | null>(null);
  const [detMethod, setDetMethod]           = useState<'color' | 'ocr' | null>(null);
  const [countdown, setCountdown]           = useState(0);
  const [cooldownLeft, setCooldownLeft]     = useState(0);
  const [errorMsg, setErrorMsg]             = useState('');
  const [noResultMsg, setNoResultMsg]       = useState('');
  const [tokenCopied, setTokenCopied]       = useState(false);

  const fileInputRef      = useRef<HTMLInputElement | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cooldownTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRef        = useRef<Outcome | null>(null);

  // ── Fetch scan token ───────────────────────────────────────────────────────
  const tokenQuery = useQuery({
    queryKey: ['scan-token'],
    queryFn: fetchScanToken,
    staleTime: Infinity,
    retry: 2,
  });
  const scanToken = tokenQuery.data ?? null;

  // Published domain for Tasker URL
  const appHost = window.location.host; // works in both dev & prod

  // ── Cooldown ───────────────────────────────────────────────────────────────
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

  // ── Commit ─────────────────────────────────────────────────────────────────
  const commitOutcome = useCallback((outcome: Outcome) => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    pendingRef.current = null;
    setPendingOutcome(null);
    setCountdown(0);
    onDetected(outcome);
    startCooldown();
  }, [onDetected, startCooldown]);

  // ── Cancel ─────────────────────────────────────────────────────────────────
  const cancelPreview = useCallback(() => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    pendingRef.current = null;
    setPendingOutcome(null);
    setCountdown(0);
    setPanelState('idle');
  }, []);

  // ── Preview countdown ──────────────────────────────────────────────────────
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
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
  }, []);

  // ── Process blob (manual mode) ─────────────────────────────────────────────
  const processBlob = useCallback(async (blob: Blob) => {
    setErrorMsg('');
    setNoResultMsg('');
    setPanelState('processing');
    const canvas = await blobToCanvas(blob);
    if (!canvas) { setErrorMsg('Could not read image.'); setPanelState('idle'); return; }
    const { outcome, method } = await analyseCanvas(canvas);
    if (outcome && method) {
      startPreview(outcome, method);
    } else {
      setNoResultMsg('No result detected — make sure BANKER / PLAYER is visible in the image.');
      setPanelState('idle');
    }
  }, [startPreview]);

  // ── Paste from clipboard ───────────────────────────────────────────────────
  const handlePaste = useCallback(async () => {
    setErrorMsg(''); setNoResultMsg('');
    try {
      // @ts-ignore
      const items: ClipboardItem[] = await navigator.clipboard.read();
      let blob: Blob | null = null;
      for (const item of items) {
        const type = item.types.find((t: string) => t.startsWith('image/'));
        if (type) { blob = await item.getType(type); break; }
      }
      if (!blob) { setErrorMsg('No image on clipboard. Take a screenshot → tap Copy in Samsung toolbar → then PASTE.'); return; }
      await processBlob(blob);
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (msg.includes('permission') || msg.includes('denied')) {
        setErrorMsg('Clipboard permission denied. Tap PASTE again and allow when Chrome asks.');
      } else {
        setErrorMsg('Could not read clipboard — use the gallery button below.');
      }
    }
  }, [processBlob]);

  // ── Gallery picker ─────────────────────────────────────────────────────────
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    await processBlob(file);
  }, [processBlob]);

  // ── Copy token to clipboard ────────────────────────────────────────────────
  const copyToken = useCallback(async () => {
    if (!scanToken) return;
    try { await navigator.clipboard.writeText(scanToken); setTokenCopied(true); setTimeout(() => setTokenCopied(false), 2000); }
    catch { /**/ }
  }, [scanToken]);

  // ── State helpers ──────────────────────────────────────────────────────────
  const isPreview    = panelState === 'preview';
  const isProcessing = panelState === 'processing';
  const isCooldown   = panelState === 'cooldown';
  const isDisabled   = isProcessing || isMutating || isCooldown || isPreview;
  const oc           = (o: Outcome) => OUTCOME_COLOR[o];
  const hasClipboard = !!(navigator.clipboard && typeof (navigator.clipboard as { read?: unknown }).read === 'function');

  // ── Tasker instructions ────────────────────────────────────────────────────
  const scanUrl = `https://${appHost}/api/game/auto-scan`;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className="rounded-sm border flex flex-col overflow-hidden"
      style={{
        backgroundColor: '#09090f',
        borderColor: isPreview ? 'rgba(34,211,238,0.45)' : isProcessing ? 'rgba(250,204,21,0.3)' : 'rgba(255,255,255,0.1)',
        transition: 'border-color 0.3s',
      }}
    >
      {/* ── Header ── */}
      <div className="px-4 py-2.5 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', backgroundColor: 'rgba(34,211,238,0.025)' }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold tracking-widest" style={{ color: '#22d3ee' }}>📡 AUTO SCAN</span>
        </div>
        {/* Tab toggle */}
        <div className="flex rounded-sm overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
          {(['tasker', 'manual'] as Tab[]).map((t) => (
            <button key={t} onClick={() => { setTab(t); setErrorMsg(''); setNoResultMsg(''); }}
              disabled={isPreview || isProcessing}
              className="px-2.5 py-1 text-xs font-bold tracking-wider transition-all"
              style={{
                color: tab === t ? '#22d3ee' : '#52525b',
                backgroundColor: tab === t ? 'rgba(34,211,238,0.1)' : 'transparent',
                fontFamily: "'JetBrains Mono', monospace",
                cursor: isPreview || isProcessing ? 'not-allowed' : 'pointer',
                fontSize: 9,
              }}>
              {t === 'tasker' ? '🤖 TASKER' : '📸 MANUAL'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Preview overlay ── */}
      {isPreview && pendingOutcome && (
        <div className="flex flex-col items-center gap-3 px-4 py-4"
          style={{ backgroundColor: `${oc(pendingOutcome)}08` }}>
          <div className="text-xs tracking-widest" style={{ color: '#71717a' }}>
            DETECTED {detMethod === 'color' ? '🎨 COLOR' : '🔤 OCR'}
          </div>
          <div className="text-4xl font-black tracking-wider"
            style={{ color: oc(pendingOutcome), textShadow: `0 0 20px ${oc(pendingOutcome)}60` }}>
            {OUTCOME_LABEL[pendingOutcome]}
          </div>
          <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}>
            <div className="h-full rounded-full"
              style={{ width: `${countdown}%`, backgroundColor: oc(pendingOutcome), boxShadow: `0 0 6px ${oc(pendingOutcome)}80`, transition: 'none' }} />
          </div>
          <div className="text-xs" style={{ color: '#52525b' }}>Auto-submitting in 1 second…</div>
          <div className="flex w-full gap-3">
            <button onClick={cancelPreview} className="flex-1 py-2.5 text-sm font-bold rounded-sm tracking-wider active:scale-95"
              style={{ border: '1px solid rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.55)', backgroundColor: 'rgba(255,255,255,0.04)', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
              ✕ CANCEL
            </button>
            <button onClick={() => commitOutcome(pendingOutcome)} className="flex-1 py-2.5 text-sm font-bold rounded-sm tracking-wider active:scale-95"
              style={{ border: `2px solid ${oc(pendingOutcome)}`, color: oc(pendingOutcome), backgroundColor: `${oc(pendingOutcome)}12`, fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
              ✓ NOW
            </button>
          </div>
        </div>
      )}

      {/* ── TASKER tab ── */}
      {!isPreview && tab === 'tasker' && (
        <div className="px-3 py-3 flex flex-col gap-3">

          {/* Status badge */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-sm"
            style={{ backgroundColor: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.2)' }}>
            <span style={{ color: '#4ade80', fontSize: 16 }}>🤖</span>
            <div className="flex flex-col">
              <span className="text-xs font-bold" style={{ color: '#4ade80', fontFamily: 'monospace' }}>FULLY AUTOMATIC MODE</span>
              <span className="text-xs" style={{ color: '#52525b' }}>Screenshot taken → auto-detected → auto-submitted</span>
            </div>
          </div>

          {/* What you need */}
          <div className="flex flex-col gap-1 px-3 py-2.5 rounded-sm"
            style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <span className="text-xs font-bold tracking-wider mb-1" style={{ color: '#facc15' }}>WHAT YOU NEED (FREE)</span>
            <span className="text-xs" style={{ color: '#a1a1aa' }}>
              Install <span style={{ color: '#22d3ee', fontWeight: 'bold' }}>MacroDroid</span> from Play Store — it's free and does this perfectly.
              (Tasker also works but costs money.)
            </span>
          </div>

          {/* Token section */}
          <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-sm"
            style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <span className="text-xs font-bold tracking-wider" style={{ color: '#71717a' }}>STEP 1 — COPY YOUR TOKEN</span>
            {tokenQuery.isLoading && (
              <span className="text-xs" style={{ color: '#52525b', fontFamily: 'monospace' }}>Loading…</span>
            )}
            {tokenQuery.isError && (
              <span className="text-xs" style={{ color: '#f87171' }}>Could not load token — make sure you are logged in.</span>
            )}
            {scanToken && (
              <>
                <div className="px-2 py-1.5 rounded-sm text-xs break-all select-all"
                  style={{ backgroundColor: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', color: '#a1a1aa', fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.03em' }}>
                  {scanToken}
                </div>
                <button onClick={copyToken}
                  className="w-full py-2 text-xs font-bold rounded-sm tracking-wider active:scale-95"
                  style={{
                    border: `1px solid ${tokenCopied ? 'rgba(74,222,128,0.4)' : 'rgba(34,211,238,0.35)'}`,
                    color: tokenCopied ? '#4ade80' : '#22d3ee',
                    backgroundColor: tokenCopied ? 'rgba(74,222,128,0.06)' : 'rgba(34,211,238,0.06)',
                    fontFamily: "'JetBrains Mono', monospace",
                    cursor: 'pointer',
                  }}>
                  {tokenCopied ? '✓ COPIED!' : '📋 COPY TOKEN'}
                </button>
              </>
            )}
          </div>

          {/* MacroDroid setup steps */}
          <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-sm"
            style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <span className="text-xs font-bold tracking-wider mb-0.5" style={{ color: '#71717a' }}>STEP 2 — SET UP MACRODROID</span>
            {[
              ['1.', 'Open MacroDroid → Add Macro'],
              ['2.', 'Trigger: "File Created" → path: /DCIM/Screenshots'],
              ['3.', 'Action: "HTTP Request"'],
              ['4.', '  Method: POST'],
              ['5.', `  URL: ${scanUrl}`],
              ['6.', '  Header: Authorization: Bearer <paste token>'],
              ['7.', '  Body type: Multipart'],
              ['8.', '  Field name: image   Value: {file}'],
              ['9.', 'Save macro — done! ✓'],
            ].map(([n, s], i) => (
              <div key={i} className="flex gap-2">
                <span className="text-xs font-bold shrink-0" style={{ color: '#52525b', fontFamily: 'monospace', minWidth: 16 }}>{n}</span>
                <span className="text-xs" style={{ color: i >= 3 && i <= 7 ? '#a1a1aa' : '#71717a', fontFamily: i >= 3 && i <= 7 ? 'monospace' : 'inherit', fontSize: i >= 3 && i <= 7 ? 10 : undefined }}>{s}</span>
              </div>
            ))}
          </div>

          {/* API endpoint info */}
          <div className="px-3 py-2 rounded-sm"
            style={{ backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="text-xs font-bold tracking-wider block mb-1" style={{ color: '#3f3f46', fontSize: 9 }}>AUTO-SCAN ENDPOINT</span>
            <span className="text-xs break-all" style={{ color: '#52525b', fontFamily: 'monospace', fontSize: 10 }}>{scanUrl}</span>
          </div>

          {/* After-setup note */}
          <div className="text-xs px-3 py-2 rounded-sm"
            style={{ color: '#52525b', backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
            Once set up: take screenshot → MacroDroid fires automatically → outcome submitted in ~1 second. No taps needed.
          </div>
        </div>
      )}

      {/* ── MANUAL tab ── */}
      {!isPreview && tab === 'manual' && (
        <div className="px-3 py-3 flex flex-col gap-2.5">

          <div className="px-3 py-2.5 rounded-sm flex flex-col gap-1"
            style={{ backgroundColor: 'rgba(34,211,238,0.04)', border: '1px solid rgba(34,211,238,0.12)' }}>
            <span className="text-xs font-bold tracking-wider" style={{ color: '#22d3ee' }}>FASTEST MANUAL WORKFLOW</span>
            {[
              '1. Result appears  →  Vol Down + Power',
              '2. Tap  Copy  in Samsung screenshot toolbar',
              '3. Switch here  →  tap PASTE & SCAN',
            ].map((s, i) => (
              <span key={i} className="text-xs" style={{ color: '#71717a', fontFamily: "'JetBrains Mono', monospace" }}>{s}</span>
            ))}
          </div>

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

          {/* Paste button */}
          {hasClipboard ? (
            <button onClick={handlePaste} disabled={isDisabled}
              className="w-full py-4 font-black text-lg rounded-sm tracking-wider active:scale-95"
              style={{
                border: isDisabled ? '2px solid rgba(255,255,255,0.08)' : '2px solid rgba(34,211,238,0.7)',
                color: isDisabled ? '#3f3f46' : '#22d3ee',
                backgroundColor: isDisabled ? 'rgba(255,255,255,0.02)' : 'rgba(34,211,238,0.10)',
                fontFamily: "'JetBrains Mono', monospace",
                cursor: isDisabled ? 'not-allowed' : 'pointer',
                boxShadow: isDisabled ? 'none' : '0 0 20px rgba(34,211,238,0.18)',
                fontSize: 16,
              }}>
              {isProcessing ? '⏳ ANALYSING…' : isCooldown ? `⏳ WAIT ${cooldownLeft}s` : '📋 PASTE & SCAN'}
            </button>
          ) : (
            <div className="text-xs px-3 py-2 rounded-sm"
              style={{ color: '#71717a', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
              Clipboard paste not available — use gallery button below.
            </div>
          )}

          {/* Gallery fallback */}
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
          <button onClick={() => fileInputRef.current?.click()} disabled={isDisabled}
            className="w-full py-2.5 font-bold text-sm rounded-sm tracking-wider active:scale-95"
            style={{
              border: '1px solid rgba(255,255,255,0.1)',
              color: isDisabled ? '#27272a' : '#52525b',
              backgroundColor: 'transparent',
              fontFamily: "'JetBrains Mono', monospace",
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              fontSize: 11,
            }}>
            📂 PICK FROM GALLERY
          </button>

          {isCooldown && (
            <div className="text-xs text-center py-1 rounded-sm font-bold"
              style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.07)', border: '1px solid rgba(251,146,60,0.2)' }}>
              ⏳ Submitted — ready in {cooldownLeft}s
            </div>
          )}
        </div>
      )}
    </div>
  );
}

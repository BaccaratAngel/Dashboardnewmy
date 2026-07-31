import { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

type Outcome = 'P' | 'B' | 'T';

interface AutoScanPanelProps {
  onDetected: (outcome: Outcome) => void;
  isMutating: boolean;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

async function fetchScanToken(): Promise<string> {
  const r = await fetch(`${BASE}/api/game/scan-token`, { credentials: 'include' });
  if (!r.ok) throw new Error('Could not load token');
  const d = await r.json() as { token: string };
  return d.token;
}

// ── Color detection (for manual mode) ────────────────────────────────────────
function detectByColor(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const scanH = Math.floor(height * 0.55);
  const xFrom = Math.floor(width * 0.05);
  const xTo   = Math.floor(width * 0.95);
  let imageData: ImageData;
  try { imageData = ctx.getImageData(xFrom, 0, xTo - xFrom, scanH); }
  catch { return { outcome: null as Outcome | null, confidence: 0 }; }

  const d = imageData.data;
  let red = 0, blue = 0, green = 0, sampled = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
    const br = (r + g + b) / 3;
    if (br < 20 || br > 235) continue;
    if (r > 120 && r > g * 1.6 && r > b * 1.6) red++;
    else if (b > 100 && b > r * 1.4 && b > g * 1.1) blue++;
    else if (g > 120 && b > 120 && r < 110) blue++;
    else if (g > 110 && g > r * 1.5 && g > b * 1.3) green++;
    sampled++;
  }
  if (sampled < 150) return { outcome: null as Outcome | null, confidence: 0 };
  const rP = red / sampled, bP = blue / sampled, gP = green / sampled, T = 0.045;
  if (rP > T && rP > bP * 1.2 && rP > gP * 1.2) return { outcome: 'B' as Outcome, confidence: rP };
  if (bP > T && bP > rP * 1.2 && bP > gP * 1.2) return { outcome: 'P' as Outcome, confidence: bP };
  if (gP > T && gP > rP * 1.2 && gP > bP * 1.2) return { outcome: 'T' as Outcome, confidence: gP };
  return { outcome: null as Outcome | null, confidence: 0 };
}

let tWorker: { recognize: (img: string) => Promise<{ data: { text: string } }> } | null = null;
let tState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
async function getTesseract() {
  if (tState === 'ready' && tWorker) return tWorker;
  if (tState === 'loading') { await new Promise<void>((res) => { const t = setInterval(() => { if (tState !== 'loading') { clearInterval(t); res(); } }, 300); }); return tWorker; }
  if (tState === 'failed') return null;
  tState = 'loading';
  try { const { createWorker } = await import('tesseract.js'); tWorker = await createWorker('eng', 1, { logger: () => {} }) as typeof tWorker; tState = 'ready'; } catch { tState = 'failed'; }
  return tWorker;
}
async function detectByOCR(canvas: HTMLCanvasElement): Promise<Outcome | null> {
  const cropH = Math.floor(canvas.height * 0.55);
  const tmp = document.createElement('canvas'); tmp.width = canvas.width; tmp.height = cropH;
  tmp.getContext('2d')?.drawImage(canvas, 0, 0, canvas.width, cropH, 0, 0, canvas.width, cropH);
  try { const w = await getTesseract(); if (!w) return null; const { data: { text } } = await w.recognize(tmp.toDataURL('image/jpeg', 0.75)); const t = text.toUpperCase(); if (t.includes('BANKER')) return 'B'; if (t.includes('PLAYER')) return 'P'; if (t.includes('TIE')) return 'T'; } catch { /**/ }
  return null;
}
async function analyseCanvas(canvas: HTMLCanvasElement): Promise<{ outcome: Outcome | null; method: 'color' | 'ocr' | null }> {
  const ctx = canvas.getContext('2d'); if (!ctx) return { outcome: null, method: null };
  const c = detectByColor(ctx, canvas.width, canvas.height);
  if (c.outcome && c.confidence > 0.06) return { outcome: c.outcome, method: 'color' };
  const ocr = await detectByOCR(canvas); if (ocr) return { outcome: ocr, method: 'ocr' };
  return { outcome: null, method: null };
}
async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const img = new Image(); const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d')?.drawImage(img, 0, 0); resolve(c); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ── Component ────────────────────────────────────────────────────────────────
type Tab = 'auto' | 'manual';
type PanelState = 'idle' | 'processing' | 'preview' | 'cooldown';
const OUTCOME_LABEL: Record<Outcome, string> = { P: 'PLAYER', B: 'BANKER', T: 'TIE' };
const OUTCOME_COLOR: Record<Outcome, string> = { P: '#22d3ee', B: '#f87171', T: '#4ade80' };

export function AutoScanPanel({ onDetected, isMutating }: AutoScanPanelProps) {
  const [tab, setTab]                       = useState<Tab>('auto');
  const [panelState, setPanelState]         = useState<PanelState>('idle');
  const [pendingOutcome, setPendingOutcome] = useState<Outcome | null>(null);
  const [detMethod, setDetMethod]           = useState<'color' | 'ocr' | null>(null);
  const [countdown, setCountdown]           = useState(0);
  const [cooldownLeft, setCooldownLeft]     = useState(0);
  const [errorMsg, setErrorMsg]             = useState('');
  const [noResultMsg, setNoResultMsg]       = useState('');
  const [tokenCopied, setTokenCopied]       = useState(false);
  const [urlCopied, setUrlCopied]           = useState(false);

  const fileInputRef      = useRef<HTMLInputElement | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cooldownTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRef        = useRef<Outcome | null>(null);

  const tokenQuery = useQuery({ queryKey: ['scan-token'], queryFn: fetchScanToken, staleTime: Infinity, retry: 2 });
  const scanToken  = tokenQuery.data ?? null;
  const appHost    = window.location.host;
  const inputUrl   = `https://${appHost}/api/game/auto-input`;

  const startCooldown = useCallback(() => {
    setPanelState('cooldown'); let left = 3; setCooldownLeft(left);
    cooldownTimerRef.current = setInterval(() => { left--; setCooldownLeft(left); if (left <= 0) { if (cooldownTimerRef.current) { clearInterval(cooldownTimerRef.current); cooldownTimerRef.current = null; } setPanelState('idle'); } }, 1000);
  }, []);

  const commitOutcome = useCallback((outcome: Outcome) => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    pendingRef.current = null; setPendingOutcome(null); setCountdown(0);
    onDetected(outcome); startCooldown();
  }, [onDetected, startCooldown]);

  const cancelPreview = useCallback(() => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    pendingRef.current = null; setPendingOutcome(null); setCountdown(0); setPanelState('idle');
  }, []);

  const startPreview = useCallback((outcome: Outcome, method: 'color' | 'ocr') => {
    if (pendingRef.current) return;
    pendingRef.current = outcome; setPendingOutcome(outcome); setDetMethod(method); setPanelState('preview'); setCountdown(0);
    const DURATION = 1000, TICK = 40; let elapsed = 0;
    countdownTimerRef.current = setInterval(() => {
      elapsed += TICK; setCountdown(Math.min((elapsed / DURATION) * 100, 100));
      if (elapsed >= DURATION) { if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; } commitOutcome(outcome); }
    }, TICK);
  }, [commitOutcome]);

  useEffect(() => () => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
  }, []);

  const processBlob = useCallback(async (blob: Blob) => {
    setErrorMsg(''); setNoResultMsg(''); setPanelState('processing');
    const canvas = await blobToCanvas(blob);
    if (!canvas) { setErrorMsg('Could not read image.'); setPanelState('idle'); return; }
    const { outcome, method } = await analyseCanvas(canvas);
    if (outcome && method) { startPreview(outcome, method); }
    else { setNoResultMsg('No result detected — make sure BANKER / PLAYER is visible.'); setPanelState('idle'); }
  }, [startPreview]);

  const handlePaste = useCallback(async () => {
    setErrorMsg(''); setNoResultMsg('');
    try {
      // @ts-ignore
      const items: ClipboardItem[] = await navigator.clipboard.read();
      let blob: Blob | null = null;
      for (const item of items) { const type = item.types.find((t: string) => t.startsWith('image/')); if (type) { blob = await item.getType(type); break; } }
      if (!blob) { setErrorMsg('No image on clipboard. Take screenshot → tap Copy in toolbar → PASTE.'); return; }
      await processBlob(blob);
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (msg.includes('permission') || msg.includes('denied')) setErrorMsg('Clipboard permission denied. Tap again and allow.');
      else setErrorMsg('Could not read clipboard — use gallery button.');
    }
  }, [processBlob]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (e.target) e.target.value = ''; if (!file) return;
    await processBlob(file);
  }, [processBlob]);

  const copyToken = useCallback(async () => {
    if (!scanToken) return;
    try { await navigator.clipboard.writeText(scanToken); setTokenCopied(true); setTimeout(() => setTokenCopied(false), 2000); } catch { /**/ }
  }, [scanToken]);

  const copyUrl = useCallback(async () => {
    try { await navigator.clipboard.writeText(inputUrl); setUrlCopied(true); setTimeout(() => setUrlCopied(false), 2000); } catch { /**/ }
  }, [inputUrl]);

  const isPreview    = panelState === 'preview';
  const isProcessing = panelState === 'processing';
  const isCooldown   = panelState === 'cooldown';
  const isDisabled   = isProcessing || isMutating || isCooldown || isPreview;
  const oc           = (o: Outcome) => OUTCOME_COLOR[o];
  const hasClipboard = !!(navigator.clipboard && typeof (navigator.clipboard as { read?: unknown }).read === 'function');

  return (
    <div className="rounded-sm border flex flex-col overflow-hidden"
      style={{ backgroundColor: '#09090f', borderColor: isPreview ? 'rgba(34,211,238,0.45)' : isProcessing ? 'rgba(250,204,21,0.3)' : 'rgba(255,255,255,0.1)', transition: 'border-color 0.3s' }}>

      {/* Header */}
      <div className="px-4 py-2.5 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', backgroundColor: 'rgba(34,211,238,0.025)' }}>
        <span className="text-xs font-bold tracking-widest" style={{ color: '#22d3ee' }}>📡 AUTO SCAN</span>
        <div className="flex rounded-sm overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
          {(['auto', 'manual'] as Tab[]).map(t => (
            <button key={t} onClick={() => { setTab(t); setErrorMsg(''); setNoResultMsg(''); }}
              disabled={isPreview || isProcessing}
              className="px-2.5 py-1 text-xs font-bold tracking-wider"
              style={{ color: tab === t ? '#22d3ee' : '#52525b', backgroundColor: tab === t ? 'rgba(34,211,238,0.1)' : 'transparent', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer', fontSize: 9 }}>
              {t === 'auto' ? '🤖 AUTO' : '📸 MANUAL'}
            </button>
          ))}
        </div>
      </div>

      {/* Preview overlay */}
      {isPreview && pendingOutcome && (
        <div className="flex flex-col items-center gap-3 px-4 py-4" style={{ backgroundColor: `${oc(pendingOutcome)}08` }}>
          <div className="text-xs tracking-widest" style={{ color: '#71717a' }}>DETECTED {detMethod === 'color' ? '🎨 COLOR' : '🔤 OCR'}</div>
          <div className="text-4xl font-black tracking-wider" style={{ color: oc(pendingOutcome), textShadow: `0 0 20px ${oc(pendingOutcome)}60` }}>{OUTCOME_LABEL[pendingOutcome]}</div>
          <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}>
            <div className="h-full rounded-full" style={{ width: `${countdown}%`, backgroundColor: oc(pendingOutcome), transition: 'none' }} />
          </div>
          <div className="text-xs" style={{ color: '#52525b' }}>Auto-submitting in 1 second…</div>
          <div className="flex w-full gap-3">
            <button onClick={cancelPreview} className="flex-1 py-2.5 text-sm font-bold rounded-sm active:scale-95"
              style={{ border: '1px solid rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.55)', backgroundColor: 'rgba(255,255,255,0.04)', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
              ✕ CANCEL
            </button>
            <button onClick={() => commitOutcome(pendingOutcome)} className="flex-1 py-2.5 text-sm font-bold rounded-sm active:scale-95"
              style={{ border: `2px solid ${oc(pendingOutcome)}`, color: oc(pendingOutcome), backgroundColor: `${oc(pendingOutcome)}12`, fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
              ✓ NOW
            </button>
          </div>
        </div>
      )}

      {/* ── AUTO tab ─────────────────────────────────────────────────────── */}
      {!isPreview && tab === 'auto' && (
        <div className="px-3 py-3 flex flex-col gap-3">

          {/* Hero badge */}
          <div className="flex items-start gap-3 px-3 py-3 rounded-sm"
            style={{ backgroundColor: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.25)' }}>
            <span style={{ fontSize: 22, lineHeight: 1 }}>🤖</span>
            <div>
              <div className="text-xs font-black tracking-wider mb-0.5" style={{ color: '#4ade80' }}>ZERO TAPS — FULLY AUTOMATIC</div>
              <div className="text-xs" style={{ color: '#71717a' }}>
                MacroDroid watches your screen. When BANKER or PLAYER appears it instantly posts the result — no screenshot, no button.
              </div>
            </div>
          </div>

          {/* Requirement */}
          <div className="px-3 py-2 rounded-sm" style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="text-xs font-bold tracking-wider mb-1" style={{ color: '#facc15' }}>YOU NEED (FREE)</div>
            <div className="text-xs" style={{ color: '#a1a1aa' }}>
              Install <span style={{ color: '#22d3ee', fontWeight: 'bold' }}>MacroDroid</span> from Play Store — it's free.
            </div>
          </div>

          {/* Step 1 — Token */}
          <div className="flex flex-col gap-2 px-3 py-2.5 rounded-sm" style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="text-xs font-bold tracking-wider" style={{ color: '#71717a' }}>STEP 1 — YOUR TOKEN</div>
            {tokenQuery.isLoading && <span className="text-xs" style={{ color: '#52525b' }}>Loading…</span>}
            {tokenQuery.isError  && <span className="text-xs" style={{ color: '#f87171' }}>Error — make sure you are logged in.</span>}
            {scanToken && (
              <>
                <div className="px-2 py-1.5 rounded-sm text-xs break-all select-all"
                  style={{ backgroundColor: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.1)', color: '#a1a1aa', fontFamily: 'monospace', fontSize: 10 }}>
                  {scanToken}
                </div>
                <button onClick={copyToken} className="w-full py-1.5 text-xs font-bold rounded-sm active:scale-95"
                  style={{ border: `1px solid ${tokenCopied ? 'rgba(74,222,128,0.4)' : 'rgba(34,211,238,0.35)'}`, color: tokenCopied ? '#4ade80' : '#22d3ee', backgroundColor: tokenCopied ? 'rgba(74,222,128,0.06)' : 'rgba(34,211,238,0.06)', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
                  {tokenCopied ? '✓ COPIED!' : '📋 COPY TOKEN'}
                </button>
              </>
            )}
          </div>

          {/* Step 2 — URL */}
          <div className="flex flex-col gap-2 px-3 py-2.5 rounded-sm" style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="text-xs font-bold tracking-wider" style={{ color: '#71717a' }}>STEP 2 — ENDPOINT URL</div>
            <div className="px-2 py-1.5 rounded-sm text-xs break-all select-all"
              style={{ backgroundColor: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.1)', color: '#a1a1aa', fontFamily: 'monospace', fontSize: 10 }}>
              {inputUrl}
            </div>
            <button onClick={copyUrl} className="w-full py-1.5 text-xs font-bold rounded-sm active:scale-95"
              style={{ border: `1px solid ${urlCopied ? 'rgba(74,222,128,0.4)' : 'rgba(34,211,238,0.35)'}`, color: urlCopied ? '#4ade80' : '#22d3ee', backgroundColor: urlCopied ? 'rgba(74,222,128,0.06)' : 'rgba(34,211,238,0.06)', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
              {urlCopied ? '✓ COPIED!' : '📋 COPY URL'}
            </button>
          </div>

          {/* Step 3 — MacroDroid instructions */}
          <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-sm" style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="text-xs font-bold tracking-wider mb-1" style={{ color: '#71717a' }}>STEP 3 — MACRODROID SETUP</div>
            <div className="text-xs mb-1" style={{ color: '#52525b' }}>Create 2 macros (one for BANKER, one for PLAYER):</div>

            {/* Banker macro */}
            <div className="text-xs font-bold mb-0.5" style={{ color: '#f87171' }}>BANKER macro:</div>
            {[
              'Add Macro → name it "Banker"',
              'Trigger → Accessibility → "UI Content Changed"',
              '  Filter text: BANKER',
              '  App: 1xBet (or "Any app")',
              'Action → Connectivity → "HTTP Request"',
              '  Method: POST',
              '  URL: paste URL from Step 2',
              '  Header key: Authorization',
              '  Header val: Bearer <paste token>',
              '  Body: {"value":"B"}',
              '  Content-Type: application/json',
            ].map((s, i) => (
              <div key={i} className="flex gap-1.5">
                <span className="text-xs shrink-0" style={{ color: '#3f3f46', fontFamily: 'monospace' }}>›</span>
                <span className="text-xs" style={{ color: s.startsWith('  ') ? '#a1a1aa' : '#71717a', fontFamily: s.startsWith('  ') ? 'monospace' : 'inherit', fontSize: s.startsWith('  ') ? 10 : undefined }}>{s.trim()}</span>
              </div>
            ))}

            <div className="mt-2 text-xs font-bold mb-0.5" style={{ color: '#22d3ee' }}>PLAYER macro:</div>
            <div className="text-xs" style={{ color: '#71717a' }}>Same steps — filter text: <span style={{ fontFamily: 'monospace', color: '#a1a1aa' }}>PLAYER</span>, body: <span style={{ fontFamily: 'monospace', color: '#a1a1aa' }}>{"{"}"value":"P"{"}"}</span></div>
          </div>

          {/* Enable accessibility note */}
          <div className="px-3 py-2 rounded-sm" style={{ backgroundColor: 'rgba(250,204,21,0.05)', border: '1px solid rgba(250,204,21,0.15)' }}>
            <div className="text-xs font-bold mb-0.5" style={{ color: '#facc15' }}>⚠️ ENABLE ACCESSIBILITY</div>
            <div className="text-xs" style={{ color: '#71717a' }}>
              MacroDroid will ask to enable Accessibility Service — tap Allow. This is how it reads text on screen without a screenshot.
            </div>
          </div>

          {/* Result */}
          <div className="px-3 py-2 rounded-sm" style={{ backgroundColor: 'rgba(74,222,128,0.04)', border: '1px solid rgba(74,222,128,0.12)' }}>
            <div className="text-xs" style={{ color: '#52525b' }}>
              Once set up: result appears on screen → MacroDroid detects it automatically → outcome submitted in under 1 second. <span style={{ color: '#4ade80' }}>Zero taps.</span>
            </div>
          </div>
        </div>
      )}

      {/* ── MANUAL tab ───────────────────────────────────────────────────── */}
      {!isPreview && tab === 'manual' && (
        <div className="px-3 py-3 flex flex-col gap-2.5">
          <div className="px-3 py-2.5 rounded-sm flex flex-col gap-1"
            style={{ backgroundColor: 'rgba(34,211,238,0.04)', border: '1px solid rgba(34,211,238,0.12)' }}>
            <span className="text-xs font-bold tracking-wider" style={{ color: '#22d3ee' }}>MANUAL WORKFLOW</span>
            {['1. Result appears  →  Vol Down + Power', '2. Tap  Copy  in Samsung screenshot toolbar', '3. Switch here  →  tap PASTE & SCAN'].map((s, i) => (
              <span key={i} className="text-xs" style={{ color: '#71717a', fontFamily: "'JetBrains Mono', monospace" }}>{s}</span>
            ))}
          </div>

          {errorMsg && <div className="text-xs px-3 py-2 rounded-sm" style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.2)' }}>{errorMsg}</div>}
          {noResultMsg && !errorMsg && <div className="text-xs px-3 py-2 rounded-sm" style={{ color: '#eab308', backgroundColor: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.2)' }}>{noResultMsg}</div>}

          {hasClipboard ? (
            <button onClick={handlePaste} disabled={isDisabled} className="w-full py-4 font-black text-lg rounded-sm tracking-wider active:scale-95"
              style={{ border: isDisabled ? '2px solid rgba(255,255,255,0.08)' : '2px solid rgba(34,211,238,0.7)', color: isDisabled ? '#3f3f46' : '#22d3ee', backgroundColor: isDisabled ? 'rgba(255,255,255,0.02)' : 'rgba(34,211,238,0.10)', fontFamily: "'JetBrains Mono', monospace", cursor: isDisabled ? 'not-allowed' : 'pointer', boxShadow: isDisabled ? 'none' : '0 0 20px rgba(34,211,238,0.18)', fontSize: 16 }}>
              {isProcessing ? '⏳ ANALYSING…' : isCooldown ? `⏳ WAIT ${cooldownLeft}s` : '📋 PASTE & SCAN'}
            </button>
          ) : (
            <div className="text-xs px-3 py-2 rounded-sm" style={{ color: '#71717a', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>Clipboard not available — use gallery.</div>
          )}

          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
          <button onClick={() => fileInputRef.current?.click()} disabled={isDisabled} className="w-full py-2.5 font-bold text-sm rounded-sm tracking-wider active:scale-95"
            style={{ border: '1px solid rgba(255,255,255,0.1)', color: isDisabled ? '#27272a' : '#52525b', backgroundColor: 'transparent', fontFamily: "'JetBrains Mono', monospace", cursor: isDisabled ? 'not-allowed' : 'pointer', fontSize: 11 }}>
            📂 PICK FROM GALLERY
          </button>

          {isCooldown && (
            <div className="text-xs text-center py-1 rounded-sm font-bold" style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.07)', border: '1px solid rgba(251,146,60,0.2)' }}>
              ⏳ Submitted — ready in {cooldownLeft}s
            </div>
          )}
        </div>
      )}
    </div>
  );
}

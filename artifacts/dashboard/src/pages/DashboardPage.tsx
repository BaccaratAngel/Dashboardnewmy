import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import {
  useGetMe,
  useGetSnapshot,
  useSubmitInput,
  useUndoInput,
  useResetGame,
  useSetWindow,
  useLogout,
} from '@workspace/api-client-react';
import type { GameSnapshot } from '@workspace/api-client-react';
import { cn } from '@/lib/utils';

function StatusBadge({ status }: { status: string }) {
  if (status === 'WARMING_UP') {
    return (
      <span
        className="text-xs font-bold tracking-widest px-3 py-1 rounded-sm"
        style={{
          color: '#eab308',
          backgroundColor: 'rgba(234,179,8,0.1)',
          border: '1px solid rgba(234,179,8,0.3)',
        }}
      >
        WARMING UP
      </span>
    );
  }
  if (status === 'TRACKING') {
    return (
      <span
        className="text-xs font-bold tracking-widest px-3 py-1 rounded-sm"
        style={{
          color: '#22d3ee',
          backgroundColor: 'rgba(34,211,238,0.1)',
          border: '1px solid rgba(34,211,238,0.3)',
        }}
      >
        TRACKING
      </span>
    );
  }
  if (status === 'SPLIT') {
    return (
      <span
        className="text-xs font-bold tracking-widest px-3 py-1 rounded-sm"
        style={{
          color: '#fb923c',
          backgroundColor: 'rgba(251,146,60,0.1)',
          border: '1px solid rgba(251,146,60,0.3)',
        }}
      >
        SPLIT
      </span>
    );
  }
  return (
    <span
      className="text-xs font-bold tracking-widest px-3 py-1 rounded-sm"
      style={{ color: '#71717a', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      {status}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  if (confidence === 'HIGH') {
    return (
      <span
        className="text-xs font-bold tracking-wider px-2 py-0.5 rounded-sm"
        style={{
          color: '#4ade80',
          backgroundColor: 'rgba(74,222,128,0.1)',
          border: '1px solid rgba(74,222,128,0.3)',
        }}
      >
        HIGH
      </span>
    );
  }
  if (confidence === 'MED') {
    return (
      <span
        className="text-xs font-bold tracking-wider px-2 py-0.5 rounded-sm"
        style={{
          color: '#facc15',
          backgroundColor: 'rgba(250,204,21,0.1)',
          border: '1px solid rgba(250,204,21,0.3)',
        }}
      >
        MED
      </span>
    );
  }
  if (confidence === 'LOW') {
    return (
      <span
        className="text-xs font-bold tracking-wider px-2 py-0.5 rounded-sm"
        style={{
          color: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.1)',
          border: '1px solid rgba(245,158,11,0.3)',
        }}
      >
        LOW
      </span>
    );
  }
  return (
    <span
      className="text-xs font-bold tracking-wider px-2 py-0.5 rounded-sm"
      style={{ color: '#71717a', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      NONE
    </span>
  );
}

function LookAheadBadge({ la }: { la: { active: boolean; verdict: string | null } }) {
  if (!la.active || !la.verdict) {
    return (
      <span className="text-xs font-bold px-2 py-0.5 rounded-sm" style={{ color: '#52525b', border: '1px solid rgba(255,255,255,0.07)' }}>
        --
      </span>
    );
  }
  if (la.verdict === 'P') {
    return (
      <span className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider" style={{ color: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.3)' }}>
        PLAYER ▲
      </span>
    );
  }
  return (
    <span className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider" style={{ color: '#f87171', backgroundColor: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)' }}>
      BANKER ▲
    </span>
  );
}

function SideVerdict({ verdict, color }: { verdict: string; color: 'purple' | 'cyan' | 'red' }) {
  if (verdict === 'P') {
    return (
      <span className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider" style={{ color: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.3)' }}>
        P
      </span>
    );
  }
  if (verdict === 'B') {
    return (
      <span className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider" style={{ color: '#f87171', backgroundColor: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)' }}>
        B
      </span>
    );
  }
  return (
    <span className="text-xs font-bold px-2 py-0.5 rounded-sm" style={{ color: '#52525b', border: '1px solid rgba(255,255,255,0.07)' }}>
      WAIT
    </span>
  );
}

export default function DashboardPage() {
  const [, setLocation] = useLocation();
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);

  const me = useGetMe();
  const initialSnapshot = useGetSnapshot();
  const submitInput = useSubmitInput();
  const undoInput = useUndoInput();
  const resetGame = useResetGame();
  const setWindow = useSetWindow();
  const logout = useLogout();

  // Auth guard
  useEffect(() => {
    if (me.isError) {
      setLocation('/login');
    }
  }, [me.isError, setLocation]);

  // Load initial snapshot
  useEffect(() => {
    if (initialSnapshot.data && !snapshot) {
      setSnapshot(initialSnapshot.data);
    }
  }, [initialSnapshot.data, snapshot]);

  const isMutating =
    submitInput.isPending ||
    undoInput.isPending ||
    resetGame.isPending ||
    setWindow.isPending;

  function handleInput(value: 'P' | 'B' | 'T') {
    submitInput.mutate(
      { data: { value } },
      { onSuccess: (d) => setSnapshot(d) }
    );
  }

  function handleUndo() {
    undoInput.mutate(undefined, { onSuccess: (d) => setSnapshot(d) });
  }

  function handleReset() {
    if (!window.confirm('Reset the entire shoe? This cannot be undone.')) return;
    resetGame.mutate(undefined, { onSuccess: (d) => setSnapshot(d) });
  }

  function handleWindowChange(w: number) {
    setWindow.mutate(
      { data: { window: w } },
      { onSuccess: (d) => setSnapshot(d) }
    );
  }

  function handleLogout() {
    logout.mutate(undefined, {
      onSuccess: () => setLocation('/login'),
      onError: () => setLocation('/login'),
    });
  }

  const regime = snapshot?.regime;
  const activeWindow = regime?.window ?? 8;

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: '#060609', fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* TOP BAR */}
      <header
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{
          backgroundColor: '#0d0d14',
          borderColor: 'rgba(255,255,255,0.08)',
        }}
      >
        <span
          className="text-sm font-bold tracking-wider"
          style={{ color: '#22d3ee' }}
          data-testid="app-title"
        >
          ⚡ META-EXPERT REGIME TRACKER
        </span>
        <div className="flex items-center gap-3">
          {me.data && (
            <span className="text-xs" style={{ color: '#71717a' }} data-testid="username-display">
              {me.data.username}
            </span>
          )}
          <button
            data-testid="btn-logout"
            onClick={handleLogout}
            className="text-xs px-3 py-1 rounded-sm tracking-wider transition-all active:scale-95"
            style={{
              color: '#71717a',
              border: '1px solid rgba(255,255,255,0.12)',
              backgroundColor: 'transparent',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#e2e8f0';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#71717a';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
            }}
          >
            LOGOUT
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col max-w-lg mx-auto w-full px-4 py-4 gap-4">
        {/* HAND COUNTER + WINDOW SELECTOR */}
        <div
          className="rounded-sm p-4 border"
          style={{
            backgroundColor: '#0d0d14',
            borderColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <div>
              <div
                className="text-2xl font-black tracking-wider"
                style={{ color: '#e2e8f0' }}
                data-testid="hand-count"
              >
                HAND #{snapshot?.handCount ?? 0}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <span className="text-xs tracking-widest" style={{ color: '#71717a' }}>
                ROLLING WINDOW
              </span>
              <div className="flex gap-2">
                {[8, 12, 16].map((w) => (
                  <button
                    key={w}
                    data-testid={`btn-window-${w}`}
                    onClick={() => handleWindowChange(w)}
                    disabled={isMutating}
                    className="px-3 py-1 rounded-sm text-sm font-bold tracking-wider transition-all active:scale-95"
                    style={{
                      border: activeWindow === w
                        ? '2px solid #22d3ee'
                        : '1px solid rgba(255,255,255,0.12)',
                      color: activeWindow === w ? '#22d3ee' : '#71717a',
                      backgroundColor: activeWindow === w
                        ? 'rgba(34,211,238,0.1)'
                        : 'transparent',
                      cursor: isMutating ? 'not-allowed' : 'pointer',
                      boxShadow: activeWindow === w
                        ? '0 0 8px rgba(34,211,238,0.2)'
                        : 'none',
                    }}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* MAIN PANEL */}
        {regime && (
          <div
            className="rounded-sm border flex flex-col gap-5 p-4"
            style={{
              backgroundColor: '#0d0d14',
              borderColor: 'rgba(255,255,255,0.08)',
            }}
          >
            {/* Status */}
            <div className="flex items-center justify-between">
              <StatusBadge status={regime.status} />
              <span className="text-xs" style={{ color: '#71717a' }}>
                {snapshot?.history.length ?? 0} hands logged
              </span>
            </div>

            {/* Expert scores */}
            <div className="grid grid-cols-2 gap-4">
              {/* SUPREME */}
              <div className="flex flex-col gap-2">
                <div
                  className="text-xs font-bold tracking-wider"
                  style={{ color: '#a855f7' }}
                >
                  SUPREME BAYESIAN
                </div>
                <div
                  className="w-full h-1.5 rounded-full overflow-hidden"
                  style={{ backgroundColor: 'rgba(168,85,247,0.15)' }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.round((regime.supreme.wwr || 0) * 100)}%`,
                      backgroundColor: '#a855f7',
                      boxShadow: '0 0 6px rgba(168,85,247,0.5)',
                    }}
                  />
                </div>
                <div className="flex justify-between items-center">
                  <span
                    className="text-sm font-bold"
                    style={{ color: '#a855f7' }}
                    data-testid="supreme-pct"
                  >
                    {(regime.supreme.wwr * 100).toFixed(1)}%
                  </span>
                  <span className="text-xs" style={{ color: '#71717a' }} data-testid="supreme-count">
                    {regime.supreme.predCount} hands
                  </span>
                </div>
              </div>

              {/* SYNDICATE */}
              <div className="flex flex-col gap-2">
                <div
                  className="text-xs font-bold tracking-wider"
                  style={{ color: '#38bdf8' }}
                >
                  SYNDICATE B2B
                </div>
                <div
                  className="w-full h-1.5 rounded-full overflow-hidden"
                  style={{ backgroundColor: 'rgba(56,189,248,0.15)' }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.round((regime.syndicate.wwr || 0) * 100)}%`,
                      backgroundColor: '#38bdf8',
                      boxShadow: '0 0 6px rgba(56,189,248,0.5)',
                    }}
                  />
                </div>
                <div className="flex justify-between items-center">
                  <span
                    className="text-sm font-bold"
                    style={{ color: '#38bdf8' }}
                    data-testid="syndicate-pct"
                  >
                    {(regime.syndicate.wwr * 100).toFixed(1)}%
                  </span>
                  <span className="text-xs" style={{ color: '#71717a' }} data-testid="syndicate-count">
                    {regime.syndicate.predCount} hands
                  </span>
                </div>
              </div>
            </div>

            {/* Both Agree Banner */}
            {regime.bothAgree && (
              <div
                className="text-center py-2 px-4 rounded-sm font-bold tracking-wider text-sm"
                style={{
                  color: '#eab308',
                  backgroundColor: 'rgba(234,179,8,0.1)',
                  border: '1px solid rgba(234,179,8,0.4)',
                  boxShadow: '0 0 12px rgba(234,179,8,0.15)',
                }}
                data-testid="both-agree-banner"
              >
                ⚡ BOTH AGREE — BET{' '}
                {regime.bothAgreeSide === 'P'
                  ? 'PLAYER'
                  : regime.bothAgreeSide === 'B'
                  ? 'BANKER'
                  : regime.decision === 'P'
                  ? 'PLAYER'
                  : 'BANKER'}
              </div>
            )}

            {/* MAIN DECISION */}
            <div className="flex flex-col items-center gap-2 py-4">
              {regime.decision === 'P' && (
                <>
                  <div
                    className="text-6xl font-black tracking-wider"
                    style={{
                      color: '#22d3ee',
                      textShadow:
                        '0 0 20px rgba(34,211,238,0.7), 0 0 40px rgba(34,211,238,0.4), 0 0 80px rgba(34,211,238,0.2)',
                    }}
                    data-testid="decision-display"
                  >
                    PLAYER
                  </div>
                  <div
                    className="text-xs tracking-wider"
                    style={{
                      color: regime.expert === 'supreme' ? '#a855f7' : '#38bdf8',
                    }}
                    data-testid="following-label"
                  >
                    Following{' '}
                    {regime.expert === 'supreme' ? 'SUPREME' : 'SYNDICATE'}
                  </div>
                </>
              )}
              {regime.decision === 'B' && (
                <>
                  <div
                    className="text-6xl font-black tracking-wider"
                    style={{
                      color: '#f87171',
                      textShadow:
                        '0 0 20px rgba(248,113,113,0.7), 0 0 40px rgba(248,113,113,0.4), 0 0 80px rgba(248,113,113,0.2)',
                    }}
                    data-testid="decision-display"
                  >
                    BANKER
                  </div>
                  <div
                    className="text-xs tracking-wider"
                    style={{
                      color: regime.expert === 'supreme' ? '#a855f7' : '#38bdf8',
                    }}
                    data-testid="following-label"
                  >
                    Following{' '}
                    {regime.expert === 'supreme' ? 'SUPREME' : 'SYNDICATE'}
                  </div>
                </>
              )}
              {!regime.decision && (
                <div
                  className="text-4xl font-black tracking-wider"
                  style={{ color: '#71717a' }}
                  data-testid="decision-display"
                >
                  — WAIT —
                </div>
              )}
            </div>

            {/* Badge Row */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Expert badge */}
              {regime.expert === 'supreme' && (
                <span
                  className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider"
                  style={{
                    color: '#a855f7',
                    backgroundColor: 'rgba(168,85,247,0.1)',
                    border: '1px solid rgba(168,85,247,0.3)',
                  }}
                  data-testid="badge-expert"
                >
                  SUPREME
                </span>
              )}
              {regime.expert === 'syndicate' && (
                <span
                  className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider"
                  style={{
                    color: '#38bdf8',
                    backgroundColor: 'rgba(56,189,248,0.1)',
                    border: '1px solid rgba(56,189,248,0.3)',
                  }}
                  data-testid="badge-expert"
                >
                  SYNDICATE
                </span>
              )}
              {!regime.expert && (
                <span
                  className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider"
                  style={{
                    color: '#71717a',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                  data-testid="badge-expert"
                >
                  NONE
                </span>
              )}

              {/* Confidence badge */}
              <ConfidenceBadge confidence={regime.confidence} />

              {/* Age */}
              <span
                className="text-xs px-2 py-0.5"
                style={{ color: '#71717a' }}
                data-testid="badge-age"
              >
                Age: {regime.regimeAge}h
              </span>

              {/* Switch count */}
              <span
                className="text-xs px-2 py-0.5"
                style={{ color: '#71717a' }}
                data-testid="badge-sw"
              >
                Sw: {regime.switchCount}
              </span>

              {/* Locked */}
              {regime.isLocked && (
                <span
                  className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider"
                  style={{
                    color: '#eab308',
                    backgroundColor: 'rgba(234,179,8,0.1)',
                    border: '1px solid rgba(234,179,8,0.3)',
                  }}
                  data-testid="badge-locked"
                >
                  🔒 LOCKED
                </span>
              )}
            </div>
          </div>
        )}

        {/* Loading state */}
        {!regime && !initialSnapshot.isError && (
          <div
            className="rounded-sm border p-8 text-center"
            style={{
              backgroundColor: '#0d0d14',
              borderColor: 'rgba(255,255,255,0.08)',
              color: '#71717a',
            }}
          >
            <div className="text-sm tracking-wider">LOADING REGIME DATA...</div>
          </div>
        )}

        {/* INPUT AREA */}
        <div
          className="rounded-sm border p-4 flex flex-col gap-3"
          style={{
            backgroundColor: '#0d0d14',
            borderColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <div className="text-xs tracking-widest mb-1" style={{ color: '#71717a' }}>
            RECORD OUTCOME
          </div>
          {/* P B T buttons */}
          <div className="grid grid-cols-3 gap-3">
            <button
              data-testid="btn-player"
              onClick={() => handleInput('P')}
              disabled={isMutating}
              className="py-5 font-black text-2xl rounded-sm transition-all active:scale-95"
              style={{
                border: '2px solid #22d3ee',
                backgroundColor: 'rgba(34,211,238,0.08)',
                color: '#22d3ee',
                cursor: isMutating ? 'not-allowed' : 'pointer',
                opacity: isMutating ? 0.5 : 1,
                fontFamily: "'JetBrains Mono', monospace",
                boxShadow: isMutating ? 'none' : '0 0 12px rgba(34,211,238,0.15)',
              }}
            >
              P
            </button>
            <button
              data-testid="btn-banker"
              onClick={() => handleInput('B')}
              disabled={isMutating}
              className="py-5 font-black text-2xl rounded-sm transition-all active:scale-95"
              style={{
                border: '2px solid #f87171',
                backgroundColor: 'rgba(248,113,113,0.08)',
                color: '#f87171',
                cursor: isMutating ? 'not-allowed' : 'pointer',
                opacity: isMutating ? 0.5 : 1,
                fontFamily: "'JetBrains Mono', monospace",
                boxShadow: isMutating ? 'none' : '0 0 12px rgba(248,113,113,0.15)',
              }}
            >
              B
            </button>
            <button
              data-testid="btn-tie"
              onClick={() => handleInput('T')}
              disabled={isMutating}
              className="py-5 font-black text-2xl rounded-sm transition-all active:scale-95"
              style={{
                border: '2px solid #4ade80',
                backgroundColor: 'rgba(74,222,128,0.08)',
                color: '#4ade80',
                cursor: isMutating ? 'not-allowed' : 'pointer',
                opacity: isMutating ? 0.5 : 1,
                fontFamily: "'JetBrains Mono', monospace",
                boxShadow: isMutating ? 'none' : '0 0 12px rgba(74,222,128,0.15)',
              }}
            >
              T
            </button>
          </div>

          {/* UNDO / RESET */}
          <div className="grid grid-cols-2 gap-3">
            <button
              data-testid="btn-undo"
              onClick={handleUndo}
              disabled={isMutating}
              className="py-2 text-sm rounded-sm tracking-wider transition-all active:scale-95"
              style={{
                border: '1px solid rgba(255,255,255,0.18)',
                color: 'rgba(255,255,255,0.5)',
                backgroundColor: 'transparent',
                cursor: isMutating ? 'not-allowed' : 'pointer',
                opacity: isMutating ? 0.5 : 1,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              UNDO
            </button>
            <button
              data-testid="btn-reset"
              onClick={handleReset}
              disabled={isMutating}
              className="py-2 text-sm rounded-sm tracking-wider transition-all active:scale-95"
              style={{
                border: '1px solid rgba(248,113,113,0.28)',
                color: 'rgba(248,113,113,0.7)',
                backgroundColor: 'transparent',
                cursor: isMutating ? 'not-allowed' : 'pointer',
                opacity: isMutating ? 0.5 : 1,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              RESET
            </button>
          </div>
        </div>

        {/* META AI / LOOK-AHEAD / OBSERVER PANEL */}
        {snapshot && (
          <div
            className="rounded-sm border flex flex-col gap-0 overflow-hidden"
            style={{
              backgroundColor: '#0d0d14',
              borderColor: 'rgba(176,0,255,0.25)',
            }}
          >
            {/* Section header */}
            <div
              className="px-4 py-2 flex items-center justify-between"
              style={{
                borderBottom: '1px solid rgba(176,0,255,0.15)',
                backgroundColor: 'rgba(176,0,255,0.04)',
              }}
            >
              <span
                className="text-xs font-bold tracking-widest"
                style={{ color: '#b000ff' }}
              >
                ◈ META AI PANEL
              </span>
              <span className="text-xs" style={{ color: '#52525b' }}>
                Self-Learning Layer
              </span>
            </div>

            <div className="flex flex-col gap-0 divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>

              {/* LOOK-AHEAD ROW */}
              <div className="px-4 py-3 flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs tracking-widest" style={{ color: '#71717a' }}>
                    LOOK-AHEAD
                  </span>
                  <span className="text-xs" style={{ color: '#52525b' }}>
                    {snapshot.lookAhead.active
                      ? `bias ${snapshot.lookAhead.bias >= 0 ? '+' : ''}${snapshot.lookAhead.bias.toFixed(3)}  ·  P:${snapshot.lookAhead.avgP.toFixed(3)}  B:${snapshot.lookAhead.avgB.toFixed(3)}`
                      : 'warming up — need 6+ hands'}
                  </span>
                </div>
                <LookAheadBadge la={snapshot.lookAhead} />
              </div>

              {/* META AI ROW */}
              <div className="px-4 py-3 flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs tracking-widest" style={{ color: '#71717a' }}>
                    META AI
                  </span>
                  <span className="text-xs" style={{ color: '#52525b' }}>
                    {snapshot.metaAI.seen === 0
                      ? 'no samples yet'
                      : `${snapshot.metaAI.seen} samples · acc ${
                          snapshot.metaAI.accuracy !== null
                            ? `${Math.round(snapshot.metaAI.accuracy * 100)}%`
                            : '--'
                        }  ·  P̂ ${(snapshot.metaAI.pPlayer * 100).toFixed(1)}%`}
                  </span>
                </div>
                <SideVerdict verdict={snapshot.metaAI.decision} color="purple" />
              </div>

              {/* OBSERVER ROW */}
              <div className="px-4 py-3 flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs tracking-widest" style={{ color: '#71717a' }}>
                    OBSERVER
                  </span>
                  <span className="text-xs" style={{ color: '#52525b' }}>
                    {snapshot.observer.reasoning}
                    {snapshot.observer.wr !== null
                      ? ` (${Math.round(snapshot.observer.wr * 100)}% WR)`
                      : ''}
                  </span>
                </div>
                <SideVerdict verdict={snapshot.observer.decision} color="purple" />
              </div>

            </div>
          </div>
        )}

        {/* History strip */}
        {snapshot && snapshot.history.length > 0 && (
          <div
            className="rounded-sm border p-3"
            style={{
              backgroundColor: '#0d0d14',
              borderColor: 'rgba(255,255,255,0.08)',
            }}
          >
            <div className="text-xs tracking-widest mb-2" style={{ color: '#71717a' }}>
              HISTORY (last 20)
            </div>
            <div className="flex flex-wrap gap-1">
              {snapshot.history.slice(-20).map((h, i) => (
                <span
                  key={i}
                  className="text-xs font-bold w-6 h-6 flex items-center justify-center rounded-sm"
                  style={{
                    color:
                      h === 'P' ? '#22d3ee' : h === 'B' ? '#f87171' : '#4ade80',
                    backgroundColor:
                      h === 'P'
                        ? 'rgba(34,211,238,0.12)'
                        : h === 'B'
                        ? 'rgba(248,113,113,0.12)'
                        : 'rgba(74,222,128,0.12)',
                    border:
                      h === 'P'
                        ? '1px solid rgba(34,211,238,0.25)'
                        : h === 'B'
                        ? '1px solid rgba(248,113,113,0.25)'
                        : '1px solid rgba(74,222,128,0.25)',
                  }}
                >
                  {h}
                </span>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

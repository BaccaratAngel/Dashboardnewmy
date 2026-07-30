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
  useHeartbeat,
} from '@workspace/api-client-react';
import type { GameSnapshot, ExpertStats, CrisisAIResult, MetaCombinerResult, RaceState, RaceContestantStats, RegimeState, OracleResult } from '@workspace/api-client-react';
import { cn } from '@/lib/utils';

// ── Color & label helpers ─────────────────────────────────────────────────────

const EXPERT_META: Record<string, { label: string; shortLabel: string; color: string }> = {
  // Core 6
  supreme:          { label: 'SUPREME BAYESIAN', shortLabel: 'SUPREME',   color: '#a855f7' },
  syndicate:        { label: 'SYNDICATE B2B',    shortLabel: 'SYNDICATE', color: '#38bdf8' },
  lookAhead:        { label: 'LOOK-AHEAD v1',    shortLabel: 'LA v1',     color: '#22d3ee' },
  legacyLookAhead:  { label: 'LOOK-AHEAD v2',    shortLabel: 'LA v2',     color: '#fb923c' },
  metaAI:           { label: 'META AI',           shortLabel: 'META AI',   color: '#c084fc' },
  observer:         { label: 'OBSERVER',          shortLabel: 'OBSERVER',  color: '#4ade80' },
  // Road 4
  bebRoad:          { label: 'BIG EYE BOY',       shortLabel: 'BEB',       color: '#f43f5e' },
  smallRoad:        { label: 'SMALL ROAD',        shortLabel: 'SM ROAD',   color: '#e879f9' },
  cockroachRoad:    { label: 'COCKROACH ROAD',    shortLabel: 'COCKROACH', color: '#f97316' },
  dualAuth:         { label: 'DUAL-AUTH ENGINE',  shortLabel: 'DUAL-AUTH', color: '#facc15' },
  // Strategy Bots 1–11 (Syndicate individual bots)
  bot1:  { label: 'BOT 1 — ALWAYS B',       shortLabel: 'BOT 1',  color: '#64748b' },
  bot2:  { label: 'BOT 2 — ALWAYS P',       shortLabel: 'BOT 2',  color: '#94a3b8' },
  bot3:  { label: 'BOT 3 — ALT BP (even)',  shortLabel: 'BOT 3',  color: '#7dd3fc' },
  bot4:  { label: 'BOT 4 — ALT PB (even)',  shortLabel: 'BOT 4',  color: '#93c5fd' },
  bot5:  { label: 'BOT 5 — BBPP cycle',     shortLabel: 'BOT 5',  color: '#6ee7b7' },
  bot6:  { label: 'BOT 6 — ANTI-LAST',      shortLabel: 'BOT 6',  color: '#fcd34d' },
  bot7:  { label: 'BOT 7 — FOLLOW-LAST',    shortLabel: 'BOT 7',  color: '#f9a8d4' },
  bot8:  { label: 'BOT 8 — BBB/PPP cycle',  shortLabel: 'BOT 8',  color: '#c4b5fd' },
  bot9:  { label: 'BOT 9 — BPP/PBB cycle',  shortLabel: 'BOT 9',  color: '#fdba74' },
  bot10: { label: 'BOT 10 — BBPPP cycle',   shortLabel: 'BOT 10', color: '#86efac' },
  bot11: { label: 'BOT 11 — BPPP cycle',    shortLabel: 'BOT 11', color: '#67e8f9' },
};

function expertColor(key: string): string {
  const base = key.split('+')[0];
  return EXPERT_META[base]?.color ?? '#71717a';
}
function expertLabel(key: string): string {
  const base = key.split('+')[0];
  return EXPERT_META[base]?.shortLabel ?? key.toUpperCase();
}

// ── Small reusable components ─────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { color: string; bg: string }> = {
    WARMING_UP: { color: '#eab308', bg: 'rgba(234,179,8,0.1)' },
    TRACKING:   { color: '#22d3ee', bg: 'rgba(34,211,238,0.1)' },
    SPLIT:      { color: '#fb923c', bg: 'rgba(251,146,60,0.1)' },
  };
  const s = map[status] ?? { color: '#71717a', bg: 'transparent' };
  return (
    <span className="text-xs font-bold tracking-widest px-3 py-1 rounded-sm"
      style={{ color: s.color, backgroundColor: s.bg, border: `1px solid ${s.color}40` }}>
      {status.replace('_', ' ')}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const map: Record<string, { color: string; bg: string }> = {
    HIGH: { color: '#4ade80', bg: 'rgba(74,222,128,0.1)' },
    MED:  { color: '#facc15', bg: 'rgba(250,204,21,0.1)' },
    LOW:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
    NONE: { color: '#71717a', bg: 'transparent' },
  };
  const s = map[confidence] ?? map.NONE;
  return (
    <span className="text-xs font-bold tracking-wider px-2 py-0.5 rounded-sm"
      style={{ color: s.color, backgroundColor: s.bg, border: `1px solid ${s.color}40` }}>
      {confidence}
    </span>
  );
}

function SidePill({ pred }: { pred: string | null }) {
  if (pred === 'P') return (
    <span className="text-xs font-bold px-1.5 py-0.5 rounded-sm"
      style={{ color: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.12)', border: '1px solid rgba(34,211,238,0.35)' }}>
      P
    </span>
  );
  if (pred === 'B') return (
    <span className="text-xs font-bold px-1.5 py-0.5 rounded-sm"
      style={{ color: '#f87171', backgroundColor: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.35)' }}>
      B
    </span>
  );
  return (
    <span className="text-xs font-bold px-1.5 py-0.5 rounded-sm"
      style={{ color: '#52525b', border: '1px solid rgba(255,255,255,0.07)' }}>
      —
    </span>
  );
}

function SideVerdict({ verdict }: { verdict: string }) {
  return <SidePill pred={verdict === 'P' || verdict === 'B' ? verdict : null} />;
}

// ── Expert row (regime tracker) ───────────────────────────────────────────────

function ExpertRow({
  expertKey,
  stats,
  isActive,
  isShadow,
}: {
  expertKey: string;
  stats: ExpertStats;
  isActive: boolean;
  isShadow?: boolean;
}) {
  const meta = EXPERT_META[expertKey] ?? { label: expertKey.toUpperCase(), shortLabel: expertKey, color: '#71717a' };
  const color = meta.color;
  const pct = (stats.compositeScore * 100).toFixed(1);
  const wwrPct = (stats.wwr * 100).toFixed(1);
  const delta = stats.wwrDelta * 100;
  const deltaStr = delta >= 0.05 ? `+${delta.toFixed(1)}` : delta <= -0.05 ? delta.toFixed(1) : '±0';
  const deltaColor = delta >= 0.05 ? '#4ade80' : delta <= -0.05 ? '#f87171' : '#52525b';
  const arrowChar = stats.momentum === 'up' ? '↑' : stats.momentum === 'down' ? '↓' : '→';
  const arrowColor = stats.momentum === 'up' ? '#4ade80' : stats.momentum === 'down' ? '#f87171' : '#52525b';

  // Streak profile display
  const runIcon = stats.currentRunIsWin === true ? '▲' : stats.currentRunIsWin === false ? '▼' : '';
  const runColor = stats.currentRunIsWin === true ? '#4ade80' : stats.currentRunIsWin === false ? '#f87171' : '#52525b';

  // Shoe W/L record from raw win rate × pred count
  const shoeW = stats.predCount > 0 ? Math.round(stats.rawWr * stats.predCount) : 0;
  const shoeL = stats.predCount - shoeW;
  const shoeTotal = stats.predCount;
  const shoeWinPct = shoeTotal > 0 ? Math.round((shoeW / shoeTotal) * 100) : 0;
  const shoeColor = shoeWinPct >= 60 ? '#4ade80' : shoeWinPct >= 50 ? '#facc15' : '#f87171';

  return (
    <div className="flex flex-col gap-1 py-2.5"
      style={{
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        ...(isShadow ? { backgroundColor: `${color}06`, borderLeft: `2px solid ${color}50`, paddingLeft: 6 } : {}),
      }}>
      {/* Row 1: label + badges + arrows */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-bold tracking-wider" style={{ color: isActive ? color : isShadow ? `${color}cc` : `${color}80` }}>
            {meta.label}
          </span>
          {isActive && (
            <span className="text-xs"
              style={{ color: '#eab308', backgroundColor: 'rgba(234,179,8,0.1)', padding: '0 3px', borderRadius: 2, fontSize: 9 }}>
              ★
            </span>
          )}
          {isShadow && !isActive && (
            <span className="text-xs"
              style={{ color, backgroundColor: `${color}18`, padding: '0 3px', borderRadius: 2, fontSize: 9, border: `1px solid ${color}40` }}>
              SHADOW
            </span>
          )}
          <span className="text-xs font-bold" style={{ color: arrowColor }}>{arrowChar}</span>
          {stats.hotStreak && <span style={{ fontSize: 10 }}>🔥</span>}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Streak run indicator */}
          {stats.currentRunLen > 0 && stats.currentRunIsWin !== null && (
            <span className="text-xs tabular-nums font-bold" style={{ color: runColor, fontFamily: 'monospace' }}>
              {runIcon}{stats.currentRunLen}
            </span>
          )}
          <span className="text-xs tabular-nums" style={{ color: deltaColor, fontFamily: 'monospace' }}>
            {deltaStr}%
          </span>
          <SidePill pred={stats.lastPred} />
        </div>
      </div>

      {/* Row 2: shoe W/L record — most prominent decision aid */}
      {shoeTotal > 0 ? (
        <div className="flex items-center gap-2">
          {/* W count */}
          <span className="text-xs font-black tabular-nums" style={{ color: '#4ade80', fontFamily: 'monospace', minWidth: 28 }}>
            {shoeW}W
          </span>
          {/* Mini bar showing win/loss split */}
          <div className="flex-1 h-2 rounded-full overflow-hidden flex" style={{ backgroundColor: '#1c1c1e' }}>
            <div className="h-full transition-all duration-700"
              style={{ width: `${shoeWinPct}%`, backgroundColor: shoeColor, boxShadow: isActive ? `0 0 4px ${shoeColor}80` : 'none' }} />
          </div>
          {/* L count */}
          <span className="text-xs font-black tabular-nums" style={{ color: '#f87171', fontFamily: 'monospace', minWidth: 28, textAlign: 'right' }}>
            {shoeL}L
          </span>
          {/* Win% badge */}
          <span className="text-xs font-bold tabular-nums px-1.5 py-0.5 rounded-sm"
            style={{
              color: shoeColor,
              backgroundColor: `${shoeColor}14`,
              border: `1px solid ${shoeColor}35`,
              fontFamily: 'monospace',
              minWidth: 36,
              textAlign: 'center',
            }}>
            {shoeWinPct}%
          </span>
        </div>
      ) : (
        <div className="text-xs" style={{ color: '#3f3f46', fontFamily: 'monospace' }}>— warming up</div>
      )}

      {/* Row 3: composite score bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1 rounded-full overflow-hidden"
          style={{ backgroundColor: `${color}14` }}>
          <div className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${pct}%`,
              backgroundColor: color,
              boxShadow: isActive ? `0 0 4px ${color}60` : 'none',
            }} />
        </div>
        <span className="text-xs tabular-nums" style={{ color: `${color}70`, fontFamily: 'monospace', fontSize: 9, minWidth: 44, textAlign: 'right' }}>
          COMP {pct}%
        </span>
      </div>

      {/* Row 4: sparkline + run profile */}
      <div className="flex items-center gap-0.5" style={{ minHeight: 14 }}>
        {(stats.sparkline?.length ?? 0) > 0
          ? stats.sparkline.map((hit, i) => (
              <span key={i} style={{ color: hit ? color : '#3f3f46', fontSize: 10, lineHeight: 1 }}>
                {hit ? '●' : '○'}
              </span>
            ))
          : null
        }
        {stats.streak > 1 && (
          <span className="text-xs ml-1.5" style={{ color: '#71717a' }}>
            {stats.streak}×
          </span>
        )}
        {(stats.avgWinRun > 0 || stats.avgLossRun > 0) && (
          <span className="text-xs ml-auto" style={{ color: '#3f3f46', fontFamily: 'monospace', fontSize: 9 }}>
            W{stats.avgWinRun.toFixed(1)}/L{stats.avgLossRun.toFixed(1)}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Lock countdown bar with shadow leader ─────────────────────────────────────

function LockBar({
  lockRemain,
  lockMax,
  shadowLeader,
  shadowLeaderPred,
  shadowLeaderComposite,
  lockAccelerated,
}: {
  lockRemain: number;
  lockMax: number;
  shadowLeader: string | null;
  shadowLeaderPred: string | null;
  shadowLeaderComposite: number;
  lockAccelerated: boolean;
}) {
  const pct = lockMax > 0 ? (lockRemain / lockMax) * 100 : 0;
  const shadowColor = shadowLeader ? expertColor(shadowLeader) : '#71717a';

  return (
    <div className="flex flex-col gap-1.5">
      {/* Accelerated unlock banner */}
      {lockAccelerated && !shadowLeader && (
        <div className="text-center py-1 px-3 rounded-sm text-xs font-bold tracking-wider"
          style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.1)', border: '1px solid rgba(251,146,60,0.35)' }}>
          ⚡ ACCELERATED UNLOCK — Loss run exceeded profile
        </div>
      )}
      {lockAccelerated && shadowLeader && (
        <div className="text-center py-1 px-3 rounded-sm text-xs font-bold tracking-wider"
          style={{ color: '#4ade80', backgroundColor: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.35)' }}>
          ⬆ SHADOW PROMOTED — {expertLabel(shadowLeader)} takes command
        </div>
      )}

      {/* Lock countdown */}
      <div className="flex justify-between items-center">
        <span className="text-xs font-bold tracking-wider" style={{ color: '#eab308' }}>
          🔒 LOCKED
        </span>
        <span className="text-xs tabular-nums" style={{ color: '#eab308' }}>
          {lockRemain}/{lockMax} hands
        </span>
      </div>
      <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(234,179,8,0.15)' }}>
        <div className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: '#eab308', boxShadow: '0 0 4px rgba(234,179,8,0.5)' }} />
      </div>

      {/* Shadow leader */}
      {shadowLeader && (
        <div className="flex items-center justify-between mt-0.5 px-2 py-1.5 rounded-sm"
          style={{ backgroundColor: `${shadowColor}08`, border: `1px solid ${shadowColor}25` }}>
          <div className="flex items-center gap-1.5">
            <span className="text-xs" style={{ color: '#52525b' }}>Shadow leader:</span>
            <span className="text-xs font-bold" style={{ color: shadowColor }}>
              {expertLabel(shadowLeader)}
            </span>
            <span className="text-xs" style={{ color: '#3f3f46' }}>
              ({(shadowLeaderComposite * 100).toFixed(1)}%)
            </span>
          </div>
          <SidePill pred={shadowLeaderPred} />
        </div>
      )}
    </div>
  );
}

// ── Crisis AI Panel ───────────────────────────────────────────────────────────

function CrisisAIPanel({ crisis, race }: { crisis: CrisisAIResult; race?: RaceState }) {
  const { isChampion, isChallenger, stats: raceStats, active: raceActive } = useRaceStatus(race, 'crisisAI');
  const allAgree = race?.allAgree ?? false;

  // Always visible — 4 states: standby (0 losses), monitoring (1 loss), post-crisis (suppressed), active override
  const isActive    = crisis.active;
  const isSuppressed = !crisis.active && crisis.consecutiveLosses >= 2;
  const isMonitoring = !crisis.active && crisis.consecutiveLosses === 1;

  const predColor   = crisis.prediction === 'P' ? '#22d3ee' : crisis.prediction === 'B' ? '#f87171' : '#71717a';
  const confColor   = crisis.confidence === 'HIGH' ? '#4ade80' : crisis.confidence === 'MED' ? '#facc15' : '#fb923c';
  const bgPredColor = crisis.backgroundPrediction === 'P' ? '#22d3ee' : crisis.backgroundPrediction === 'B' ? '#f87171' : '#71717a';

  const headerLabel = isActive
    ? '⚠ CRISIS AI — RECOVERY OVERRIDE'
    : isMonitoring
    ? '◈ CRISIS AI MONITOR'
    : isSuppressed
    ? '◈ CRISIS AI — MONITORING'
    : '◈ CRISIS AI — STANDBY';

  const baseBorder = isActive ? 'rgba(251,146,60,0.6)' : 'rgba(251,146,60,0.2)';
  const baseShadow = isActive ? '0 0 16px rgba(251,146,60,0.15)' : 'none';
  const containerExtra = raceContainerStyle(isChampion, isChallenger, allAgree, baseBorder, baseShadow);

  return (
    <div className="rounded-sm border flex flex-col overflow-hidden transition-all duration-500"
      style={{ backgroundColor: '#120a00', ...containerExtra }}>

      {/* Header */}
      <div className="px-4 py-2 flex items-center justify-between"
        style={{
          borderBottom: '1px solid rgba(251,146,60,0.2)',
          backgroundColor: isActive ? 'rgba(251,146,60,0.08)' : isChampion ? 'rgba(251,146,60,0.05)' : 'rgba(251,146,60,0.02)',
        }}>
        <span className="text-xs font-bold tracking-widest"
          style={{ color: isActive || isChampion ? '#fb923c' : 'rgba(251,146,60,0.5)' }}>
          {headerLabel}
        </span>
        <div className="flex items-center gap-2">
          {raceActive ? (
            <RaceAccuracyBadge
              stats={raceStats}
              isChampion={isChampion}
              isChallenger={isChallenger}
              championStreak={race?.championStreak ?? 0}
              allAgree={allAgree}
            />
          ) : crisis.consecutiveLosses > 0 ? (
            <span className="text-xs font-bold tabular-nums px-2 py-0.5 rounded-sm"
              style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.12)', border: '1px solid rgba(251,146,60,0.3)' }}>
              {crisis.consecutiveLosses}× LOSS STREAK
            </span>
          ) : null}
          {raceActive && crisis.consecutiveLosses > 0 && (
            <span className="text-xs font-bold tabular-nums px-1.5 py-0.5 rounded-sm"
              style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.12)', border: '1px solid rgba(251,146,60,0.3)' }}>
              {crisis.consecutiveLosses}×
            </span>
          )}
        </div>
      </div>

      {isActive ? (
        /* ── Active: full recovery override panel ── */
        <div className="flex flex-col gap-3 px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs tracking-widest" style={{ color: '#71717a' }}>RECOVERY OVERRIDE</span>
              <span className="text-xs" style={{ color: '#52525b' }}>
                {crisis.reasoning || 'Analysing pattern…'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold px-1.5 py-0.5 rounded-sm"
                style={{ color: confColor, backgroundColor: `${confColor}15`, border: `1px solid ${confColor}40` }}>
                {crisis.confidence}
              </span>
              {crisis.prediction ? (
                <span className="text-2xl font-black tracking-wider"
                  style={{ color: predColor, textShadow: `0 0 12px ${predColor}60` }}>
                  {crisis.prediction === 'P' ? 'PLAYER' : 'BANKER'}
                </span>
              ) : (
                <span className="text-lg font-black" style={{ color: '#71717a' }}>WAIT</span>
              )}
            </div>
          </div>

          {crisis.bgLearning && (
            <div className="flex items-start gap-2 px-2 py-1.5 rounded-sm"
              style={{ backgroundColor: 'rgba(251,146,60,0.04)', border: '1px solid rgba(251,146,60,0.1)' }}>
              <span className="text-xs shrink-0" style={{ color: 'rgba(251,146,60,0.4)' }}>◎</span>
              <span className="text-xs leading-relaxed" style={{ color: 'rgba(251,146,60,0.5)' }}>
                {crisis.bgLearning}
              </span>
            </div>
          )}

          <div className="text-xs text-center py-1 rounded-sm"
            style={{ color: 'rgba(251,146,60,0.4)', backgroundColor: 'rgba(251,146,60,0.03)', border: '1px solid rgba(251,146,60,0.1)' }}>
            Activates after 2 consecutive losses · closes on correct prediction · re-opens on 2 more losses
          </div>
        </div>
      ) : (
        /* ── Inactive: standby / 1-loss monitor / post-crisis monitor ── */
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: '#3f3f46' }}>
              {isSuppressed
                ? 'Streak resolved · watching for renewal · re-opens on 2 more losses'
                : isMonitoring
                ? 'Monitoring · 1 loss · activates on next loss'
                : 'Standby · no streak · activates at 2 consecutive losses'}
            </span>
            {crisis.backgroundPrediction && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs" style={{ color: '#3f3f46' }}>BG</span>
                <span className="text-xs font-bold px-1.5 py-0.5 rounded-sm"
                  style={{ color: bgPredColor, backgroundColor: `${bgPredColor}12`, border: `1px solid ${bgPredColor}30` }}>
                  {crisis.backgroundPrediction}
                </span>
              </div>
            )}
          </div>
          {crisis.bgLearning && (
            <span className="text-xs" style={{ color: '#3f3f46', fontStyle: 'italic' }}>
              {crisis.bgLearning}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Look-ahead display row ────────────────────────────────────────────────────

function LookAheadRow({
  label,
  la,
  color,
  depth,
}: {
  label: string;
  la: { active: boolean; verdict: string | null; bias: number; avgP: number; avgB: number; recentAcc: number | null };
  color: string;
  depth: string;
}) {
  return (
    <div className="px-4 py-3 flex items-center justify-between">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-xs tracking-widest" style={{ color: '#71717a' }}>{label}</span>
          <span className="text-xs px-1.5 py-0 rounded-sm"
            style={{ color, backgroundColor: `${color}12`, border: `1px solid ${color}25`, fontSize: 9 }}>
            {depth}
          </span>
        </div>
        <span className="text-xs" style={{ color: '#52525b' }}>
          {la.active
            ? `bias ${la.bias >= 0 ? '+' : ''}${la.bias.toFixed(3)}  ·  P:${la.avgP.toFixed(3)}  B:${la.avgB.toFixed(3)}`
            : `warming up — need ${depth === 'depth-1' ? '6' : '8'}+ hands`}
        </span>
      </div>
      {la.active && la.verdict ? (
        la.verdict === 'P' ? (
          <span className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider"
            style={{ color: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.3)' }}>
            PLAYER ▲
          </span>
        ) : (
          <span className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider"
            style={{ color: '#f87171', backgroundColor: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)' }}>
            BANKER ▲
          </span>
        )
      ) : (
        <span className="text-xs font-bold px-2 py-0.5 rounded-sm"
          style={{ color: '#52525b', border: '1px solid rgba(255,255,255,0.07)' }}>
          --
        </span>
      )}
    </div>
  );
}

// ── Observer sub-system row ───────────────────────────────────────────────────

function SubSystemRow({
  label,
  color,
  winRate,
  total,
  lastPred,
}: {
  label: string;
  color: string;
  winRate: number;
  total: number;
  lastPred: string | null;
}) {
  const pct = total > 0 ? Math.round(winRate * 100) : null;
  return (
    <div className="px-4 py-2 flex items-center justify-between">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs tracking-widest" style={{ color: '#71717a' }}>{label}</span>
        <span className="text-xs" style={{ color: '#52525b' }}>
          {total > 0 ? `${total} tracked · ${pct}% WR` : 'no data yet'}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {pct !== null && (
          <div className="w-14 h-1 rounded-full overflow-hidden" style={{ backgroundColor: `${color}18` }}>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
          </div>
        )}
        <SidePill pred={lastPred} />
      </div>
    </div>
  );
}

// ── Expert group section header ───────────────────────────────────────────────

function ExpertGroupHeader({ label, color }: { label: string; color: string }) {
  return (
    <div className="px-0 pt-2 pb-1 flex items-center gap-2">
      <div className="h-px flex-1" style={{ backgroundColor: `${color}25` }} />
      <span className="text-xs tracking-widest font-bold" style={{ color: `${color}80`, fontSize: 9 }}>
        {label}
      </span>
      <div className="h-px flex-1" style={{ backgroundColor: `${color}25` }} />
    </div>
  );
}

// ── Race helpers ──────────────────────────────────────────────────────────────

type RaceKey = 'metaCombiner' | 'crisisAI' | 'ensemble';

function useRaceStatus(race: RaceState | undefined, key: RaceKey) {
  if (!race?.active) return { isChampion: false, isChallenger: false, stats: race?.[key] as RaceContestantStats | undefined, active: false };
  const stats = race[key] as RaceContestantStats;
  const isChampion = race.champion === key;
  const champAcc = race.champion ? (race[race.champion as RaceKey] as RaceContestantStats).rollingAccuracy : null;
  const myAcc = stats.rollingAccuracy;
  const isChallenger = !isChampion
    && myAcc !== null && myAcc !== undefined
    && champAcc !== null && champAcc !== undefined
    && (champAcc - myAcc) <= 0.05 && myAcc > 0;
  return { isChampion, isChallenger, stats, active: true };
}

function RaceAccuracyBadge({ stats, isChampion, isChallenger, championStreak, allAgree }: {
  stats: RaceContestantStats | undefined;
  isChampion: boolean;
  isChallenger: boolean;
  championStreak: number;
  allAgree: boolean;
}) {
  const acc = stats?.rollingAccuracy;
  const streak = isChampion ? championStreak : (stats?.winStreak ?? 0);

  return (
    <div className="flex items-center gap-1.5">
      {/* Consensus flash */}
      {allAgree && (
        <span className="text-xs font-bold px-1.5 py-0 rounded-sm"
          style={{ color: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.3)', fontSize: 9, animation: 'pulse 1.5s infinite' }}>
          CONSENSUS
        </span>
      )}
      {/* Champion streak */}
      {isChampion && streak > 0 && (
        <span className="text-xs font-bold tabular-nums"
          style={{ color: '#facc15', fontFamily: 'monospace' }}>
          🏆 {streak}×
        </span>
      )}
      {/* Challenger badge */}
      {isChallenger && (
        <span className="text-xs font-bold px-1.5 py-0 rounded-sm"
          style={{ color: '#fb923c', backgroundColor: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.25)', fontSize: 9 }}>
          ⚡ CHALL
        </span>
      )}
      {/* Rolling accuracy */}
      {acc !== null && acc !== undefined ? (
        <span className="text-xs tabular-nums font-bold"
          style={{ color: acc >= 0.60 ? '#4ade80' : acc >= 0.50 ? '#facc15' : '#f87171', fontFamily: 'monospace' }}>
          {Math.round(acc * 100)}%
        </span>
      ) : (
        <span className="text-xs" style={{ color: '#3f3f46', fontFamily: 'monospace' }}>—%</span>
      )}
    </div>
  );
}

function raceContainerStyle(
  isChampion: boolean,
  isChallenger: boolean,
  allAgree: boolean,
  baseBorderColor: string,
  baseBoxShadow: string
): React.CSSProperties {
  let borderColor = baseBorderColor;
  let boxShadow = baseBoxShadow;
  if (isChampion) {
    borderColor = 'rgba(250,204,21,0.85)';
    boxShadow = '0 0 28px rgba(250,204,21,0.28), 0 0 8px rgba(250,204,21,0.55)';
  } else if (isChallenger) {
    borderColor = 'rgba(251,146,60,0.5)';
    boxShadow = '0 0 10px rgba(251,146,60,0.1)';
  }
  if (allAgree) {
    boxShadow = (boxShadow === 'none' ? '' : boxShadow + ', ') + '0 0 16px rgba(34,211,238,0.14)';
  }
  return { borderColor, boxShadow };
}

// ── Ensemble Vote Block ───────────────────────────────────────────────────────

function EnsembleVoteBlock({ regime, race, totalExperts }: {
  regime: RegimeState;
  race?: RaceState;
  totalExperts: number;
}) {
  const { isChampion, isChallenger, stats, active: raceActive } = useRaceStatus(race, 'ensemble');
  const allAgree = race?.allAgree ?? false;
  const containerExtra = raceContainerStyle(isChampion, isChallenger, allAgree, 'rgba(234,179,8,0.35)', 'none');

  return (
    <div className="mx-4 mt-3 mb-2 rounded-sm p-3"
      style={{
        backgroundColor: isChampion ? 'rgba(234,179,8,0.08)' : 'rgba(234,179,8,0.05)',
        border: `1px solid ${containerExtra.borderColor ?? 'rgba(234,179,8,0.15)'}`,
        boxShadow: containerExtra.boxShadow,
        transition: 'border-color 0.4s, box-shadow 0.4s',
      }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold tracking-wider" style={{ color: isChampion ? '#facc15' : '#eab308' }}>
          ⚖ ENSEMBLE VOTE
        </span>
        <div className="flex items-center gap-1.5">
          {raceActive && (
            <RaceAccuracyBadge
              stats={stats}
              isChampion={isChampion}
              isChallenger={isChallenger}
              championStreak={race?.championStreak ?? 0}
              allAgree={allAgree}
            />
          )}
          {regime.agreeCount > 0 && (
            <span className="text-xs" style={{ color: '#71717a' }}>
              {regime.agreeCount}/{totalExperts} agree
            </span>
          )}
          <span className="text-xs font-bold" style={{
            color: regime.ensembleVerdict === 'P' ? '#22d3ee'
              : regime.ensembleVerdict === 'B' ? '#f87171'
              : '#71717a',
          }}>
            {regime.ensembleVerdict === 'P' ? `PLAYER ${regime.ensemblePercent}%`
              : regime.ensembleVerdict === 'B' ? `BANKER ${regime.ensemblePercent}%`
              : 'NO LEAN'}
          </span>
        </div>
      </div>
      <div className="h-2 rounded-full overflow-hidden flex" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}>
        {regime.ensembleVerdict === 'P' && (
          <>
            <div className="h-full rounded-l-full transition-all duration-700"
              style={{ width: `${regime.ensemblePercent}%`, backgroundColor: '#22d3ee', opacity: 0.85 }} />
            <div className="h-full rounded-r-full flex-1" style={{ backgroundColor: '#f87171', opacity: 0.3 }} />
          </>
        )}
        {regime.ensembleVerdict === 'B' && (
          <>
            <div className="h-full rounded-l-full flex-1" style={{ backgroundColor: '#22d3ee', opacity: 0.3 }} />
            <div className="h-full rounded-r-full transition-all duration-700"
              style={{ width: `${regime.ensemblePercent}%`, backgroundColor: '#f87171', opacity: 0.85 }} />
          </>
        )}
        {!regime.ensembleVerdict && (
          <div className="h-full w-full rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }} />
        )}
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-xs" style={{ color: 'rgba(34,211,238,0.5)' }}>P</span>
        <span className="text-xs" style={{ color: 'rgba(248,113,113,0.5)' }}>B</span>
      </div>
    </div>
  );
}

// ── MetaCombiner Panel ────────────────────────────────────────────────────────

function MetaCombinerPanel({ mc, race }: { mc: MetaCombinerResult; race?: RaceState }) {
  const { isChampion, isChallenger, stats, active: raceActive } = useRaceStatus(race, 'metaCombiner');
  const allAgree = race?.allAgree ?? false;

  const predColor =
    mc.prediction === 'P' ? '#22d3ee'
    : mc.prediction === 'B' ? '#f87171'
    : '#52525b';

  const confColor =
    mc.confidence === 'HIGH' ? '#4ade80'
    : mc.confidence === 'MED' ? '#facc15'
    : '#fb923c';

  const pPct = mc.pPlayer * 100;
  const bPct = 100 - pPct;
  const isWarm = mc.seen >= 8;
  const acc = mc.recentAccuracy;

  const baseBorder = mc.prediction !== 'WAIT' ? 'rgba(250,204,21,0.35)' : 'rgba(250,204,21,0.14)';
  const baseShadow = mc.prediction !== 'WAIT' ? '0 0 14px rgba(250,204,21,0.08)' : 'none';
  const containerExtra = raceContainerStyle(isChampion, isChallenger, allAgree, baseBorder, baseShadow);

  return (
    <div className="rounded-sm border flex flex-col overflow-hidden transition-all duration-500"
      style={{ backgroundColor: '#08080f', ...containerExtra }}>

      {/* Header */}
      <div className="px-4 py-2 flex items-center justify-between"
        style={{
          borderBottom: `1px solid ${isChampion ? 'rgba(250,204,21,0.25)' : 'rgba(250,204,21,0.12)'}`,
          backgroundColor: isChampion ? 'rgba(250,204,21,0.06)' : 'rgba(250,204,21,0.03)',
        }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold tracking-widest" style={{ color: isChampion ? '#facc15' : 'rgba(250,204,21,0.75)' }}>
            ◈ META COMBINER
          </span>
          <span className="text-xs px-1.5 py-0 rounded-sm"
            style={{ color: '#facc15', backgroundColor: 'rgba(250,204,21,0.08)', border: '1px solid rgba(250,204,21,0.2)', fontSize: 9 }}>
            ONLINE LR
          </span>
        </div>
        {raceActive ? (
          <RaceAccuracyBadge
            stats={stats}
            isChampion={isChampion}
            isChallenger={isChallenger}
            championStreak={race?.championStreak ?? 0}
            allAgree={allAgree}
          />
        ) : (
          <div className="flex items-center gap-2">
            {isWarm && acc !== null && (
              <span className="text-xs tabular-nums"
                style={{ color: acc >= 0.55 ? '#4ade80' : acc >= 0.48 ? '#facc15' : '#f87171', fontFamily: 'monospace' }}>
                {Math.round(acc * 100)}% acc
              </span>
            )}
            <span className="text-xs" style={{ color: '#3f3f46' }}>
              {mc.seen} hands
            </span>
          </div>
        )}
      </div>

      {/* Warming-up overlay */}
      {!isWarm ? (
        <div className="px-4 py-4 flex flex-col gap-2">
          <div className="text-xs text-center" style={{ color: '#3f3f46' }}>
            Warming up — needs {8 - mc.seen} more hand{8 - mc.seen !== 1 ? 's' : ''} before issuing predictions
          </div>
          <div className="h-0.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(250,204,21,0.08)' }}>
            <div className="h-full rounded-full transition-all duration-700"
              style={{ width: `${(mc.seen / 8) * 100}%`, backgroundColor: '#facc15' }} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3">

          {/* P̂ probability bar */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-xs" style={{ color: '#52525b' }}>
              <span>P {pPct.toFixed(1)}%</span>
              <span>B {bPct.toFixed(1)}%</span>
            </div>
            <div className="h-2 rounded-full overflow-hidden flex" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}>
              <div className="h-full transition-all duration-700"
                style={{ width: `${pPct}%`, backgroundColor: '#22d3ee', opacity: 0.8 }} />
              <div className="h-full flex-1"
                style={{ backgroundColor: '#f87171', opacity: 0.4 }} />
            </div>
          </div>

          {/* Decision + confidence + convergence */}
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-xs tracking-widest" style={{ color: '#71717a' }}>COMBINER</span>
                {mc.prediction !== 'WAIT' && (
                  <span className="text-xs font-bold px-1.5 py-0.5 rounded-sm"
                    style={{ color: confColor, backgroundColor: `${confColor}15`, border: `1px solid ${confColor}40` }}>
                    {mc.confidence}
                  </span>
                )}
              </div>
              {mc.convergenceTotal > 0 && (
                <span className="text-xs" style={{ color: '#52525b' }}>
                  {mc.convergenceCount}/{mc.convergenceTotal} systems agree
                </span>
              )}
            </div>
            {mc.prediction !== 'WAIT' ? (
              <span className="text-xl font-black tracking-wider"
                style={{ color: predColor, textShadow: isChampion ? `0 0 14px ${predColor}80` : `0 0 10px ${predColor}50` }}>
                {mc.prediction === 'P' ? 'PLAYER' : 'BANKER'}
              </span>
            ) : (
              <span className="text-sm font-black" style={{ color: '#3f3f46' }}>— WAIT —</span>
            )}
          </div>

          {/* Top factors */}
          {mc.topFactors.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs" style={{ color: '#3f3f46' }}>Driven by</span>
              {mc.topFactors.map((f, i) => (
                <span key={i} className="text-xs px-1.5 py-0 rounded-sm font-bold"
                  style={{ color: '#facc15', backgroundColor: 'rgba(250,204,21,0.06)', border: '1px solid rgba(250,204,21,0.18)', fontSize: 9 }}>
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Oracle AI Panel ───────────────────────────────────────────────────────────

function OracleAIPanel({ oracle }: { oracle: OracleResult }) {
  const isWait = oracle.verdict === 'WAIT';
  const isPlayer = oracle.verdict === 'P';
  const isBanker = oracle.verdict === 'B';

  const verdictColor = isPlayer ? '#22d3ee' : isBanker ? '#f87171' : '#71717a';
  const verdictGlow  = isPlayer
    ? '0 0 30px rgba(34,211,238,0.55), 0 0 60px rgba(34,211,238,0.25)'
    : isBanker
    ? '0 0 30px rgba(248,113,113,0.55), 0 0 60px rgba(248,113,113,0.25)'
    : 'none';

  const confColor = oracle.confidence === 'HIGH' ? '#4ade80'
    : oracle.confidence === 'MED' ? '#facc15' : '#71717a';

  const borderColor = isPlayer ? 'rgba(34,211,238,0.5)'
    : isBanker ? 'rgba(248,113,113,0.5)'
    : 'rgba(255,255,255,0.08)';

  const bgColor = isPlayer ? 'rgba(34,211,238,0.04)'
    : isBanker ? 'rgba(248,113,113,0.04)'
    : 'rgba(255,255,255,0.01)';

  const pctOfMax = Math.min(Math.abs(oracle.netScore) / 8, 1);
  const barColor = isPlayer ? '#22d3ee' : isBanker ? '#f87171' : '#3f3f46';

  return (
    <div className="rounded-sm border flex flex-col overflow-hidden"
      style={{
        backgroundColor: bgColor,
        borderColor,
        boxShadow: !isWait ? `0 0 20px ${isPlayer ? 'rgba(34,211,238,0.12)' : 'rgba(248,113,113,0.12)'}` : 'none',
        transition: 'border-color 0.5s, box-shadow 0.5s',
      }}>

      {/* Header */}
      <div className="px-4 py-2 flex items-center justify-between"
        style={{ borderBottom: `1px solid ${borderColor}`, backgroundColor: isWait ? 'rgba(255,255,255,0.02)' : bgColor }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold tracking-widest" style={{ color: '#e2e8f0' }}>
            ◈ ORACLE AI
          </span>
          <span className="text-xs px-1.5 py-0 rounded-sm font-bold tracking-wider"
            style={{ color: confColor, backgroundColor: `${confColor}18`, border: `1px solid ${confColor}35`, fontSize: 9 }}>
            {oracle.confidence}
          </span>
          {oracle.consensusPulse && (
            <span className="text-xs px-1.5 py-0 rounded-sm font-bold"
              style={{ color: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.3)', fontSize: 9, animation: 'pulse 1.5s infinite' }}>
              CONSENSUS
            </span>
          )}
          {oracle.championAligned && !isWait && (
            <span className="text-xs font-bold" style={{ color: '#facc15', fontSize: 9 }}>🏆 CHAMP</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isWait && (
            <span className="text-xs tabular-nums font-bold"
              style={{ color: '#52525b', fontFamily: 'monospace' }}>
              {oracle.agreementCount}/{oracle.totalSignals} signals
            </span>
          )}
          <span className="text-xs tabular-nums" style={{ color: '#3f3f46', fontFamily: 'monospace' }}>
            {oracle.netScore > 0 ? '+' : ''}{oracle.netScore.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Verdict */}
      <div className="flex flex-col items-center gap-3 py-5 px-4">
        {!isWait ? (
          <>
            <div className="text-5xl font-black tracking-wider"
              style={{ color: verdictColor, textShadow: verdictGlow }}>
              {isPlayer ? 'PLAYER' : 'BANKER'}
            </div>
            <div className="text-xs font-bold tracking-widest" style={{ color: verdictColor, opacity: 0.7 }}>
              BET {isPlayer ? 'PLAYER' : 'BANKER'} NEXT HAND
            </div>

            {/* Conviction bar */}
            <div className="w-full max-w-xs">
              <div className="flex justify-between mb-1">
                <span className="text-xs" style={{ color: '#3f3f46' }}>Signal strength</span>
                <span className="text-xs tabular-nums" style={{ color: confColor, fontFamily: 'monospace' }}>
                  {Math.round(pctOfMax * 100)}%
                </span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
                <div className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${pctOfMax * 100}%`,
                    backgroundColor: barColor,
                    boxShadow: `0 0 6px ${barColor}80`,
                  }} />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="text-4xl font-black tracking-widest" style={{ color: '#52525b' }}>
              WAIT
            </div>
            <div className="text-xs tracking-wider text-center max-w-xs" style={{ color: '#71717a' }}>
              {oracle.waitReason ?? 'Skip this hand'}
            </div>
          </>
        )}
      </div>

      {/* Top reasons */}
      {oracle.topReasons.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          {oracle.topReasons.map((r, i) => {
            const isP = r.endsWith('→P');
            const isB = r.endsWith('→B');
            const label = r.replace(/→[PB]$/, '');
            return (
              <span key={i} className="text-xs px-1.5 py-0.5 rounded-sm font-mono"
                style={{
                  color: isP ? '#22d3ee' : isB ? '#f87171' : '#71717a',
                  backgroundColor: isP ? 'rgba(34,211,238,0.07)' : isB ? 'rgba(248,113,113,0.07)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${isP ? 'rgba(34,211,238,0.2)' : isB ? 'rgba(248,113,113,0.2)' : 'rgba(255,255,255,0.08)'}`,
                  fontSize: 9,
                }}>
                {label}{isP ? ' ▲P' : isB ? ' ▼B' : ''}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

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
  const heartbeat = useHeartbeat();

  useEffect(() => {
    if (me.isError) setLocation('/login');
  }, [me.isError, setLocation]);

  // ── Heartbeat: probe every 15 s for concurrent-session detection ──────────
  useEffect(() => {
    const id = setInterval(() => {
      heartbeat.mutate(undefined, {
        onError: () => {
          // 401 = session kicked (concurrent login or account suspended)
          setLocation('/login');
        },
      });
    }, 15_000);
    return () => clearInterval(id);
    // heartbeat.mutate is stable across renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialSnapshot.data) setSnapshot(initialSnapshot.data);
  }, [initialSnapshot.data]);

  const isMutating = submitInput.isPending || undoInput.isPending || resetGame.isPending || setWindow.isPending;

  function handleInput(value: 'P' | 'B' | 'T') {
    submitInput.mutate({ data: { value } }, { onSuccess: (d) => setSnapshot(d) });
  }
  function handleUndo() {
    undoInput.mutate(undefined, { onSuccess: (d) => setSnapshot(d) });
  }
  function handleReset() {
    if (!window.confirm('Reset the entire shoe? This cannot be undone.')) return;
    resetGame.mutate(undefined, { onSuccess: (d) => setSnapshot(d) });
  }
  function handleWindowChange(w: number) {
    setWindow.mutate({ data: { window: w } }, { onSuccess: (d) => setSnapshot(d) });
  }
  function handleLogout() {
    logout.mutate(undefined, {
      onSuccess: () => setLocation('/login'),
      onError: () => setLocation('/login'),
    });
  }

  const regime = snapshot?.regime;
  const activeWindow = regime?.window ?? 12;
  const dominantKey = regime?.expert?.split('+')[0] ?? null;
  const shadowKey = regime?.shadowLeader ?? null;

  // Core 6 + Road 4 + Strategy Bots 11
  const coreKeys = ['supreme', 'syndicate', 'lookAhead', 'legacyLookAhead', 'metaAI', 'observer'] as const;
  const roadKeys = ['bebRoad', 'smallRoad', 'cockroachRoad', 'dualAuth'] as const;
  const botKeys = ['bot1', 'bot2', 'bot3', 'bot4', 'bot5', 'bot6', 'bot7', 'bot8', 'bot9', 'bot10', 'bot11'] as const;
  const allExpertKeys = [...coreKeys, ...roadKeys, ...botKeys];

  // Total voting experts count (for ensemble display)
  const totalExperts = allExpertKeys.length;

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: '#060609', fontFamily: "'JetBrains Mono', monospace" }}>

      {/* TOP BAR */}
      <header className="flex items-center justify-between px-4 py-3 border-b"
        style={{ backgroundColor: '#0d0d14', borderColor: 'rgba(255,255,255,0.08)' }}>
        <span className="text-sm font-bold tracking-wider" style={{ color: '#22d3ee' }} data-testid="app-title">
          ⚡ META-EXPERT REGIME TRACKER
        </span>
        <div className="flex items-center gap-3">
          {me.data && (
            <span className="text-xs" style={{ color: '#71717a' }} data-testid="username-display">
              {me.data.username}
            </span>
          )}
          <button data-testid="btn-logout" onClick={handleLogout}
            className="text-xs px-3 py-1 rounded-sm tracking-wider transition-all active:scale-95"
            style={{ color: '#71717a', border: '1px solid rgba(255,255,255,0.12)', backgroundColor: 'transparent', cursor: 'pointer' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#e2e8f0'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#71717a'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'; }}>
            LOGOUT
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col max-w-lg mx-auto w-full px-4 py-4 gap-4">

        {/* HAND COUNTER + WINDOW SELECTOR */}
        <div className="rounded-sm p-4 border" style={{ backgroundColor: '#0d0d14', borderColor: 'rgba(255,255,255,0.08)' }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-black tracking-wider" style={{ color: '#e2e8f0' }} data-testid="hand-count">
                HAND #{snapshot?.handCount ?? 0}
              </div>
              {regime && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs" style={{ color: '#3f3f46' }}>
                    VOL {(regime.volatilityIndex * 100).toFixed(0)}%
                  </span>
                  <div className="w-16 h-0.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
                    <div className="h-full rounded-full"
                      style={{ width: `${regime.volatilityIndex * 100}%`, backgroundColor: regime.volatilityIndex > 0.6 ? '#f87171' : regime.volatilityIndex > 0.3 ? '#fb923c' : '#4ade80' }} />
                  </div>
                  <span className="text-xs" style={{ color: '#3f3f46' }}>
                    WIN {activeWindow}
                  </span>
                </div>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              <span className="text-xs tracking-widest" style={{ color: '#71717a' }}>ROLLING WINDOW</span>
              <div className="flex gap-2">
                {[8, 12, 16].map((w) => (
                  <button key={w} data-testid={`btn-window-${w}`} onClick={() => handleWindowChange(w)}
                    disabled={isMutating}
                    className="px-3 py-1 rounded-sm text-sm font-bold tracking-wider transition-all active:scale-95"
                    style={{
                      border: activeWindow === w ? '2px solid #22d3ee' : '1px solid rgba(255,255,255,0.12)',
                      color: activeWindow === w ? '#22d3ee' : '#71717a',
                      backgroundColor: activeWindow === w ? 'rgba(34,211,238,0.1)' : 'transparent',
                      cursor: isMutating ? 'not-allowed' : 'pointer',
                      boxShadow: activeWindow === w ? '0 0 8px rgba(34,211,238,0.2)' : 'none',
                    }}>
                    {w}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── META REGIME TRACKER PANEL ──────────────────────────────── */}
        {regime && (
          <div className="rounded-sm border flex flex-col overflow-hidden"
            style={{ backgroundColor: '#0d0d14', borderColor: 'rgba(255,255,255,0.08)' }}>

            {/* Panel header */}
            <div className="px-4 py-2 flex items-center justify-between"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', backgroundColor: 'rgba(34,211,238,0.02)' }}>
              <div className="flex items-center gap-2">
                <StatusBadge status={regime.status} />
                <ConfidenceBadge confidence={regime.confidence} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: '#3f3f46' }}>Age {regime.regimeAge}h</span>
                <span className="text-xs" style={{ color: '#3f3f46' }}>Sw {regime.switchCount}</span>
                <span className="text-xs" style={{ color: '#71717a' }}>{snapshot?.history.length ?? 0}h</span>
              </div>
            </div>

            {/* ── Core 6 experts ── */}
            <div className="px-4">
              <ExpertGroupHeader label="CORE ENGINES" color="#22d3ee" />
              {coreKeys.map((key) => {
                const stats = regime[key] as ExpertStats;
                return (
                  <ExpertRow
                    key={key}
                    expertKey={key}
                    stats={stats}
                    isActive={dominantKey === key}
                    isShadow={shadowKey === key}
                  />
                );
              })}
            </div>

            {/* ── Road 4 experts ── */}
            <div className="px-4">
              <ExpertGroupHeader label="DERIVED ROADS" color="#f43f5e" />
              {roadKeys.map((key) => {
                const stats = regime[key] as ExpertStats;
                return (
                  <ExpertRow
                    key={key}
                    expertKey={key}
                    stats={stats}
                    isActive={dominantKey === key}
                    isShadow={shadowKey === key}
                  />
                );
              })}
            </div>

            {/* ── Strategy Bots 11 ── */}
            <div className="px-4">
              <ExpertGroupHeader label="STRATEGY BOTS (appx 11)" color="#64748b" />
              {botKeys.map((key) => {
                const stats = regime[key] as ExpertStats;
                return (
                  <ExpertRow
                    key={key}
                    expertKey={key}
                    stats={stats}
                    isActive={dominantKey === key}
                    isShadow={shadowKey === key}
                  />
                );
              })}
            </div>

          </div>
        )}

        {/* Loading state */}
        {!regime && !initialSnapshot.isError && (
          <div className="rounded-sm border p-8 text-center"
            style={{ backgroundColor: '#0d0d14', borderColor: 'rgba(255,255,255,0.08)', color: '#71717a' }}>
            <div className="text-sm tracking-wider">LOADING REGIME DATA...</div>
          </div>
        )}

        {/* ── LOOK-AHEAD SYSTEMS PANEL ─────────────────────────────── */}
        {snapshot && snapshot.legacyLookAhead && (
          <div className="rounded-sm border flex flex-col gap-0 overflow-hidden"
            style={{ backgroundColor: '#0d0d14', borderColor: 'rgba(34,211,238,0.2)' }}>
            <div className="px-4 py-2 flex items-center justify-between"
              style={{ borderBottom: '1px solid rgba(34,211,238,0.1)', backgroundColor: 'rgba(34,211,238,0.03)' }}>
              <span className="text-xs font-bold tracking-widest" style={{ color: '#22d3ee' }}>
                ◈ LOOK-AHEAD SYSTEMS
              </span>
              <span className="text-xs" style={{ color: '#52525b' }}>Branch Simulation</span>
            </div>
            <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
              <LookAheadRow
                label="LOOK-AHEAD v1"
                la={snapshot.lookAhead}
                color="#22d3ee"
                depth="depth-1"
              />
              <LookAheadRow
                label="LOOK-AHEAD v2 (LEGACY)"
                la={snapshot.legacyLookAhead}
                color="#fb923c"
                depth="depth-2"
              />
            </div>
            {snapshot.lookAhead.active && snapshot.legacyLookAhead.active &&
             snapshot.lookAhead.verdict && snapshot.legacyLookAhead.verdict && (
              <div className="px-4 py-2"
                style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                {snapshot.lookAhead.verdict === snapshot.legacyLookAhead.verdict ? (
                  <span className="text-xs font-bold" style={{ color: '#4ade80' }}>
                    ✓ v1 + v2 AGREE → {snapshot.lookAhead.verdict === 'P' ? 'PLAYER' : 'BANKER'}
                  </span>
                ) : (
                  <span className="text-xs font-bold" style={{ color: '#fb923c' }}>
                    ⚡ v1 vs v2 SPLIT — v1:{snapshot.lookAhead.verdict} v2:{snapshot.legacyLookAhead.verdict}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── META AI PANEL ─────────────────────────────────────────── */}
        {snapshot && (
          <div className="rounded-sm border flex flex-col gap-0 overflow-hidden"
            style={{ backgroundColor: '#0d0d14', borderColor: 'rgba(176,0,255,0.25)' }}>
            <div className="px-4 py-2 flex items-center justify-between"
              style={{ borderBottom: '1px solid rgba(176,0,255,0.15)', backgroundColor: 'rgba(176,0,255,0.04)' }}>
              <span className="text-xs font-bold tracking-widest" style={{ color: '#b000ff' }}>
                ◈ META AI
              </span>
              <span className="text-xs" style={{ color: '#52525b' }}>Online Logistic Regression</span>
            </div>
            <div className="px-4 py-3 flex items-center justify-between">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                  <span className="text-xs tracking-widest" style={{ color: '#71717a' }}>DECISION</span>
                  <SideVerdict verdict={snapshot.metaAI.decision} />
                </div>
                <span className="text-xs" style={{ color: '#52525b' }}>
                  {snapshot.metaAI.seen === 0
                    ? 'no samples yet'
                    : `${snapshot.metaAI.seen} samples · acc ${snapshot.metaAI.accuracy !== null ? `${Math.round(snapshot.metaAI.accuracy * 100)}%` : '--'}  ·  P̂ ${(snapshot.metaAI.pPlayer * 100).toFixed(1)}%`}
                </span>
              </div>
              {snapshot.metaAI.seen > 0 && (
                <div className="flex flex-col items-end gap-1">
                  <div className="w-20 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(176,0,255,0.15)' }}>
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${(snapshot.metaAI.pPlayer * 100).toFixed(0)}%`, backgroundColor: '#b000ff', boxShadow: '0 0 4px rgba(176,0,255,0.6)' }} />
                  </div>
                  <span className="text-xs tabular-nums" style={{ color: '#b000ff' }}>
                    {(snapshot.metaAI.pPlayer * 100).toFixed(1)}% P
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── OBSERVER MASTER AI PANEL ──────────────────────────────── */}
        {snapshot && (
          <div className="rounded-sm border flex flex-col gap-0 overflow-hidden"
            style={{ backgroundColor: '#0d0d14', borderColor: 'rgba(74,222,128,0.2)' }}>
            <div className="px-4 py-2 flex items-center justify-between"
              style={{ borderBottom: '1px solid rgba(74,222,128,0.1)', backgroundColor: 'rgba(74,222,128,0.02)' }}>
              <span className="text-xs font-bold tracking-widest" style={{ color: '#4ade80' }}>
                ◈ OBSERVER MASTER AI
              </span>
              <span className="text-xs" style={{ color: '#52525b' }}>Meta-learning Layer</span>
            </div>
            <div className="px-4 py-3 flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs tracking-widest" style={{ color: '#71717a' }}>VERDICT</span>
                <span className="text-xs" style={{ color: '#52525b' }}>
                  {snapshot.observer.reasoning}
                  {snapshot.observer.wr !== null ? ` (${Math.round(snapshot.observer.wr * 100)}% WR)` : ''}
                </span>
              </div>
              <SideVerdict verdict={snapshot.observer.decision} />
            </div>

            {snapshot.observerMemory && (
              <div className="border-t" style={{ borderColor: 'rgba(74,222,128,0.08)' }}>
                <div className="px-4 pt-2 pb-1 text-xs tracking-widest" style={{ color: '#3f3f46' }}>
                  SUB-SYSTEM TRACKERS
                </div>
                <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                  <SubSystemRow
                    label="META AI"
                    color="#b000ff"
                    winRate={snapshot.observerMemory.meta.winRate}
                    total={snapshot.observerMemory.meta.total}
                    lastPred={snapshot.observerMemory.meta.lastPred}
                  />
                  <SubSystemRow
                    label="LOOK-AHEAD (v1)"
                    color="#22d3ee"
                    winRate={snapshot.observerMemory.lookAhead.winRate}
                    total={snapshot.observerMemory.lookAhead.total}
                    lastPred={snapshot.observerMemory.lookAhead.lastPred}
                  />
                  <SubSystemRow
                    label="DERIVED ROADS"
                    color="#fb923c"
                    winRate={snapshot.observerMemory.derived.winRate}
                    total={snapshot.observerMemory.derived.total}
                    lastPred={snapshot.observerMemory.derived.lastPred}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── META COMBINER PANEL ───────────────────────────────────── */}
        {snapshot?.metaCombiner && (
          <MetaCombinerPanel mc={snapshot.metaCombiner} race={snapshot.race} />
        )}

        {/* ── DECISION PANEL (ensemble + timeline + lock + main call) ── */}
        {regime && (
          <div className="rounded-sm border flex flex-col overflow-hidden"
            style={{ backgroundColor: '#0d0d14', borderColor: 'rgba(255,255,255,0.08)' }}>

            {/* ── CRISIS AI PANEL (right above ensemble vote) ─────── */}
            {snapshot?.crisisAI && (
              <div className="mx-4 mt-3">
                <CrisisAIPanel crisis={snapshot.crisisAI} race={snapshot.race} />
              </div>
            )}

            {/* Ensemble Voting Block */}
            <EnsembleVoteBlock regime={regime} race={snapshot?.race} totalExperts={totalExperts} />

            {/* ── ORACLE AI PANEL (Final Prediction) ─────────────────── */}
            {snapshot?.oracleAI && (
              <div className="mx-4 mb-2">
                <OracleAIPanel oracle={snapshot.oracleAI} />
              </div>
            )}

            {/* Regime Switch Timeline */}
            {(regime.switchTimeline?.length ?? 0) > 0 && (
              <div className="px-4 pb-2">
                <div className="text-xs tracking-widest mb-1.5" style={{ color: '#3f3f46' }}>TIMELINE</div>
                <div className="flex flex-wrap items-center gap-1">
                  {regime.switchTimeline.map((entry, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <span className="text-xs px-1.5 py-0.5 rounded-sm tabular-nums"
                        style={{
                          color: expertColor(entry.expert),
                          backgroundColor: `${expertColor(entry.expert)}12`,
                          border: `1px solid ${expertColor(entry.expert)}25`,
                        }}>
                        {expertLabel(entry.expert)} {entry.hands}h
                      </span>
                      <span className="text-xs" style={{ color: '#3f3f46' }}>→</span>
                    </div>
                  ))}
                  <span className="text-xs px-1.5 py-0.5 rounded-sm"
                    style={{
                      color: expertColor(regime.expert ?? ''),
                      backgroundColor: `${expertColor(regime.expert ?? '')}18`,
                      border: `1px solid ${expertColor(regime.expert ?? '')}35`,
                    }}>
                    {expertLabel(regime.expert ?? '—')} ★
                  </span>
                </div>
              </div>
            )}

            {/* Lock countdown with shadow leader */}
            {regime.isLocked && (
              <div className="px-4 pb-2">
                <LockBar
                  lockRemain={regime.lockRemain}
                  lockMax={regime.lockMax}
                  shadowLeader={regime.shadowLeader}
                  shadowLeaderPred={regime.shadowLeaderPred}
                  shadowLeaderComposite={regime.shadowLeaderComposite}
                  lockAccelerated={regime.lockAccelerated}
                />
              </div>
            )}

            {/* Both / All agree banner */}
            {regime.bothAgree && (
              <div className="mx-4 mb-2 text-center py-2 px-4 rounded-sm font-bold tracking-wider text-sm"
                style={{
                  color: '#eab308',
                  backgroundColor: 'rgba(234,179,8,0.1)',
                  border: '1px solid rgba(234,179,8,0.4)',
                  boxShadow: '0 0 12px rgba(234,179,8,0.15)',
                }}
                data-testid="both-agree-banner">
                ⚡ ALL {regime.agreeCount} AGREE —{' '}
                {regime.bothAgreeSide === 'P' ? 'PLAYER' : regime.bothAgreeSide === 'B' ? 'BANKER' : 'BET'}
              </div>
            )}
            {!regime.bothAgree && regime.agreeCount >= 6 && regime.ensembleVerdict && (
              <div className="mx-4 mb-2 text-center py-2 px-4 rounded-sm font-bold tracking-wider text-sm"
                style={{
                  color: regime.ensembleVerdict === 'P' ? '#22d3ee' : '#f87171',
                  backgroundColor: regime.ensembleVerdict === 'P' ? 'rgba(34,211,238,0.07)' : 'rgba(248,113,113,0.07)',
                  border: `1px solid ${regime.ensembleVerdict === 'P' ? 'rgba(34,211,238,0.3)' : 'rgba(248,113,113,0.3)'}`,
                }}>
                ⚡ {regime.agreeCount}/{totalExperts} LEAN —{' '}
                {regime.ensembleVerdict === 'P' ? 'PLAYER' : 'BANKER'}
              </div>
            )}

            {/* MAIN DECISION */}
            <div className="flex flex-col items-center gap-2 py-5">
              {regime.decision === 'P' && (
                <>
                  <div className="text-6xl font-black tracking-wider"
                    style={{ color: '#22d3ee', textShadow: '0 0 20px rgba(34,211,238,0.7), 0 0 40px rgba(34,211,238,0.4)' }}
                    data-testid="decision-display">
                    PLAYER
                  </div>
                  <div className="text-xs tracking-wider" style={{ color: expertColor(regime.expert ?? '') }} data-testid="following-label">
                    Following {expertLabel(regime.expert ?? '')}
                    {regime.isSplit && ' (split→obs)'}
                  </div>
                </>
              )}
              {regime.decision === 'B' && (
                <>
                  <div className="text-6xl font-black tracking-wider"
                    style={{ color: '#f87171', textShadow: '0 0 20px rgba(248,113,113,0.7), 0 0 40px rgba(248,113,113,0.4)' }}
                    data-testid="decision-display">
                    BANKER
                  </div>
                  <div className="text-xs tracking-wider" style={{ color: expertColor(regime.expert ?? '') }} data-testid="following-label">
                    Following {expertLabel(regime.expert ?? '')}
                    {regime.isSplit && ' (split→obs)'}
                  </div>
                </>
              )}
              {!regime.decision && (
                <div className="text-4xl font-black tracking-wider" style={{ color: '#71717a' }} data-testid="decision-display">
                  — WAIT —
                </div>
              )}
            </div>

          </div>
        )}

        {/* ── INPUT AREA ────────────────────────────────────────────── */}
        <div className="rounded-sm border p-4 flex flex-col gap-3"
          style={{ backgroundColor: '#0d0d14', borderColor: 'rgba(255,255,255,0.08)' }}>
          <div className="text-xs tracking-widest mb-1" style={{ color: '#71717a' }}>RECORD OUTCOME</div>
          <div className="grid grid-cols-3 gap-3">
            {([['P', '#22d3ee'], ['B', '#f87171'], ['T', '#4ade80']] as const).map(([val, col]) => (
              <button key={val} data-testid={`btn-${val === 'P' ? 'player' : val === 'B' ? 'banker' : 'tie'}`}
                onClick={() => handleInput(val)}
                disabled={isMutating}
                className="py-5 font-black text-2xl rounded-sm transition-all active:scale-95"
                style={{
                  border: `2px solid ${col}`,
                  backgroundColor: `${col}0d`,
                  color: col,
                  cursor: isMutating ? 'not-allowed' : 'pointer',
                  opacity: isMutating ? 0.5 : 1,
                  fontFamily: "'JetBrains Mono', monospace",
                  boxShadow: isMutating ? 'none' : `0 0 12px ${col}25`,
                }}>
                {val}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button data-testid="btn-undo" onClick={handleUndo} disabled={isMutating}
              className="py-2 text-sm rounded-sm tracking-wider transition-all active:scale-95"
              style={{ border: '1px solid rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.5)', backgroundColor: 'transparent', cursor: isMutating ? 'not-allowed' : 'pointer', opacity: isMutating ? 0.5 : 1, fontFamily: "'JetBrains Mono', monospace" }}>
              UNDO
            </button>
            <button data-testid="btn-reset" onClick={handleReset} disabled={isMutating}
              className="py-2 text-sm rounded-sm tracking-wider transition-all active:scale-95"
              style={{ border: '1px solid rgba(248,113,113,0.28)', color: 'rgba(248,113,113,0.7)', backgroundColor: 'transparent', cursor: isMutating ? 'not-allowed' : 'pointer', opacity: isMutating ? 0.5 : 1, fontFamily: "'JetBrains Mono', monospace" }}>
              RESET
            </button>
          </div>
        </div>

        {/* ── HISTORY STRIP ─────────────────────────────────────────── */}
        {snapshot && snapshot.history.length > 0 && (
          <div className="rounded-sm border p-3" style={{ backgroundColor: '#0d0d14', borderColor: 'rgba(255,255,255,0.08)' }}>
            <div className="text-xs tracking-widest mb-2" style={{ color: '#71717a' }}>HISTORY (last 20)</div>
            <div className="flex flex-wrap gap-1">
              {snapshot.history.slice(-20).map((h, i) => (
                <span key={i} className="text-xs font-bold w-6 h-6 flex items-center justify-center rounded-sm"
                  style={{
                    color: h === 'P' ? '#22d3ee' : h === 'B' ? '#f87171' : '#4ade80',
                    backgroundColor: h === 'P' ? 'rgba(34,211,238,0.12)' : h === 'B' ? 'rgba(248,113,113,0.12)' : 'rgba(74,222,128,0.12)',
                    border: h === 'P' ? '1px solid rgba(34,211,238,0.25)' : h === 'B' ? '1px solid rgba(248,113,113,0.25)' : '1px solid rgba(74,222,128,0.25)',
                  }}>
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

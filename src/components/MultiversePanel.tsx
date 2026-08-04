import React from 'react';
import { MultiverseStats } from '../engine/multiverse';

interface MultiversePanelProps {
  stats: MultiverseStats;
}

export const MultiversePanel: React.FC<MultiversePanelProps> = ({ stats }) => {
  const getBadgeStyle = (pred: string) => {
    if (pred === 'P') return 'bg-blue-600 text-white border-blue-400';
    if (pred === 'B') return 'bg-red-600 text-white border-red-400';
    return 'bg-zinc-800 text-zinc-400 border-zinc-700';
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 shadow-lg text-white">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 border-b border-zinc-800 pb-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-purple-500 animate-pulse"></span>
          <h3 className="font-bold text-base text-purple-400 tracking-wide uppercase">
            Multiverse Engine
          </h3>
        </div>
        <span className="text-xs text-zinc-500 font-mono">CONTRARIAN V1</span>
      </div>

      {/* Signal Output */}
      <div className="flex items-center justify-between bg-zinc-950 p-3.5 rounded-lg mb-4 border border-zinc-800/80">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Next Signal</span>
        <div className={`px-4 py-1 rounded-md font-bold text-sm border ${getBadgeStyle(stats.prediction)}`}>
          {stats.prediction === 'P' ? 'PLAYER' : stats.prediction === 'B' ? 'BANKER' : 'WAIT'}
        </div>
      </div>

      {/* Rolling Windows */}
      <div>
        <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">
          Rolling Accuracy
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-zinc-950/80 p-2.5 rounded-lg border border-zinc-800/60">
            <div className="text-[10px] text-zinc-500 font-mono">8 HANDS</div>
            <div className="text-lg font-mono font-bold text-purple-300">{stats.accuracy8}%</div>
          </div>

          <div className="bg-zinc-950/80 p-2.5 rounded-lg border border-zinc-800/60">
            <div className="text-[10px] text-zinc-500 font-mono">12 HANDS</div>
            <div className="text-lg font-mono font-bold text-purple-300">{stats.accuracy12}%</div>
          </div>

          <div className="bg-zinc-950/80 p-2.5 rounded-lg border border-zinc-800/60">
            <div className="text-[10px] text-zinc-500 font-mono">16 HANDS</div>
            <div className="text-lg font-mono font-bold text-purple-300">{stats.accuracy16}%</div>
          </div>
        </div>
      </div>
    </div>
  );
};

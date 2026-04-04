'use client';

import { useState } from 'react';
import { useMultiply } from '@/hooks/useMultiply';
import { CardSkeleton } from '@/components/shared/Skeleton';
import { formatUsd } from '@/lib/format';
import type { MultiplyPosition, RiskAssessmentData } from '@/types/api';

function formatApy(apy: number): string {
  return `${(apy * 100).toFixed(2)}%`;
}

function formatHealth(health: number): string {
  if (health === Infinity || health > 99) return '-';
  return health.toFixed(3);
}

function healthColor(health: number, target: number, alert: number, emergency: number): string {
  if (health === Infinity || health > 99) return 'text-vault-muted';
  if (health < emergency) return 'text-vault-negative';
  if (health < alert) return 'text-vault-warning';
  if (health >= target) return 'text-vault-accent';
  return 'text-vault-warning';
}

function healthBg(health: number, alert: number, emergency: number): string {
  if (health === Infinity || health > 99) return '';
  if (health < emergency) return 'bg-vault-negative/10 border-vault-negative/30';
  if (health < alert) return 'bg-vault-warning/10 border-vault-warning/30';
  return '';
}

function riskScoreColor(score: number): string {
  if (score >= 75) return 'text-vault-negative';
  if (score >= 55) return 'text-vault-warning';
  if (score >= 35) return 'text-amber-400';
  return 'text-vault-accent';
}

function riskScoreBg(score: number): string {
  if (score >= 75) return 'bg-vault-negative';
  if (score >= 55) return 'bg-vault-warning';
  if (score >= 35) return 'bg-amber-400';
  return 'bg-vault-accent';
}

function alertLevelColor(level: string): string {
  switch (level) {
    case 'emergency': return 'text-vault-negative';
    case 'critical': return 'text-vault-negative';
    case 'warning': return 'text-vault-warning';
    default: return 'text-vault-accent';
  }
}

const DIMENSION_LABELS: Record<string, string> = {
  pegStability: 'Peg Stability',
  liquidityDepth: 'Liquidity',
  reserveUtilization: 'Reserve Util',
  tvlProtocol: 'TVL/Protocol',
  borrowRateVol: 'Borrow Vol',
  collateralType: 'Coll Type',
};

const DIMENSION_WEIGHTS: Record<string, number> = {
  pegStability: 25,
  liquidityDepth: 20,
  reserveUtilization: 20,
  tvlProtocol: 15,
  borrowRateVol: 10,
  collateralType: 10,
};

function RiskDimensionBar({ name, score }: { name: string; score: number }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-vault-muted w-20 shrink-0">{DIMENSION_LABELS[name] ?? name}</span>
      <div className="flex-1 h-1.5 bg-vault-border/30 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${riskScoreBg(score)}`}
          style={{ width: `${Math.min(score, 100)}%` }}
        />
      </div>
      <span className={`w-8 text-right font-mono ${riskScoreColor(score)}`}>{score.toFixed(0)}</span>
      <span className="text-vault-muted/50 w-6 text-right">{DIMENSION_WEIGHTS[name]}%</span>
    </div>
  );
}

function RiskDetailPanel({ risk, label }: { risk: RiskAssessmentData; label: string }) {
  return (
    <div className="mt-2 p-3 rounded-md border border-vault-border/30 bg-vault-bg/50">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-vault-text-bright">{label} Risk Score</span>
        <div className="flex items-center gap-2">
          <span className={`text-lg font-bold ${riskScoreColor(risk.compositeScore)}`}>
            {risk.compositeScore.toFixed(1)}
          </span>
          <span className="text-vault-muted text-xs">/ 100</span>
        </div>
      </div>

      <div className="space-y-1.5 mb-3">
        {Object.entries(risk.dimensions).map(([key, value]) => (
          <RiskDimensionBar key={key} name={key} score={value} />
        ))}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs border-t border-vault-border/30 pt-2">
        <div className="flex justify-between">
          <span className="text-vault-muted">Penalty</span>
          <span className="text-vault-text-bright font-mono">{(risk.riskPenalty * 100).toFixed(2)}%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-vault-muted">Health Target</span>
          <span className="text-vault-text-bright font-mono">{risk.targetHealthRate.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-vault-muted">Max Position</span>
          <span className="text-vault-text-bright font-mono">{formatUsd(risk.maxPositionCap, 0)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-vault-muted">Alert</span>
          <span className={`font-semibold uppercase ${alertLevelColor(risk.alertLevel)}`}>{risk.alertLevel}</span>
        </div>
      </div>
    </div>
  );
}

function PositionRow({ pos }: { pos: MultiplyPosition }) {
  const hColor = healthColor(pos.healthRate, pos.targetHealthRate, pos.alertHealthRate, pos.emergencyHealthRate);
  const hBg = healthBg(pos.healthRate, pos.alertHealthRate, pos.emergencyHealthRate);

  return (
    <div className={`rounded-md p-3 border border-vault-border/30 ${hBg}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-vault-accent" />
          <span className="text-sm font-semibold text-vault-text-bright">{pos.label}</span>
        </div>
        <span className="text-sm font-bold text-vault-text-bright">{formatUsd(pos.balance)}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <span className="text-vault-muted">Health</span>
          <div className={`font-bold ${hColor}`}>{formatHealth(pos.healthRate)}</div>
        </div>
        <div>
          <span className="text-vault-muted">APY</span>
          <div className="font-bold text-vault-accent">{formatApy(pos.effectiveApy)}</div>
        </div>
        <div>
          <span className="text-vault-muted">Leverage</span>
          <div className="font-bold text-vault-text-bright">{pos.leverage.toFixed(2)}x</div>
        </div>
      </div>
    </div>
  );
}

export function MultiplyCard() {
  const { data, isLoading } = useMultiply();
  const [expandedRisk, setExpandedRisk] = useState<string | null>(null);

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">
        Multiply Positions
      </h3>

      {isLoading || !data ? (
        <CardSkeleton />
      ) : (
        <>
          {/* Active Positions */}
          {data.positions.length === 0 ? (
            <p className="text-vault-muted text-sm mb-3">No active positions</p>
          ) : (
            <div className="space-y-2 mb-4">
              {data.positions.map((pos) => (
                <PositionRow key={pos.label} pos={pos} />
              ))}
            </div>
          )}

          {/* Market Candidates APY Table */}
          {data.candidates.length > 0 && (
            <>
              <h4 className="text-vault-muted text-xs uppercase tracking-wider mb-2 mt-3 pt-3 border-t border-vault-border/30">
                Market Scanner
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-vault-muted border-b border-vault-border/30">
                      <th className="text-left py-1.5 pr-2">Market</th>
                      <th className="text-right py-1.5 px-2">APY</th>
                      <th className="text-right py-1.5 px-2">24h Avg</th>
                      <th className="text-right py-1.5 px-2">Risk</th>
                      <th className="text-right py-1.5 pl-2">Capacity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.candidates
                      .sort((a, b) => (b.movingAvg ?? b.adjustedApy) - (a.movingAvg ?? a.adjustedApy))
                      .map((c) => (
                      <tr
                        key={c.label}
                        className="border-b border-vault-border/20 last:border-b-0 cursor-pointer hover:bg-vault-border/10"
                        onClick={() => setExpandedRisk(expandedRisk === c.label ? null : c.label)}
                      >
                        <td className="py-1.5 pr-2">
                          <span className={c.active ? 'text-vault-accent font-semibold' : 'text-vault-text'}>
                            {c.label}
                          </span>
                          {c.active && <span className="text-vault-accent ml-1 text-[10px]">ACTIVE</span>}
                        </td>
                        <td className="text-right py-1.5 px-2 text-vault-text-bright font-mono">
                          {formatApy(c.effectiveApy)}
                        </td>
                        <td className="text-right py-1.5 px-2 text-vault-muted font-mono">
                          {c.movingAvg !== null ? formatApy(c.movingAvg) : '-'}
                        </td>
                        <td className="text-right py-1.5 px-2 font-mono">
                          {c.riskAssessment ? (
                            <span className={riskScoreColor(c.riskAssessment.compositeScore)}>
                              {c.riskAssessment.compositeScore.toFixed(0)}
                            </span>
                          ) : (
                            <span className="text-vault-muted">-</span>
                          )}
                        </td>
                        <td className="text-right py-1.5 pl-2 text-vault-muted font-mono">
                          {c.capacity ? `${(c.capacity.remaining / 1000).toFixed(0)}K` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Expanded Risk Detail */}
              {expandedRisk && (() => {
                const candidate = data.candidates.find((c) => c.label === expandedRisk);
                if (!candidate?.riskAssessment) return null;
                return <RiskDetailPanel risk={candidate.riskAssessment} label={candidate.label} />;
              })()}
            </>
          )}
        </>
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useAdvisor } from '@/hooks/useAdvisor';
import { CardSkeleton } from '@/components/shared/Skeleton';

const categoryColors: Record<string, string> = {
  rebalance: 'text-vault-warning',
  dn_entry: 'text-[#00bbff]',
  dn_exit: 'text-[#00bbff]',
  risk_alert: 'text-vault-negative',
  param_adjust: 'text-vault-muted',
};

const confidenceBadge: Record<string, string> = {
  high: 'bg-vault-accent/20 text-vault-accent',
  medium: 'bg-vault-warning/20 text-vault-warning',
  low: 'bg-vault-muted/20 text-vault-muted',
};

const urgencyIcons: Record<string, string> = {
  immediate: '\u26A1',
  next_cycle: '\u23F0',
  informational: '',
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function AdvisorTable() {
  const { data, isLoading } = useAdvisor(20);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggle = (id: string) => setExpandedId(prev => prev === id ? null : id);

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-3">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider">
          AI Advisor
        </h3>
        {data && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${data.enabled ? 'bg-vault-accent/20 text-vault-accent' : 'bg-vault-muted/20 text-vault-muted'}`}>
            {data.enabled ? 'Active' : 'Off'}
          </span>
        )}
      </div>

      {isLoading ? (
        <CardSkeleton />
      ) : !data?.recommendations?.length ? (
        <p className="text-vault-muted text-[11px] py-3 text-center">
          {data?.enabled ? 'No recommendations' : 'Not enabled'}
        </p>
      ) : (
        <div className="space-y-1 max-h-[calc(100vh-180px)] overflow-y-auto">
          {data.recommendations.map((rec, i) => {
            const id = `${rec.timestamp}-${i}`;
            const isOpen = expandedId === id;
            return (
              <div
                key={id}
                className={`rounded border transition-colors ${
                  rec.override
                    ? 'border-vault-warning/40 bg-vault-warning/5'
                    : 'border-vault-border/20 hover:border-vault-border/50'
                }`}
              >
                {/* Collapsed row */}
                <div
                  className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer"
                  onClick={() => toggle(id)}
                >
                  {urgencyIcons[rec.urgency] && (
                    <span className="text-[10px]">{urgencyIcons[rec.urgency]}</span>
                  )}
                  <span className={`text-[10px] font-semibold shrink-0 ${categoryColors[rec.category] || ''}`}>
                    {rec.category.replace('_', ' ')}
                  </span>
                  <span className="text-[11px] text-vault-text truncate">
                    {rec.action}
                  </span>
                  <span
                    className={`text-[9px] px-1 py-px rounded shrink-0 ml-auto ${confidenceBadge[rec.confidence] || ''}`}
                    title={`Confidence: ${rec.confidence}`}
                  >
                    {rec.confidence[0]?.toUpperCase()}
                  </span>
                  <span className="text-[9px] text-vault-muted shrink-0">
                    {timeAgo(rec.timestamp)}
                  </span>
                </div>

                {/* Expanded detail */}
                {isOpen && (
                  <div
                    className="px-2 pb-2 pt-0.5 border-t border-vault-border/20 select-text"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-[11px] text-vault-text-bright mb-1">{rec.action}</p>
                    <p className="text-[10px] text-vault-muted leading-relaxed">{rec.reasoning}</p>
                    {rec.override && rec.currentRule && (
                      <p className="text-[10px] text-vault-warning mt-1">
                        Rule: {rec.currentRule}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

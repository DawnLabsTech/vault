'use client';

import { useStatus } from '@/hooks/useStatus';
import { Skeleton } from '@/components/shared/Skeleton';
import { formatUsd } from '@/lib/format';

export function AllocationChart() {
  const { data, isLoading } = useStatus();
  const perpExchange = 'Binance';
  const s = data?.snapshot;

  if (isLoading || !s) {
    return (
      <div className="bg-vault-card border border-vault-border rounded-lg p-4">
        <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">
          Strategy Allocation
        </h3>
        <Skeleton className="h-[250px] w-full" />
      </div>
    );
  }

  const total = s.totalNavUsdc || 1;
  const segments = [
    { label: 'Lending', value: s.lendingBalance, color: '#00ff88' },
    { label: 'Multiply', value: s.multiplyBalance ?? 0, color: '#aa88ff' },
    { label: 'dawnSOL', value: s.dawnsolUsdcValue, color: '#00bbff' },
    { label: `${perpExchange} USDC`, value: s.binanceUsdcBalance, color: '#ffaa00' },
    { label: 'PERP (abs)', value: Math.abs(s.binancePerpSize), color: '#ff4444' },
  ].filter((seg) => seg.value > 0);

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">
        Strategy Allocation
      </h3>
      <div className="space-y-3">
        {/* Stacked bar */}
        <div className="flex h-6 rounded overflow-hidden">
          {segments.map((seg) => (
            <div
              key={seg.label}
              style={{
                width: `${(seg.value / total) * 100}%`,
                backgroundColor: seg.color,
              }}
              className="opacity-70 hover:opacity-100 transition-opacity"
              title={`${seg.label}: ${formatUsd(seg.value)} (${((seg.value / total) * 100).toFixed(1)}%)`}
            />
          ))}
        </div>
        {/* Legend */}
        <div className="grid grid-cols-2 gap-2">
          {segments.map((seg) => (
            <div key={seg.label} className="flex items-center gap-2 text-xs">
              <span
                className="w-3 h-3 rounded-sm flex-shrink-0"
                style={{ backgroundColor: seg.color, opacity: 0.7 }}
              />
              <span className="text-vault-muted">{seg.label}</span>
              <span className="text-vault-text-bright ml-auto font-semibold">
                {((seg.value / total) * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

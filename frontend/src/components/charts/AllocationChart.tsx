'use client';

import { useStatus } from '@/hooks/useStatus';
import { Skeleton } from '@/components/shared/Skeleton';
import { formatUsd } from '@/lib/format';

export function AllocationChart() {
  const { data, isLoading } = useStatus();
  const s = data?.snapshot;

  if (isLoading || !s) {
    return (
      <div className="bg-vault-card border border-vault-border rounded-lg p-4 h-full min-h-[314px] flex flex-col">
        <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">
          Live Allocation
        </h3>
        <Skeleton className="h-[250px] w-full flex-1" />
      </div>
    );
  }

  const total = s.totalNavUsdc || 1;

  // Build segments: Lending breakdown + Multiply breakdown + other components
  const segments: { label: string; value: number; color: string }[] = [];

  // Lending breakdown by protocol
  const lendingColors: Record<string, string> = {
    kamino: '#00ff88',
    jupiter: '#7dd3fc',
    marginfi: '#a78bfa',
  };
  if (s.lendingBreakdown && Object.keys(s.lendingBreakdown).length > 0) {
    for (const [protocol, balance] of Object.entries(s.lendingBreakdown)) {
      if (balance > 0) {
        segments.push({
          label: `Lending: ${protocol}`,
          value: balance,
          color: lendingColors[protocol] ?? '#00ff88',
        });
      }
    }
  } else if (s.lendingBalance > 0) {
    segments.push({ label: 'Lending', value: s.lendingBalance, color: '#00ff88' });
  }

  // Multiply breakdown by pair
  const multiplyColors = ['#aa88ff', '#d8b4fe', '#c084fc'];
  if (s.multiplyBreakdown && Object.keys(s.multiplyBreakdown).length > 0) {
    Object.entries(s.multiplyBreakdown).forEach(([label, balance], i) => {
      if (balance > 0) {
        segments.push({
          label: `Multiply: ${label}`,
          value: balance,
          color: multiplyColors[i % multiplyColors.length]!,
        });
      }
    });
  } else if ((s.multiplyBalance ?? 0) > 0) {
    segments.push({ label: 'Multiply', value: s.multiplyBalance, color: '#aa88ff' });
  }

  // Buffer
  if (s.bufferUsdcBalance > 0) {
    segments.push({ label: 'Buffer USDC', value: s.bufferUsdcBalance, color: '#666' });
  }

  // DN components
  if (s.dawnsolUsdcValue > 0) {
    segments.push({ label: 'dawnSOL', value: s.dawnsolUsdcValue, color: '#00bbff' });
  }
  if (s.binanceUsdcBalance > 0) {
    segments.push({ label: 'Binance USDC', value: s.binanceUsdcBalance, color: '#ffaa00' });
  }

  const filtered = segments.filter((seg) => seg.value > 0);

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4 h-full min-h-[314px] flex flex-col">
      <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">
        Live Allocation
      </h3>
      {filtered.length === 0 ? (
        <div className="min-h-[250px] flex-1 flex items-center justify-center">
          <p className="text-vault-muted text-sm">No allocation data</p>
        </div>
      ) : (
        <div className="min-h-[250px] flex-1 flex flex-col justify-center gap-6">
          {/* Stacked bar */}
          <div className="flex h-6 rounded overflow-hidden">
            {filtered.map((seg) => (
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {filtered.map((seg) => (
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
      )}
    </div>
  );
}

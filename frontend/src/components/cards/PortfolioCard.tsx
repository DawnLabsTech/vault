'use client';

import { useStatus } from '@/hooks/useStatus';
import { MetricRow } from '@/components/shared/MetricRow';
import { CardSkeleton } from '@/components/shared/Skeleton';
import { formatUsd, formatNumber, isPositive } from '@/lib/format';

export function PortfolioCard() {
  const { data, isLoading } = useStatus();
  const s = data?.snapshot;

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">Portfolio</h3>
      {isLoading || !s ? (
        <CardSkeleton />
      ) : (
        <div className="space-y-0">
          <div className="flex justify-between items-center py-2 border-b border-vault-border/30">
            <span className="text-vault-muted text-sm">Total NAV</span>
            <span className="text-lg font-bold text-vault-text-bright">{formatUsd(s.totalNavUsdc)}</span>
          </div>
          <MetricRow label="Lending" value={formatUsd(s.lendingBalance)} />
          <MetricRow label="Binance USDC" value={formatUsd(s.binanceUsdcBalance)} />
          {/* DN Position group: spot + perp hedge */}
          <div className="mt-2 pt-2 border-t border-vault-border/50">
            <span className="text-vault-muted text-xs uppercase tracking-wider">DN Position</span>
            <MetricRow
              label="dawnSOL"
              value={`${formatNumber(s.dawnsolBalance)} (${formatUsd(s.dawnsolUsdcValue)})`}
            />
            {s.binancePerpSize !== 0 && (
              <MetricRow label="PERP Short" value={`${formatNumber(s.binancePerpSize)} SOL`} />
            )}
            <MetricRow
              label="PERP Unrealized"
              value={formatUsd(s.binancePerpUnrealizedPnl)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

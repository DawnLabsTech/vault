'use client';

import { usePerformance } from '@/hooks/usePerformance';
import { MetricRow } from '@/components/shared/MetricRow';
import { CardSkeleton } from '@/components/shared/Skeleton';
import { formatPct, formatUsd, isPositive } from '@/lib/format';

export function PerformanceCard() {
  const { data, isLoading } = usePerformance();

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">Performance</h3>
      {isLoading || !data ? (
        <CardSkeleton />
      ) : (
        <div className="space-y-0">
          <MetricRow
            label="Total Return"
            value={formatPct(data.totalReturn, 4)}
            valueColor={isPositive(data.totalReturn) ? 'positive' : 'negative'}
          />
          <MetricRow
            label="Annualized"
            value={data.totalDays >= 7 ? formatPct(data.annualizedReturn) : 'N/A (<7d)'}
            valueColor={data.totalDays >= 7 && !isPositive(data.annualizedReturn) ? 'negative' : data.totalDays >= 7 ? 'positive' : undefined}
          />
          <MetricRow label="Sharpe Ratio" value={data.totalDays >= 7 ? data.sharpeRatio.toFixed(2) : 'N/A (<7d)'} />
          <MetricRow
            label="Max Drawdown"
            value={formatPct(data.maxDrawdown, 4)}
            valueColor="negative"
          />
          <MetricRow
            label="Unrealized PnL"
            value={formatUsd(data.unrealizedPnl, 4)}
            valueColor={isPositive(data.unrealizedPnl) ? 'positive' : 'negative'}
          />
          <MetricRow
            label="Total Fees"
            value={formatUsd(-data.totalFees, 4)}
            valueColor="negative"
          />
          <MetricRow label="Trading Days" value={`${data.totalDays}`} />
        </div>
      )}
    </div>
  );
}

'use client';

import { useStatus } from '@/hooks/useStatus';
import { CardSkeleton } from '@/components/shared/Skeleton';
import { formatUsd } from '@/lib/format';

export function LendingCard() {
  const { data, isLoading } = useStatus();
  const s = data?.snapshot;
  const breakdown = s?.lendingBreakdown || {};
  const protocols = Object.entries(breakdown);

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">
        Lending Positions
      </h3>
      {isLoading || !s ? (
        <CardSkeleton />
      ) : protocols.length === 0 ? (
        <p className="text-vault-muted text-sm">No active lending positions</p>
      ) : (
        <div className="space-y-2">
          {protocols.map(([protocol, balance]) => (
            <div key={protocol} className="flex items-center justify-between py-1.5 border-b border-vault-border/30 last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-vault-accent" />
                <span className="text-sm capitalize">{protocol}</span>
              </div>
              <span className="text-sm font-semibold text-vault-text-bright">
                {formatUsd(balance)}
              </span>
            </div>
          ))}
          <div className="flex justify-between pt-2 border-t border-vault-border">
            <span className="text-vault-muted text-sm font-bold">Total</span>
            <span className="text-sm font-bold text-vault-text-bright">
              {formatUsd(s.lendingBalance)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

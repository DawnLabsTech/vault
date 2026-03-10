'use client';

import { usePnl } from '@/hooks/usePnl';
import { CardSkeleton } from '@/components/shared/Skeleton';
import { formatUsd, formatPct, isPositive } from '@/lib/format';

export function PnlTable() {
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString().split('T')[0]!;
  const { data, isLoading } = usePnl(from);

  const rows = data ? [...data].reverse() : [];

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4 overflow-x-auto">
      <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">
        Daily PnL (Last 30 Days)
      </h3>
      {isLoading ? (
        <CardSkeleton />
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-vault-border">
              <th className="text-left text-vault-muted py-2 px-2 font-medium">Date</th>
              <th className="text-right text-vault-muted py-2 px-2 font-medium">NAV Start</th>
              <th className="text-right text-vault-muted py-2 px-2 font-medium">NAV End</th>
              <th className="text-right text-vault-muted py-2 px-2 font-medium">Return</th>
              <th className="text-right text-vault-muted py-2 px-2 font-medium">Lending</th>
              <th className="text-right text-vault-muted py-2 px-2 font-medium">Funding</th>
              <th className="text-right text-vault-muted py-2 px-2 font-medium">Fees</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-vault-muted py-4">
                  No data
                </td>
              </tr>
            ) : (
              rows.map((p) => (
                <tr key={p.date} className="border-b border-vault-border/20 hover:bg-vault-accent-dim/5">
                  <td className="py-2 px-2">{p.date}</td>
                  <td className="text-right py-2 px-2">{formatUsd(p.startingNav)}</td>
                  <td className="text-right py-2 px-2">{formatUsd(p.endingNav)}</td>
                  <td className={`text-right py-2 px-2 font-semibold ${isPositive(p.dailyReturn) ? 'text-vault-accent' : 'text-vault-negative'}`}>
                    {formatPct(p.dailyReturn, 4)}
                  </td>
                  <td className="text-right py-2 px-2 text-vault-accent">
                    {formatUsd(p.lendingInterest, 4)}
                  </td>
                  <td className={`text-right py-2 px-2 ${isPositive(p.fundingReceived - p.fundingPaid) ? 'text-vault-accent' : 'text-vault-negative'}`}>
                    {formatUsd(p.fundingReceived - p.fundingPaid, 4)}
                  </td>
                  <td className="text-right py-2 px-2 text-vault-negative">
                    -{formatUsd(p.totalFees, 4)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

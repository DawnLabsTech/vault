'use client';

import { useEvents } from '@/hooks/useEvents';
import { CardSkeleton } from '@/components/shared/Skeleton';
import { formatDateTime, formatNumber } from '@/lib/format';

const eventTypeColors: Record<string, string> = {
  state_change: 'text-vault-warning',
  fr_payment: 'text-vault-accent',
  lending_interest: 'text-vault-accent',
  perp_open: 'text-[#00bbff]',
  perp_close: 'text-[#00bbff]',
  rebalance: 'text-vault-muted',
  swap: 'text-vault-warning',
  alert: 'text-vault-negative',
  transfer: 'text-vault-muted',
};

export function EventsTable() {
  const { data, isLoading } = useEvents(20);

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4 overflow-x-auto">
      <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">
        Recent Events
      </h3>
      {isLoading ? (
        <CardSkeleton />
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-vault-border">
              <th className="text-left text-vault-muted py-2 px-2 font-medium">Time</th>
              <th className="text-left text-vault-muted py-2 px-2 font-medium">Type</th>
              <th className="text-left text-vault-muted py-2 px-2 font-medium">Asset</th>
              <th className="text-right text-vault-muted py-2 px-2 font-medium">Amount</th>
              <th className="text-left text-vault-muted py-2 px-2 font-medium">Protocol</th>
            </tr>
          </thead>
          <tbody>
            {!data?.length ? (
              <tr>
                <td colSpan={5} className="text-center text-vault-muted py-4">
                  No events
                </td>
              </tr>
            ) : (
              data.map((e, i) => (
                <tr key={`${e.timestamp}-${i}`} className="border-b border-vault-border/20 hover:bg-vault-accent-dim/5">
                  <td className="py-2 px-2 text-vault-muted whitespace-nowrap">
                    {formatDateTime(e.timestamp)}
                  </td>
                  <td className={`py-2 px-2 font-semibold ${eventTypeColors[e.eventType] || 'text-vault-text'}`}>
                    {e.eventType}
                  </td>
                  <td className="py-2 px-2">{e.asset || '-'}</td>
                  <td className="text-right py-2 px-2">{formatNumber(e.amount)}</td>
                  <td className="py-2 px-2 text-vault-muted">{e.sourceProtocol || '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

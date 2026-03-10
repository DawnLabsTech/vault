'use client';

import { useStatus } from '@/hooks/useStatus';
import { MetricRow } from '@/components/shared/MetricRow';
import { StateBadge } from '@/components/shared/StateBadge';
import { CardSkeleton } from '@/components/shared/Skeleton';
import { formatDuration, formatDateTime } from '@/lib/format';

export function BotStatusCard() {
  const { data, isLoading } = useStatus();

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">Bot Status</h3>
      {isLoading || !data ? (
        <CardSkeleton />
      ) : (
        <div className="space-y-0">
          <div className="flex justify-between items-center py-1.5 border-b border-vault-border/30">
            <span className="text-vault-muted text-sm">State</span>
            <StateBadge state={data.state} />
          </div>
          <MetricRow label="Uptime" value={formatDuration(data.uptime)} />
          {data.startedAt && (
            <MetricRow label="Started" value={formatDateTime(data.startedAt)} />
          )}
        </div>
      )}
    </div>
  );
}

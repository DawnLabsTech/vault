'use client';

import { useApys } from '@/hooks/useApys';
import { useStatus } from '@/hooks/useStatus';
import { CardSkeleton } from '@/components/shared/Skeleton';
import { formatNumber, formatUsd } from '@/lib/format';

function formatApy(apy: number): string {
  return `${(apy * 100).toFixed(2)}%`;
}

export function AlphaPositionsCard() {
  const { data, isLoading } = useStatus();
  const { data: apysData } = useApys();
  const s = data?.snapshot;
  const dawnsolApy = apysData?.dawnsolApy;

  const hasAlphaPosition = !!s && (
    s.state === 'BASE_DN' ||
    s.dawnsolBalance > 0 ||
    s.dawnsolUsdcValue > 0 ||
    s.binancePerpSize !== 0 ||
    s.binancePerpUnrealizedPnl !== 0
  );

  const alphaNav = s
    ? s.dawnsolUsdcValue + s.binanceUsdcBalance + s.binancePerpUnrealizedPnl
    : 0;

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider mb-3">
        Alpha Layer Positions
      </h3>

      {isLoading || !s ? (
        <CardSkeleton />
      ) : hasAlphaPosition ? (
        <div className="rounded-md p-3 border border-vault-border/30">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-vault-warning" />
              <span className="text-sm font-semibold text-vault-text-bright">DN Hedge</span>
            </div>
            <span className="text-sm font-bold text-vault-text-bright">{formatUsd(alphaNav)}</span>
          </div>

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-vault-muted">dawnSOL</span>
              <div className="font-bold text-vault-text-bright">
                {formatNumber(s.dawnsolBalance)}
                {dawnsolApy !== undefined && (
                  <span className="block text-vault-accent font-medium">{formatApy(dawnsolApy)}</span>
                )}
              </div>
            </div>
            <div>
              <span className="text-vault-muted">dawnSOL Value</span>
              <div className="font-bold text-vault-text-bright">{formatUsd(s.dawnsolUsdcValue)}</div>
            </div>
            <div>
              <span className="text-vault-muted">Binance USDC</span>
              <div className="font-bold text-vault-text-bright">{formatUsd(s.binanceUsdcBalance)}</div>
            </div>
            <div>
              <span className="text-vault-muted">PERP Short</span>
              <div className="font-bold text-vault-text-bright">
                {s.binancePerpSize !== 0 ? `${formatNumber(s.binancePerpSize)} SOL` : '-'}
              </div>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-vault-border/30 grid grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-vault-muted">PERP Unrealized</span>
              <div className="font-bold text-vault-text-bright">{formatUsd(s.binancePerpUnrealizedPnl)}</div>
            </div>
            <div>
              <span className="text-vault-muted">Layer Note</span>
              <div className="font-bold text-vault-warning">Conditional funding-capture hedge</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-md p-3 border border-dashed border-vault-border/40 bg-vault-bg/30">
          <p className="text-vault-muted text-sm">Alpha layer parked. No live DN exposure.</p>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 text-xs mt-3">
            <div>
              <span className="text-vault-muted">dawnSOL</span>
              <div className="font-bold text-vault-text-bright">-</div>
            </div>
            <div>
              <span className="text-vault-muted">Binance USDC</span>
              <div className="font-bold text-vault-text-bright">-</div>
            </div>
            <div>
              <span className="text-vault-muted">PERP Short</span>
              <div className="font-bold text-vault-text-bright">-</div>
            </div>
            <div>
              <span className="text-vault-muted">Funding Gate</span>
              <div className="font-bold text-vault-warning">Standby until funding confirms</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

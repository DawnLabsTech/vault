'use client';

import type { BotState } from '@/types/api';

const stateStyles: Record<string, string> = {
  BASE_ONLY: 'bg-vault-accent/15 text-vault-accent border-vault-accent/30',
  BASE_DN: 'bg-vault-warning/15 text-vault-warning border-vault-warning/30',
  UNKNOWN: 'bg-vault-muted/15 text-vault-muted border-vault-muted/30',
};

export function StateBadge({ state }: { state: BotState }) {
  const style = stateStyles[state] || stateStyles.UNKNOWN;
  return (
    <span className={`inline-block px-3 py-1 rounded text-xs font-bold border ${style}`}>
      {state}
    </span>
  );
}

export function formatUsd(value: number | null | undefined, decimals = 2): string {
  if (value == null) return '-';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function formatPct(value: number | null | undefined, decimals = 2): string {
  if (value == null) return '-';
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatNumber(value: number | null | undefined, decimals = 4): string {
  if (value == null) return '-';
  return value.toFixed(decimals);
}

export function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  if (days > 0) return `${days}d ${remainHours}h`;
  return `${hours}h`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function isPositive(value: number | null | undefined): boolean {
  return value != null && value >= 0;
}

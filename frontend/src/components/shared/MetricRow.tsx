'use client';

interface MetricRowProps {
  label: string;
  value: string;
  valueColor?: 'default' | 'positive' | 'negative' | 'warning';
}

const colorMap = {
  default: 'text-vault-text-bright',
  positive: 'text-vault-accent',
  negative: 'text-vault-negative',
  warning: 'text-vault-warning',
};

export function MetricRow({ label, value, valueColor = 'default' }: MetricRowProps) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-vault-border/30 last:border-b-0">
      <span className="text-vault-muted text-sm">{label}</span>
      <span className={`text-sm font-semibold ${colorMap[valueColor]}`}>{value}</span>
    </div>
  );
}

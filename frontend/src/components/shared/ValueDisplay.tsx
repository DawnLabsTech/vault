'use client';

interface ValueDisplayProps {
  label: string;
  value: string;
  size?: 'sm' | 'lg';
  valueColor?: string;
}

export function ValueDisplay({ label, value, size = 'sm', valueColor }: ValueDisplayProps) {
  return (
    <div>
      <p className="text-vault-muted text-xs uppercase tracking-wider">{label}</p>
      <p className={`font-bold ${size === 'lg' ? 'text-2xl' : 'text-sm'} ${valueColor || 'text-vault-text-bright'}`}>
        {value}
      </p>
    </div>
  );
}

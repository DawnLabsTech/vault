import type { ReactNode } from 'react';

interface SectionHeaderProps {
  title: string;
  description?: ReactNode;
}

export function SectionHeader({ title, description }: SectionHeaderProps) {
  return (
    <div className="flex flex-col gap-2 mb-3 md:flex-row md:items-end md:justify-between">
      <div className="flex items-center gap-3">
        <h2 className="text-vault-accent text-xs font-bold uppercase tracking-wider">
          {title}
        </h2>
        <div className="hidden md:block h-px w-20 bg-vault-border/40" />
      </div>
      {description && (
        <p className="text-[11px] text-vault-muted uppercase tracking-wider">
          {description}
        </p>
      )}
    </div>
  );
}

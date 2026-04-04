'use client';

import { useEffect, useState } from 'react';

export function Header() {
  const [countdown, setCountdown] = useState(30);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((c) => (c <= 0 ? 30 : c - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="flex items-center justify-between mb-6">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-xl font-bold text-vault-accent">Dawn Vault Dashboard</h1>
          <p className="text-[11px] uppercase tracking-wider text-vault-muted">
            Base-first mode: Multiply primary, Lending supplementary, DN conditional
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-xs text-vault-accent">
          <span className="w-2 h-2 rounded-full bg-vault-accent animate-pulse" />
          LIVE
        </span>
        <span className="text-xs text-vault-muted">{countdown}s</span>
      </div>
    </header>
  );
}

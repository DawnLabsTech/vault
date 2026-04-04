'use client';

import { Header } from '@/components/layout/Header';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { BotStatusCard } from '@/components/cards/BotStatusCard';
import { PortfolioCard } from '@/components/cards/PortfolioCard';
import { PerformanceCard } from '@/components/cards/PerformanceCard';
import { AlphaPositionsCard } from '@/components/cards/AlphaPositionsCard';
import { LendingCard } from '@/components/cards/LendingCard';
import { MultiplyCard } from '@/components/cards/MultiplyCard';
import { PnlChart } from '@/components/charts/PnlChart';
import { FrChart } from '@/components/charts/FrChart';
import { AllocationChart } from '@/components/charts/AllocationChart';
import { PnlTable } from '@/components/tables/PnlTable';
import { EventsTable } from '@/components/tables/EventsTable';

export default function Dashboard() {
  return (
    <main className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto">
      <Header />

      {/* Top cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <BotStatusCard />
        <PortfolioCard />
        <PerformanceCard />
      </div>

      {/* Signals + Allocation */}
      <section className="mb-4">
        <SectionHeader
          title="Signals & Allocation"
          description="Funding gate and live split between the base sleeve and alpha sleeve"
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <FrChart />
          <AllocationChart />
        </div>
      </section>

      {/* PnL Overview */}
      <section className="mb-5">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <PnlChart />
          <PnlTable />
        </div>
      </section>

      {/* Base Layer */}
      <section className="mb-5">
        <SectionHeader
          title="Base Layer"
          description="Multiply is primary; lending absorbs overflow, diversification, and idle deployable cash"
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <MultiplyCard />
          <LendingCard />
        </div>
      </section>

      {/* Alpha Layer */}
      <section className="mb-5">
        <SectionHeader
          title="Alpha Layer"
          description="Opportunistic DN overlay that stays parked until funding conditions improve"
        />
        <div className="grid grid-cols-1 gap-4">
          <AlphaPositionsCard />
        </div>
      </section>

      {/* Events */}
      <div className="mb-4">
        <EventsTable />
      </div>

      {/* Footer */}
      <footer className="text-center text-vault-muted text-xs py-4 border-t border-vault-border/30">
        Dawn Vault Strategy Bot &mdash; Real-time Dashboard
      </footer>
    </main>
  );
}

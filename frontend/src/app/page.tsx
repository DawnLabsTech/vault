'use client';

import { Header } from '@/components/layout/Header';
import { BotStatusCard } from '@/components/cards/BotStatusCard';
import { PortfolioCard } from '@/components/cards/PortfolioCard';
import { PerformanceCard } from '@/components/cards/PerformanceCard';
import { LendingCard } from '@/components/cards/LendingCard';
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

      {/* PnL Chart (full width) */}
      <div className="mb-4">
        <PnlChart />
      </div>

      {/* FR Chart + Allocation */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-4">
        <div className="lg:col-span-3">
          <FrChart />
        </div>
        <div className="lg:col-span-2">
          <AllocationChart />
        </div>
      </div>

      {/* Lending */}
      <div className="mb-4">
        <LendingCard />
      </div>

      {/* PnL Table */}
      <div className="mb-4">
        <PnlTable />
      </div>

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

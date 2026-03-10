'use client';

import { useEffect, useRef, useState } from 'react';
import { useFrHistory } from '@/hooks/useFr';
import { Skeleton } from '@/components/shared/Skeleton';
import { FR_ENTRY_THRESHOLD, FR_EXIT_THRESHOLD, FR_EMERGENCY_THRESHOLD } from '@/lib/constants';
import { createChart, LineSeries, type IChartApi, type ISeriesApi, ColorType } from 'lightweight-charts';

type Exchange = 'binance' | 'drift';

const EXCHANGE_CONFIG: Record<Exchange, { label: string; periodsPerDay: number }> = {
  binance: { label: 'Binance SOLUSDC', periodsPerDay: 3 },
  drift: { label: 'Drift SOL-PERP', periodsPerDay: 24 },
};

export function FrChart() {
  const [exchange, setExchange] = useState<Exchange>('binance');
  const { label, periodsPerDay } = EXCHANGE_CONFIG[exchange];
  const { data, isLoading } = useFrHistory(3, exchange);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    fr: ISeriesApi<'Line'>;
    entry: ISeriesApi<'Line'>;
    exit: ISeriesApi<'Line'>;
    emergency: ISeriesApi<'Line'>;
  } | null>(null);

  // Initialize chart + series once when container is available
  useEffect(() => {
    if (!containerRef.current || chartRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#1a1a1a' },
        textColor: '#888',
        fontFamily: "'SF Mono', 'JetBrains Mono', monospace",
      },
      grid: {
        vertLines: { color: '#222' },
        horzLines: { color: '#222' },
      },
      width: containerRef.current.clientWidth,
      height: 250,
      timeScale: { borderColor: '#333', timeVisible: true },
      rightPriceScale: { borderColor: '#333' },
    });
    chartRef.current = chart;

    const fr = chart.addSeries(LineSeries, {
      color: '#00ff88',
      lineWidth: 1,
      priceLineVisible: false,
    });
    const entry = chart.addSeries(LineSeries, {
      color: '#ffaa00',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
    });
    const exit = chart.addSeries(LineSeries, {
      color: '#888',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
    });
    const emergency = chart.addSeries(LineSeries, {
      color: '#ff4444',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
    });
    seriesRef.current = { fr, entry, exit, emergency };

    const observer = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  });

  // Update data when it changes
  useEffect(() => {
    if (!seriesRef.current || !data?.length) return;

    const sorted = [...data].sort((a, b) => a.fundingTime - b.fundingTime);
    const frData = sorted.map((d) => ({
      time: Math.floor(d.fundingTime / 1000) as any,
      value: d.fundingRate * 100 * periodsPerDay * 365, // annualized %
    }));

    seriesRef.current.fr.setData(frData);
    seriesRef.current.entry.setData(
      frData.map((d) => ({ time: d.time, value: FR_ENTRY_THRESHOLD }))
    );
    seriesRef.current.exit.setData(
      frData.map((d) => ({ time: d.time, value: FR_EXIT_THRESHOLD }))
    );
    seriesRef.current.emergency.setData(
      frData.map((d) => ({ time: d.time, value: FR_EMERGENCY_THRESHOLD }))
    );

    chartRef.current?.timeScale().fitContent();
  }, [data, periodsPerDay]);

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider">
            Funding Rate (Annualized %) — 3M
          </h3>
          <div className="flex bg-vault-bg rounded overflow-hidden border border-vault-border">
            <button
              onClick={() => setExchange('binance')}
              className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                exchange === 'binance'
                  ? 'bg-vault-accent text-vault-bg'
                  : 'text-vault-muted hover:text-vault-text'
              }`}
            >
              Binance
            </button>
            <button
              onClick={() => setExchange('drift')}
              className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                exchange === 'drift'
                  ? 'bg-vault-accent text-vault-bg'
                  : 'text-vault-muted hover:text-vault-text'
              }`}
            >
              Drift
            </button>
          </div>
          <span className="text-vault-muted text-[10px]">{label}</span>
        </div>
        <div className="flex gap-3 text-[10px]">
          <span className="text-vault-warning">-- Entry ({FR_ENTRY_THRESHOLD}%)</span>
          <span className="text-vault-muted">-- Exit ({FR_EXIT_THRESHOLD}%)</span>
          <span className="text-vault-negative">-- Emergency ({FR_EMERGENCY_THRESHOLD}%)</span>
        </div>
      </div>
      {isLoading ? (
        <Skeleton className="h-[250px] w-full" />
      ) : (
        <div ref={containerRef} />
      )}
    </div>
  );
}

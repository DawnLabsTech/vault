'use client';

import { useEffect, useRef } from 'react';
import { useFrHistory, useActivePerpExchange } from '@/hooks/useFr';
import { Skeleton } from '@/components/shared/Skeleton';
import { FR_ENTRY_THRESHOLD, FR_EXIT_THRESHOLD, FR_EMERGENCY_THRESHOLD } from '@/lib/constants';
import { createChart, LineSeries, type IChartApi, type ISeriesApi, ColorType } from 'lightweight-charts';

// Binance: 8h intervals (3/day), Drift: 1h intervals (24/day)
const BINANCE_PERIODS_PER_DAY = 3;
const DRIFT_PERIODS_PER_DAY = 24;

function toAnnualized(fr: number, periodsPerDay: number): number {
  return fr * 100 * periodsPerDay * 365;
}

export function FrChart() {
  const { data: configData } = useActivePerpExchange();
  const activeExchange = (configData?.perpExchange ?? 'binance') as 'binance' | 'drift';

  const { data: binanceData, isLoading: binanceLoading } = useFrHistory(3, 'binance');
  const { data: driftData, isLoading: driftLoading } = useFrHistory(3, 'drift');

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    binanceFr: ISeriesApi<'Line'>;
    driftFr: ISeriesApi<'Line'>;
    entry: ISeriesApi<'Line'>;
    exit: ISeriesApi<'Line'>;
    emergency: ISeriesApi<'Line'>;
  } | null>(null);

  // Initialize chart once
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

    const binanceFr = chart.addSeries(LineSeries, {
      color: '#00ff88',
      lineWidth: 1,
      priceLineVisible: false,
    });
    const driftFr = chart.addSeries(LineSeries, {
      color: '#7B68EE',
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
    seriesRef.current = { binanceFr, driftFr, entry, exit, emergency };

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

  // Update data when either dataset changes
  useEffect(() => {
    if (!seriesRef.current) return;

    // Binance series
    if (binanceData?.length) {
      const sorted = [...binanceData].sort((a, b) => a.fundingTime - b.fundingTime);
      seriesRef.current.binanceFr.setData(
        sorted.map((d) => ({
          time: Math.floor(d.fundingTime / 1000) as any,
          value: toAnnualized(d.fundingRate, BINANCE_PERIODS_PER_DAY),
        }))
      );
    }

    // Drift series
    if (driftData?.length) {
      const sorted = [...driftData].sort((a, b) => a.fundingTime - b.fundingTime);
      seriesRef.current.driftFr.setData(
        sorted.map((d) => ({
          time: Math.floor(d.fundingTime / 1000) as any,
          value: toAnnualized(d.fundingRate, DRIFT_PERIODS_PER_DAY),
        }))
      );
    }

    // Threshold lines — use whichever data range is available
    const allTimes: number[] = [];
    if (binanceData?.length) {
      allTimes.push(
        ...binanceData.map((d) => Math.floor(d.fundingTime / 1000))
      );
    }
    if (driftData?.length) {
      allTimes.push(
        ...driftData.map((d) => Math.floor(d.fundingTime / 1000))
      );
    }
    if (allTimes.length > 0) {
      const minTime = Math.min(...allTimes);
      const maxTime = Math.max(...allTimes);
      const thresholdPoints = [
        { time: minTime as any, value: 0 },
        { time: maxTime as any, value: 0 },
      ];
      seriesRef.current.entry.setData(
        thresholdPoints.map((p) => ({ ...p, value: FR_ENTRY_THRESHOLD }))
      );
      seriesRef.current.exit.setData(
        thresholdPoints.map((p) => ({ ...p, value: FR_EXIT_THRESHOLD }))
      );
      seriesRef.current.emergency.setData(
        thresholdPoints.map((p) => ({ ...p, value: FR_EMERGENCY_THRESHOLD }))
      );
    }

    chartRef.current?.timeScale().fitContent();
  }, [binanceData, driftData]);

  const isLoading = binanceLoading && driftLoading;

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider">
          Funding Rate (Annualized %) — 3M
        </h3>
        <div className="flex gap-3 text-[10px]">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2.5 h-0.5 bg-[#00ff88] rounded-full" />
            <span className="text-[#00ff88]">Binance</span>
            {activeExchange === 'binance' && (
              <span className="text-[8px] px-1 bg-[#00ff88]/20 text-[#00ff88] rounded-sm font-bold">ACTIVE</span>
            )}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2.5 h-0.5 bg-[#7B68EE] rounded-full" />
            <span className="text-[#7B68EE]">Drift</span>
            {activeExchange === 'drift' && (
              <span className="text-[8px] px-1 bg-[#7B68EE]/20 text-[#7B68EE] rounded-sm font-bold">ACTIVE</span>
            )}
          </span>
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

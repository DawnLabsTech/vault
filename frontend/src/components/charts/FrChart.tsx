'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useFrHistory, useActivePerpExchange } from '@/hooks/useFr';
import { Skeleton } from '@/components/shared/Skeleton';
import { FR_ENTRY_THRESHOLD, FR_EXIT_THRESHOLD, FR_EMERGENCY_THRESHOLD } from '@/lib/constants';
import { createChart, LineSeries, type IChartApi, type ISeriesApi, ColorType } from 'lightweight-charts';

// Binance: 8h intervals (3/day), Drift: 1h intervals (24/day)
const BINANCE_PERIODS_PER_DAY = 3;
const DRIFT_PERIODS_PER_DAY = 24;

const BINANCE_COLOR = '#00ff88';
const DRIFT_COLOR = '#C4B5FD'; // bright violet for visibility on dark bg

function toAnnualized(fr: number, periodsPerDay: number): number {
  return fr * 100 * periodsPerDay * 365;
}

export function FrChart() {
  const { data: configData } = useActivePerpExchange();
  const activeExchange = (configData?.perpExchange ?? 'binance') as 'binance' | 'drift';

  const [showBinance, setShowBinance] = useState(true);
  const [showDrift, setShowDrift] = useState(true);

  // Drift API returns ~30 days; match Binance to same period
  const { data: binanceData, isLoading: binanceLoading } = useFrHistory(1, 'binance');
  const { data: driftData, isLoading: driftLoading } = useFrHistory(1, 'drift');

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
      color: BINANCE_COLOR,
      lineWidth: 1,
      priceLineVisible: false,
    });
    const driftFr = chart.addSeries(LineSeries, {
      color: DRIFT_COLOR,
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

  // Update data when datasets or visibility changes
  useEffect(() => {
    if (!seriesRef.current) return;

    // Determine shared time range: clip to Drift's available range when both are shown
    let clipStart = 0;
    if (driftData?.length) {
      const driftTimes = driftData.map((d) => d.fundingTime);
      clipStart = Math.min(...driftTimes);
    }

    // Binance series — clip to Drift's time range so both align
    if (showBinance && binanceData?.length) {
      const clipped = binanceData
        .filter((d) => d.fundingTime >= clipStart)
        .sort((a, b) => a.fundingTime - b.fundingTime);
      seriesRef.current.binanceFr.setData(
        clipped.map((d) => ({
          time: Math.floor(d.fundingTime / 1000) as any,
          value: toAnnualized(d.fundingRate, BINANCE_PERIODS_PER_DAY),
        }))
      );
    } else {
      seriesRef.current.binanceFr.setData([]);
    }

    // Drift series
    if (showDrift && driftData?.length) {
      const sorted = [...driftData].sort((a, b) => a.fundingTime - b.fundingTime);
      seriesRef.current.driftFr.setData(
        sorted.map((d) => ({
          time: Math.floor(d.fundingTime / 1000) as any,
          value: toAnnualized(d.fundingRate, DRIFT_PERIODS_PER_DAY),
        }))
      );
    } else {
      seriesRef.current.driftFr.setData([]);
    }

    // Threshold lines
    const allTimes: number[] = [];
    if (showBinance && binanceData?.length) {
      allTimes.push(...binanceData.filter((d) => d.fundingTime >= clipStart).map((d) => Math.floor(d.fundingTime / 1000)));
    }
    if (showDrift && driftData?.length) {
      allTimes.push(...driftData.map((d) => Math.floor(d.fundingTime / 1000)));
    }
    if (allTimes.length > 0) {
      const minTime = Math.min(...allTimes);
      const maxTime = Math.max(...allTimes);
      const pts = [{ time: minTime as any, value: 0 }, { time: maxTime as any, value: 0 }];
      seriesRef.current.entry.setData(pts.map((p) => ({ ...p, value: FR_ENTRY_THRESHOLD })));
      seriesRef.current.exit.setData(pts.map((p) => ({ ...p, value: FR_EXIT_THRESHOLD })));
      seriesRef.current.emergency.setData(pts.map((p) => ({ ...p, value: FR_EMERGENCY_THRESHOLD })));
    }

    chartRef.current?.timeScale().fitContent();
  }, [binanceData, driftData, showBinance, showDrift]);

  const toggleBinance = useCallback(() => setShowBinance((v) => !v), []);
  const toggleDrift = useCallback(() => setShowDrift((v) => !v), []);

  const isLoading = binanceLoading && driftLoading;

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider">
            Funding Rate (Annualized %) — 1M
          </h3>
          {/* Exchange toggles */}
          <div className="flex gap-1">
            <button
              onClick={toggleBinance}
              className={`flex flex-col items-center px-2 py-0.5 rounded border text-[10px] font-medium transition-colors ${
                showBinance
                  ? 'border-[#00ff88]/40 bg-[#00ff88]/10'
                  : 'border-vault-border bg-transparent opacity-40'
              }`}
            >
              <span className="flex items-center gap-1">
                <span className={`inline-block w-2 h-0.5 rounded-full`} style={{ background: BINANCE_COLOR }} />
                <span style={{ color: showBinance ? BINANCE_COLOR : '#888' }}>Binance</span>
              </span>
              {activeExchange === 'binance' && (
                <span className="text-[7px] text-[#00ff88]/70 font-bold leading-none mt-0.5">ACTIVE</span>
              )}
            </button>
            <button
              onClick={toggleDrift}
              className={`flex flex-col items-center px-2 py-0.5 rounded border text-[10px] font-medium transition-colors ${
                showDrift
                  ? 'border-[#C4B5FD]/40 bg-[#C4B5FD]/10'
                  : 'border-vault-border bg-transparent opacity-40'
              }`}
            >
              <span className="flex items-center gap-1">
                <span className={`inline-block w-2 h-0.5 rounded-full`} style={{ background: DRIFT_COLOR }} />
                <span style={{ color: showDrift ? DRIFT_COLOR : '#888' }}>Drift</span>
              </span>
              {activeExchange === 'drift' && (
                <span className="text-[7px] text-[#C4B5FD]/70 font-bold leading-none mt-0.5">ACTIVE</span>
              )}
            </button>
          </div>
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

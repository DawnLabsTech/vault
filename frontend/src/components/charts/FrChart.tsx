'use client';

import { useEffect, useRef } from 'react';
import { useFrHistory } from '@/hooks/useFr';
import { Skeleton } from '@/components/shared/Skeleton';
import { FR_ENTRY_THRESHOLD, FR_EXIT_THRESHOLD, FR_EMERGENCY_THRESHOLD } from '@/lib/constants';
import { createChart, LineSeries, type IChartApi, type ISeriesApi, ColorType } from 'lightweight-charts';

const BINANCE_PERIODS_PER_DAY = 3;
const BINANCE_COLOR = '#00ff88';

function toAnnualized(fr: number, periodsPerDay: number): number {
  return fr * 100 * periodsPerDay * 365;
}

export function FrChart() {
  const { data: binanceData, isLoading } = useFrHistory(1);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    binanceFr: ISeriesApi<'Line'>;
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
    seriesRef.current = { binanceFr, entry, exit, emergency };

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update data when dataset changes
  useEffect(() => {
    if (!seriesRef.current) return;

    if (binanceData?.length) {
      const sorted = [...binanceData].sort((a, b) => a.fundingTime - b.fundingTime);
      seriesRef.current.binanceFr.setData(
        sorted.map((d) => ({
          time: Math.floor(d.fundingTime / 1000) as any,
          value: toAnnualized(d.fundingRate, BINANCE_PERIODS_PER_DAY),
        }))
      );

      // Threshold lines
      const times = sorted.map((d) => Math.floor(d.fundingTime / 1000));
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const pts = [{ time: minTime as any, value: 0 }, { time: maxTime as any, value: 0 }];
      seriesRef.current.entry.setData(pts.map((p) => ({ ...p, value: FR_ENTRY_THRESHOLD })));
      seriesRef.current.exit.setData(pts.map((p) => ({ ...p, value: FR_EXIT_THRESHOLD })));
      seriesRef.current.emergency.setData(pts.map((p) => ({ ...p, value: FR_EMERGENCY_THRESHOLD })));
    } else {
      seriesRef.current.binanceFr.setData([]);
    }

    chartRef.current?.timeScale().fitContent();
  }, [binanceData]);

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex flex-col gap-1.5">
          <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider">
            Funding Rate (Annualized %) — 1M
          </h3>
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-medium border-[#00ff88]/30 bg-[#00ff88]/10 text-[#00ff88] w-fit">
            <span className="inline-block w-2.5 h-[2px] rounded-full" style={{ background: BINANCE_COLOR }} />
            Binance
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-[10px] shrink-0">
          <span className="text-vault-warning">-- Entry ({FR_ENTRY_THRESHOLD}%)</span>
          <span className="text-vault-muted">-- Exit ({FR_EXIT_THRESHOLD}%)</span>
          <span className="text-vault-negative">-- Emergency ({FR_EMERGENCY_THRESHOLD}%)</span>
        </div>
      </div>
      {isLoading && <Skeleton className="h-[250px] w-full" />}
      <div ref={containerRef} style={{ display: isLoading ? 'none' : undefined }} />
    </div>
  );
}

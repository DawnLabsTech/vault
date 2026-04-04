'use client';

import { useEffect, useRef, useState } from 'react';
import { usePnl } from '@/hooks/usePnl';
import { usePerformance } from '@/hooks/usePerformance';
import { Skeleton } from '@/components/shared/Skeleton';
import { createChart, AreaSeries, type IChartApi, type ISeriesApi, ColorType } from 'lightweight-charts';
import { formatPct } from '@/lib/format';

type Range = '1W' | '1M' | 'ALL';

function getFallbackDays(range: Range): number {
  switch (range) {
    case '1W': return 7;
    case '1M': return 30;
    case 'ALL': return 30;
  }
}

function getFromDate(range: Range): string | undefined {
  const now = Date.now();
  switch (range) {
    case '1W': return new Date(now - 7 * 86_400_000).toISOString().split('T')[0];
    case '1M': return new Date(now - 30 * 86_400_000).toISOString().split('T')[0];
    case 'ALL': return undefined;
  }
}

function buildFlatZeroSeries(range: Range) {
  const days = getFallbackDays(range);
  const data = [];

  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().split('T')[0]!;
    data.push({ time: date as string, value: 0 });
  }

  return data;
}

export function PnlChart() {
  const [range, setRange] = useState<Range>('ALL');
  const from = getFromDate(range);
  const { data, isLoading } = usePnl(from);
  const { data: perfData } = usePerformance();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

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
      height: 240,
      timeScale: { borderColor: '#333' },
      rightPriceScale: { borderColor: '#333' },
    });
    chartRef.current = chart;

    const series = chart.addSeries(AreaSeries, {
      topColor: 'rgba(0, 255, 136, 0.3)',
      bottomColor: 'rgba(0, 255, 136, 0.02)',
      lineColor: '#00ff88',
      lineWidth: 2,
    });
    seriesRef.current = series;

    const observer = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
        chart.timeScale().fitContent();
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;

    const chartData = data?.length
      ? data.map((d) => ({
          time: d.date as string,
          value: d.cumulativeReturn * 100,
        }))
      : buildFlatZeroSeries(range);

    seriesRef.current.setData(chartData);
    chartRef.current?.timeScale().fitContent();
  }, [data, range]);

  const ranges: Range[] = ['1W', '1M', 'ALL'];

  const annualizedLabel = perfData && perfData.totalDays >= 7
    ? formatPct(perfData.annualizedReturn)
    : null;
  const hasData = !!data?.length;

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider">
            Cumulative PnL (%)
          </h3>
          {annualizedLabel && (
            <span className="text-[10px] text-vault-muted">
              Annualized:{' '}
              <span className={perfData!.annualizedReturn >= 0 ? 'text-vault-accent' : 'text-vault-negative'}>
                {annualizedLabel}
              </span>
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2 py-0.5 text-xs rounded ${
                range === r
                  ? 'bg-vault-accent/20 text-vault-accent'
                  : 'text-vault-muted hover:text-vault-text'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      {isLoading && <Skeleton className="h-[240px] w-full" />}
      <div className="relative">
        <div ref={containerRef} style={{ display: isLoading ? 'none' : undefined }} />
        {!isLoading && !hasData && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-2xl font-bold text-vault-text-bright">
              {formatPct(0)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

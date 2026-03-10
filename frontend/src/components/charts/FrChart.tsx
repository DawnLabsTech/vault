'use client';

import { useEffect, useRef } from 'react';
import { useFr } from '@/hooks/useFr';
import { Skeleton } from '@/components/shared/Skeleton';
import { FR_ENTRY_THRESHOLD, FR_EXIT_THRESHOLD, FR_EMERGENCY_THRESHOLD } from '@/lib/constants';
import { createChart, LineSeries, type IChartApi, ColorType } from 'lightweight-charts';

export function FrChart() {
  const { data, isLoading } = useFr();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

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
      height: 250,
      timeScale: { borderColor: '#333', timeVisible: true },
      rightPriceScale: { borderColor: '#333' },
    });
    chartRef.current = chart;

    const observer = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !data?.length) return;
    const chart = chartRef.current;

    const sorted = [...data].sort((a, b) => a.fundingTime - b.fundingTime);

    const frData = sorted.map((d) => ({
      time: Math.floor(d.fundingTime / 1000) as any,
      value: d.fundingRate * 100 * 3 * 365, // annualized %
    }));

    // FR line
    const frSeries = chart.addSeries(LineSeries, {
      color: '#00ff88',
      lineWidth: 1,
      priceLineVisible: false,
    });
    frSeries.setData(frData);

    // Threshold lines
    const entryLine = chart.addSeries(LineSeries, {
      color: '#ffaa00',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
    });
    entryLine.setData(
      frData.map((d) => ({ time: d.time, value: FR_ENTRY_THRESHOLD }))
    );

    const exitLine = chart.addSeries(LineSeries, {
      color: '#888',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
    });
    exitLine.setData(
      frData.map((d) => ({ time: d.time, value: FR_EXIT_THRESHOLD }))
    );

    const emergencyLine = chart.addSeries(LineSeries, {
      color: '#ff4444',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
    });
    emergencyLine.setData(
      frData.map((d) => ({ time: d.time, value: FR_EMERGENCY_THRESHOLD }))
    );

    chart.timeScale().fitContent();

    return () => {
      chart.removeSeries(frSeries);
      chart.removeSeries(entryLine);
      chart.removeSeries(exitLine);
      chart.removeSeries(emergencyLine);
    };
  }, [data]);

  return (
    <div className="bg-vault-card border border-vault-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider">
          Funding Rate (Annualized %)
        </h3>
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

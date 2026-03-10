import { NextRequest, NextResponse } from 'next/server';

const BINANCE_FAPI = 'https://fapi.binance.com';
const DEFAULT_SYMBOL = 'SOLUSDC';
const DEFAULT_MONTHS = 3;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const symbol = searchParams.get('symbol') || DEFAULT_SYMBOL;
  const months = parseInt(searchParams.get('months') || String(DEFAULT_MONTHS));

  const startTime = Date.now() - months * 30 * 24 * 60 * 60 * 1000;

  try {
    // Binance allows max 1000 records per request, 3 months ≈ 270 records
    const url = `${BINANCE_FAPI}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&limit=1000`;
    const res = await fetch(url, { next: { revalidate: 300 } }); // cache 5min

    if (!res.ok) {
      return NextResponse.json({ error: 'Binance API error' }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('Binance FR fetch error:', err);
    return NextResponse.json({ error: 'Failed to fetch funding rate history' }, { status: 502 });
  }
}

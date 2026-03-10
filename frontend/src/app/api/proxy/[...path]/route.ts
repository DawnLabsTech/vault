import { NextRequest, NextResponse } from 'next/server';

const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:3000';
const BOT_API_TOKEN = process.env.BOT_API_TOKEN || '';
const FRONTEND_API_SECRET = process.env.FRONTEND_API_SECRET || '';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  // Require auth when secret is configured
  if (FRONTEND_API_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${FRONTEND_API_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const { path } = await params;
  const apiPath = '/api/' + path.join('/');
  const searchParams = request.nextUrl.searchParams.toString();
  const url = `${BOT_API_URL}${apiPath}${searchParams ? '?' + searchParams : ''}`;

  try {
    const headers: Record<string, string> = {};
    if (BOT_API_TOKEN) {
      headers['Authorization'] = `Bearer ${BOT_API_TOKEN}`;
    }

    const res = await fetch(url, {
      headers,
      next: { revalidate: 0 },
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error('Proxy error:', err);
    return NextResponse.json(
      { error: 'Failed to reach bot API' },
      { status: 502 }
    );
  }
}

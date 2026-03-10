import { NextRequest, NextResponse } from 'next/server';

const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:3000';
const BOT_API_TOKEN = process.env.BOT_API_TOKEN || '';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
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

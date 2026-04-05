import { NextRequest, NextResponse } from 'next/server';

const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:3000';
const BOT_API_TOKEN = process.env.BOT_API_TOKEN || '';
const FRONTEND_API_SECRET = process.env.FRONTEND_API_SECRET || '';

function checkAuth(request: NextRequest): NextResponse | null {
  if (FRONTEND_API_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${FRONTEND_API_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  return null;
}

function buildUrl(path: string[], searchParams?: string): string {
  const apiPath = '/api/' + path.join('/');
  return `${BOT_API_URL}${apiPath}${searchParams ? '?' + searchParams : ''}`;
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (BOT_API_TOKEN) {
    headers['Authorization'] = `Bearer ${BOT_API_TOKEN}`;
  }
  return headers;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;

  const { path } = await params;
  const url = buildUrl(path, request.nextUrl.searchParams.toString());

  try {
    const res = await fetch(url, {
      headers: getHeaders(),
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;

  const { path } = await params;
  const url = buildUrl(path);

  try {
    const body = await request.text();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...getHeaders(),
        'Content-Type': 'application/json',
      },
      body,
    });

    // For SSE responses, stream through directly
    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error('Proxy POST error:', err);
    return NextResponse.json(
      { error: 'Failed to reach bot API' },
      { status: 502 }
    );
  }
}

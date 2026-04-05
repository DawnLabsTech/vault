import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthChallengeHeaders,
  isAuthorizedRequest,
} from '@/lib/server/auth';

const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:3000';
const BOT_API_TOKEN = process.env.BOT_API_TOKEN || '';
const FRONTEND_API_SECRET = process.env.FRONTEND_API_SECRET || '';
const REQUEST_TIMEOUT_MS = 15_000;

const ALLOWED_GET_PATHS = new Set([
  'status',
  'apys',
  'multiply',
  'fr',
  'pnl',
  'events',
  'snapshots',
  'performance',
  'advisor',
  'config',
  'fr-history',
]);

const ALLOWED_POST_PATHS = new Set(['chat']);

// Allowlisted query parameter names per GET endpoint
const ALLOWED_PARAMS: Record<string, Set<string>> = {
  pnl: new Set(['from', 'to']),
  events: new Set(['limit', 'type']),
  snapshots: new Set(['from', 'to', 'limit']),
  fr: new Set(['limit']),
  'fr-history': new Set(['months']),
  advisor: new Set(['limit', 'category']),
};

function checkProxyConfig(): NextResponse | null {
  if (process.env.NODE_ENV === 'production' && !BOT_API_TOKEN) {
    return NextResponse.json(
      { error: 'BOT_API_TOKEN is required in production' },
      { status: 503 },
    );
  }
  return null;
}

function checkAuth(request: NextRequest): NextResponse | null {
  if (!isAuthorizedRequest(request.headers.get('authorization'), FRONTEND_API_SECRET)) {
    return new NextResponse('Authentication required', {
      status: 401,
      headers: getAuthChallengeHeaders(),
    });
  }
  return null;
}

function resolveEndpoint(path: string[], method: 'GET' | 'POST'): string | null {
  const endpoint = path.join('/');
  const allowlist = method === 'GET' ? ALLOWED_GET_PATHS : ALLOWED_POST_PATHS;
  return allowlist.has(endpoint) ? endpoint : null;
}

function filterSearchParams(endpoint: string, params: URLSearchParams): string {
  const allowed = ALLOWED_PARAMS[endpoint];
  if (!allowed) return '';
  const filtered = new URLSearchParams();
  for (const [key, value] of params) {
    if (allowed.has(key)) {
      filtered.set(key, value);
    }
  }
  const qs = filtered.toString();
  return qs;
}

function buildUrl(endpoint: string, searchParams?: string): string {
  return `${BOT_API_URL}/api/${endpoint}${searchParams ? '?' + searchParams : ''}`;
}

function getHeaders(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  if (BOT_API_TOKEN) {
    headers['Authorization'] = `Bearer ${BOT_API_TOKEN}`;
  }
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    headers['x-forwarded-for'] = forwardedFor;
  }
  const userAgent = request.headers.get('user-agent');
  if (userAgent) {
    headers['x-forwarded-user-agent'] = userAgent;
  }
  return headers;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
  const proxyConfigError = checkProxyConfig();
  if (proxyConfigError) return proxyConfigError;

  const { path } = await params;
  const endpoint = resolveEndpoint(path, 'GET');
  if (!endpoint) {
    return NextResponse.json({ error: 'Endpoint not allowed' }, { status: 404 });
  }
  const filteredParams = filterSearchParams(endpoint, request.nextUrl.searchParams);
  const url = buildUrl(endpoint, filteredParams);

  try {
    const res = await fetch(url, {
      headers: getHeaders(request),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  const proxyConfigError = checkProxyConfig();
  if (proxyConfigError) return proxyConfigError;

  const { path } = await params;
  const endpoint = resolveEndpoint(path, 'POST');
  if (!endpoint) {
    return NextResponse.json({ error: 'Endpoint not allowed' }, { status: 404 });
  }
  const url = buildUrl(endpoint);

  try {
    const body = await request.text();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...getHeaders(request),
        'Content-Type': 'application/json',
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // For SSE responses, stream through directly
    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-store',
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

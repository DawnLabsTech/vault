import { NextResponse, type NextRequest } from 'next/server';
import {
  getAuthChallengeHeaders,
  isAuthorizedRequest,
} from '@/lib/server/auth';

const FRONTEND_API_SECRET = process.env.FRONTEND_API_SECRET || '';

export function proxy(request: NextRequest) {
  if (!FRONTEND_API_SECRET) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get('authorization');
  if (isAuthorizedRequest(authHeader, FRONTEND_API_SECRET)) {
    return NextResponse.next();
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: getAuthChallengeHeaders(),
  });
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};

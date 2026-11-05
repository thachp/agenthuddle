import { NextResponse, type NextRequest } from "next/server";

/** Layouts can't see the URL, and sign-in needs it to come back. Set here, so a client's own value never counts. */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-podster-path", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!api/|_next/).*)"] };

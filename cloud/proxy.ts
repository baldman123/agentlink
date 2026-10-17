import { NextResponse, type NextRequest } from "next/server";

// Pages need a session cookie; without one the visitor sees only the sign-in page. This is a cheap gate:
// the API checks the session itself on every request (and the app signs out on a 401), so a stale
// cookie only gets as far as an empty page that redirects. /api/** answers for itself.
export function proxy(req: NextRequest) {
  if (req.cookies.get("al_session")?.value) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // everything except the API, the sign-in page, and Next's own assets
  matcher: ["/((?!api/|login|_next/|favicon).*)"],
};

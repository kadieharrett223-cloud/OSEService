import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const publicPaths = ["/enter-code", "/login", "/eula", "/privacy-policy"];
  const isPublic = publicPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  if (isPublic) {
    return NextResponse.next();
  }

  const hasSessionCookie = Boolean(request.cookies.get("app_access_session")?.value);
  if (!hasSessionCookie) {
    const url = request.nextUrl.clone();
    url.pathname = "/enter-code";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};

import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session.mjs";
import { canAccessPath, isPublicPath } from "@/lib/roles.mjs";

/**
 * The gate in front of everything.
 *
 * Runs at the edge, so it may only use what exists there: lib/session.mjs is
 * built on Web Crypto for exactly this reason, and lib/roles.mjs is pure. No
 * database, no Mongoose.
 *
 * It checks the signature, the expiry and whether the role may reach the path.
 * It cannot check whether the user still exists, is still active, or has been
 * revoked -- that needs a database, and `requireAuth()` in lib/authServer.mjs
 * does it on the route itself. This is the gate; that is the lock.
 */
export async function middleware(req) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    // Fail closed. Without a secret nothing can be verified, and letting
    // requests through unverified is the state this whole thing exists to end.
    const message = "AUTH_SECRET is not configured on the server.";
    return isApi
      ? NextResponse.json({ success: false, message }, { status: 500 })
      : new NextResponse(message, { status: 500 });
  }

  const claims = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret);

  if (isPublicPath(pathname)) {
    // Already signed in and asking for the sign-in page: go to the dashboard.
    if (claims && (pathname === "/login" || pathname === "/signup")) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  if (!claims) {
    if (isApi) {
      return NextResponse.json({ success: false, message: "Please sign in." }, { status: 401 });
    }
    const login = new URL("/login", req.url);
    // Come back to where they were headed once they are in.
    login.searchParams.set("next", pathname + (search || ""));
    return NextResponse.redirect(login);
  }

  if (!canAccessPath(claims.role, pathname)) {
    if (isApi) {
      return NextResponse.json(
        { success: false, message: "You do not have permission to do that." },
        { status: 403 }
      );
    }
    const home = new URL("/", req.url);
    home.searchParams.set("denied", pathname);
    return NextResponse.redirect(home);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's own assets and the favicon. Listed as an
  // exclusion rather than an inclusion on purpose: a new page is protected by
  // default, and only something that is plainly a static asset is not.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?)$).*)"],
};

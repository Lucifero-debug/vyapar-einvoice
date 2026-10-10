import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/session.mjs";

export const dynamic = "force-dynamic";

/**
 * Sign out: clear the cookie.
 *
 * Sessions are stateless, so this does not kill the token -- it only stops the
 * browser sending it. To end every session for a user (someone who has left,
 * a device that was lost), bump their `tokenVersion`, which `requireAuth`
 * checks on every request.
 */
export async function POST() {
  const res = NextResponse.json({ success: true, message: "Signed out." });
  res.cookies.set(
    SESSION_COOKIE,
    "",
    sessionCookieOptions({ secure: process.env.NODE_ENV === "production", maxAge: 0 })
  );
  return res;
}

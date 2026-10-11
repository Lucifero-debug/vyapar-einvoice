import { NextResponse } from "next/server";
import { requireAuth, AuthError } from "@/lib/authServer.mjs";
import { ROLE_PERMISSIONS } from "@/lib/roles.mjs";

export const dynamic = "force-dynamic";

/**
 * Who am I, which firm, and what may I do.
 *
 * The permission list goes to the client so the navigation can hide what the
 * user cannot reach. That is tidiness, not security -- every route checks for
 * itself, because a hidden link is not a locked door.
 */
export async function GET(req) {
  try {
    const auth = await requireAuth(req);
    return NextResponse.json({
      success: true,
      user: {
        name: auth.name,
        email: auth.email,
        role: auth.role,
        // The screen needs this to send somebody to the password page. The
        // LOCK is in requireAuth, which refuses every other route while it is
        // true; this is only what lets the browser go to the right place
        // instead of showing a wall of 403s.
        mustChangePassword: auth.mustChangePassword === true,
      },
      company: { id: auth.companyId, name: auth.company?.name || "" },
      permissions: ROLE_PERMISSIONS[auth.role] || [],
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        {
          success: false,
          message: error.message,
          ...(error.code ? { code: error.code } : {}),
        },
        { status: error.status }
      );
    }
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}

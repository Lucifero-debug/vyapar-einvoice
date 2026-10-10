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
      user: { name: auth.name, email: auth.email, role: auth.role },
      company: { id: auth.companyId, name: auth.company?.name || "" },
      permissions: ROLE_PERMISSIONS[auth.role] || [],
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, message: error.message }, { status: error.status });
    }
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/password.mjs";
import { findStaffForPasswordCheck, updateStaff } from "@/lib/staffStore.mjs";

export const dynamic = "force-dynamic";

/**
 * Change your OWN password.
 *
 * Needs no permission beyond a session -- lib/roles.mjs maps it to null -- and
 * that is deliberate: a biller must be able to replace the password their
 * owner typed and read out, and an unlisted path under /api would otherwise
 * land them on `setup:write`, which is owner-only.
 *
 * It is reachable while `mustChangePassword` is set, because it is one of the
 * four paths on the allowlist in lib/roles.mjs. Everything else is refused
 * until this succeeds.
 *
 * THE CURRENT PASSWORD IS ALWAYS REQUIRED, including on the forced first
 * change. A borrowed laptop with a live session is exactly the case this
 * stops, and on the forced change the current password is the one the owner
 * just read out -- so asking for it costs nothing and proves the person at the
 * keyboard is the one who was told it.
 *
 * It only ever acts on auth.userId. There is no id in the body to get wrong.
 */
async function handlePOST(req, auth) {
  try {
    const body = await req.json().catch(() => ({}));
    const current = String(body.currentPassword || "");
    const next = String(body.newPassword || "");

    if (!current) {
      return NextResponse.json(
        { success: false, error: "Enter your current password." },
        { status: 400 }
      );
    }
    const problem = passwordProblem(next);
    if (problem) {
      return NextResponse.json({ success: false, error: problem }, { status: 400 });
    }
    if (next === current) {
      return NextResponse.json(
        { success: false, error: "The new password has to be different from the old one." },
        { status: 400 }
      );
    }

    await connect();

    const me = await findStaffForPasswordCheck(auth.companyId, auth.userId);
    if (!me) {
      return NextResponse.json({ success: false, error: "Please sign in." }, { status: 401 });
    }

    const ok = await verifyPassword(current, me.passwordHash);
    if (!ok) {
      // Says which one was wrong, because this is an authenticated user
      // changing their own password -- there is no account to enumerate.
      return NextResponse.json(
        { success: false, error: "That is not your current password." },
        { status: 400 }
      );
    }

    const passwordHash = await hashPassword(next);

    // The debt is cleared and every OTHER session is ended in the same write.
    // The bump invalidates this caller's token too, which is why the response
    // tells them to sign in again rather than pretending nothing happened.
    await updateStaff(
      auth.companyId,
      auth.userId,
      { passwordHash, mustChangePassword: false },
      { bumpToken: true }
    );

    return NextResponse.json({
      success: true,
      message: "Password changed. Please sign in again with the new one.",
      signedOut: true,
    });
  } catch (error) {
    console.error("Change password error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = tenantRoute(handlePOST);

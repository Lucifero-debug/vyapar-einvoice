import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { countActiveOwners, findStaffById, updateStaff } from "@/lib/staffStore.mjs";
import { deactivateProblem, needsTokenBump } from "@/lib/staffRules.mjs";

export const dynamic = "force-dynamic";

/**
 * Switch a staff account off, or back on.
 *
 * NOT A DELETE, and deliberately. Every BOM, order and production row carries
 * `createdBy` as a plain STRING -- the name or email as it stood when the
 * record was made, not a reference. So nothing breaks if an account goes away,
 * and that is exactly the problem: delete an account, let somebody else join
 * on the same address a year later, and every old `createdBy` quietly points
 * at the new person. Deactivating keeps the address reserved by the unique
 * index, so the trail stays unambiguous.
 *
 * HOW THIS ACTUALLY LOCKS SOMEBODY OUT. Sessions are stateless (lib/session.mjs),
 * so there is no session row to delete. Two things do it, and both are already
 * in lib/authServer.mjs:
 *
 *   - `requireAuth` refuses any user whose `active` is false, on every
 *     protected route, from the next request onward.
 *   - `tokenVersion` is bumped in the same write, so the token itself is stale
 *     even if the flag were somehow missed.
 *
 * What neither can do is stop a PAGE loading: middleware.js runs at the edge
 * with no database and can only check the signature. The page shell renders,
 * every API call on it fails, and components/UserMenu.jsx turns that 401 into
 * a redirect to /login. That is the part that makes deactivation visible to
 * the person it happened to.
 */
async function handlePATCH(req, auth) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "").trim();
    const active = body.active === true;

    if (!id) {
      return NextResponse.json({ success: false, error: "Which staff member?" }, { status: 400 });
    }
    if (typeof body.active !== "boolean") {
      // Not defaulted. A missing flag here would silently switch somebody off.
      return NextResponse.json(
        { success: false, error: "Say whether the account is to be active." },
        { status: 400 }
      );
    }

    await connect();

    const target = await findStaffById(auth.companyId, id);
    if (!target) {
      return NextResponse.json(
        { success: false, error: "That staff member is not at this firm." },
        { status: 404 }
      );
    }

    // Only switching OFF can lock a firm out of its own books, so only that
    // direction is guarded. Turning somebody back on is always safe.
    if (!active) {
      const activeOwners = await countActiveOwners(auth.companyId);
      const bad = deactivateProblem({ actorId: auth.userId, target, activeOwners });
      if (bad) return NextResponse.json({ success: false, error: bad }, { status: 400 });
    }

    const bumpToken = needsTokenBump({
      before: { role: target.role, active: target.active },
      after: { role: target.role, active },
    });

    const staff = await updateStaff(auth.companyId, id, { active }, { bumpToken });
    if (!staff) {
      return NextResponse.json(
        { success: false, error: "That staff member is not at this firm." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: active
        ? `${staff.name} can sign in again.`
        : `${staff.name} is deactivated and has been signed out. Their records are untouched.`,
      staff,
    });
  } catch (error) {
    console.error("Staff status error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const PATCH = tenantRoute(handlePATCH);

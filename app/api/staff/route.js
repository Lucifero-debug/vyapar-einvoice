import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { countActiveOwners, listStaff } from "@/lib/staffStore.mjs";
import { rowPowers, staffSummary } from "@/lib/staffRules.mjs";

export const dynamic = "force-dynamic";

/**
 * Everyone who can sign in to this firm.
 *
 * Owner-only: /api/staff is mapped to `user:manage` in lib/roles.mjs, which no
 * other role holds.
 *
 * The owner's own row IS included, with its controls locked. Leaving owners
 * out would make a tidier page and a lying one: "3 staff" when four people can
 * sign in is worse than a row that cannot be edited.
 *
 * `powers` comes from the same module the write routes refuse with, so what
 * the screen greys out and what the server rejects cannot drift apart.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    // companyId from the VERIFIED session, never from the query string.
    // requireAuth reads it off the user record and cross-checks it against the
    // token, so there is nothing a request can say to change which firm this
    // is. See lib/staffStore.mjs for why that matters more here than anywhere
    // else in the app.
    const staff = await listStaff(auth.companyId);
    const activeOwners = await countActiveOwners(auth.companyId);

    return NextResponse.json({
      success: true,
      me: { id: auth.userId, role: auth.role },
      staff: staff.map((person) => ({
        ...person,
        powers: rowPowers({ actorId: auth.userId, staff: person, activeOwners }),
      })),
      summary: staffSummary(staff),
      activeOwners,
    });
  } catch (error) {
    console.error("Staff list error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the caller's
// own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

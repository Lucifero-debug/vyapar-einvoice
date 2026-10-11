import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { peekNextProductionNo } from "@/lib/getNextProductionNo";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

export const dynamic = "force-dynamic";

/**
 * What the next production number will probably be.
 *
 * A PEEK, like next-invoice-no and next-order-no: opening the form and walking
 * away must not burn a number and leave a gap in the register. The real number
 * is settled inside production-add's transaction, which is also what makes two
 * people opening the form at once safe.
 */
async function handleGET(req, auth) {
  try {
    await connect();
    return NextResponse.json({ success: true, docNo: await peekNextProductionNo() });
  } catch (err) {
    console.error("Next production no error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

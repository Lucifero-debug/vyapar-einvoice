import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import CustomerGroup from "../../../models/customerGroupModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

export const dynamic = "force-dynamic";

async function handleGET(req, auth) {
  try {
    await connect();
    const group = await CustomerGroup.find({}).sort({ name: 1 }).lean();
    return NextResponse.json({ success: true, group });
  } catch (error) {
    console.error("Error fetching customer groups:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

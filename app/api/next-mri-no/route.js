import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { peekNextMriNo } from "@/lib/mriSave.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * What the next M.R.I. number will probably be -- a PEEK, so ticking "M.R.I."
 * on a form burns nothing. The number is reserved when the bill or challan
 * is saved (lib/mriSave.mjs), and may differ if someone else saved one first.
 */
async function handleGET() {
  try {
    await connect();
    return NextResponse.json({ success: true, mriNo: await peekNextMriNo() });
  } catch (err) {
    console.error("Error fetching next M.R.I. number:", err);
    return NextResponse.json({ success: false, error: "Could not read the next M.R.I. number." }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
export const GET = tenantRoute(handleGET);

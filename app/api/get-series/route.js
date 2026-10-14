import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Series from "../../../models/seriesModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

export const dynamic = "force-dynamic";

/**
 * The series master -- Sigfa's SubKey list.
 *
 * Returns EVERY row, inactive ones included. Filtering is the caller's: a
 * Series dropdown asks lib/series.mjs for the active ones it may offer
 * (`seriesOptions`), while the master screen has to show the inactive ones in
 * order to switch them back on. A route that filtered here would make the
 * second impossible.
 */
async function handleGET(req, auth) {
  try {
    await connect();
    const series = await Series.find({}).sort({ scope: 1, code: 1 }).lean();
    return NextResponse.json({ success: true, series });
  } catch (error) {
    console.error("Error fetching series:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

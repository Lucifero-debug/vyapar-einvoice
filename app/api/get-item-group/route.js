import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import ItemGroup from "@/models/itemGroupModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

export const dynamic = "force-dynamic";

/**
 * Every item group of this firm.
 *
 * Flat, and sorted by name only. The TREE is built by the caller, from
 * `itemGroupOptions` in lib/itemGroups.mjs — one ordering, shared by the
 * master screen and the item form's picker, rather than a sort here that the
 * two would then each have to agree with separately.
 */
async function handleGET(req, auth) {
  try {
    await connect();
    const itemGroup = await ItemGroup.find({}).sort({ name: 1 }).lean();
    return NextResponse.json({ success: true, itemGroup });
  } catch (error) {
    console.error("Error fetching item groups:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

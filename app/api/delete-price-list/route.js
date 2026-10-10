import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import PriceList from "../../../models/priceListModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    await connect();

    const id = new URL(req.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "Id missing in query." }, { status: 400 });
    }

    // Invoices keep the rate they were billed at, so nothing else references
    // a price list and it is always safe to delete.
    const deleted = await PriceList.findByIdAndDelete(id);
    if (!deleted) {
      return NextResponse.json({ success: false, error: "Price list not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: "Price list deleted successfully" });
  } catch (error) {
    console.error("Delete Error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

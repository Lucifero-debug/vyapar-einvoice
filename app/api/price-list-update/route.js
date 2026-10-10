import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import PriceList from "../../../models/priceListModel";
import Customer from "../../../models/custModel";
import { cleanPriceListItems } from "../../../lib/priceList.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    await connect();
    const body = await req.json();
    const id = body.id || body._id;

    if (!id || !body.party || !body.date) {
      return NextResponse.json({ success: false, error: "Price list id, party and date are required" }, { status: 400 });
    }

    const party = await Customer.findById(body.party);
    if (!party) {
      return NextResponse.json({ success: false, error: "Party not found" }, { status: 404 });
    }

    const priceList = await PriceList.findByIdAndUpdate(
      id,
      {
        $set: {
          party: party._id,
          partyName: party.name,
          date: body.date,
          items: cleanPriceListItems(body.items),
          remark: body.remark,
        },
      },
      { new: true, runValidators: true }
    );

    if (!priceList) {
      return NextResponse.json({ success: false, error: "Price list not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, priceList });
  } catch (error) {
    console.error("Error updating price list:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

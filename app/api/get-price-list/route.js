import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import PriceList from "../../../models/priceListModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import "../../../models/custModel";

export const dynamic = "force-dynamic";

async function handleGET(req, auth) {
  try {
    await connect();
    const lists = await PriceList.find({})
      .populate("party", "name")
      .sort({ partyName: 1, date: -1 })
      .lean();

    // Send the party back as an id with its current name, so a renamed
    // customer shows under the new name.
    const priceList = lists.map((pl) => ({
      ...pl,
      party: pl.party?._id ?? pl.party,
      partyName: pl.party?.name ?? pl.partyName,
    }));

    return NextResponse.json({ success: true, priceList });
  } catch (error) {
    console.error("Error fetching price lists:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

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

    if (!body.party || !body.date) {
      return NextResponse.json({ success: false, error: "Party and date are required" }, { status: 400 });
    }

    const party = await Customer.findById(body.party);
    if (!party) {
      return NextResponse.json({ success: false, error: "Party not found" }, { status: 404 });
    }

    // A price list is identified by its party and its date, so two lists for
    // the same party on the same day are a duplicate: `latestPriceListFor`
    // sorts by date and takes the first, which makes the winner arbitrary and
    // the rate a customer is billed depend on insertion order.
    const day = new Date(body.date);
    const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const sameDay = await PriceList.findOne({
      party: party._id,
      date: { $gte: dayStart, $lt: dayEnd },
    }, { _id: 1 }).lean();

    if (sameDay) {
      return NextResponse.json(
        {
          success: false,
          error: `${party.name} already has a price list dated ${dayStart.toISOString().slice(0, 10)}. Edit that one instead of adding a second.`,
        },
        { status: 409 }
      );
    }

    const priceList = await PriceList.create({
      party: party._id,
      partyName: party.name,
      date: body.date,
      items: cleanPriceListItems(body.items),
      remark: body.remark,
    });

    return NextResponse.json({ success: true, priceList }, { status: 201 });
  } catch (error) {
    console.error("Error adding price list:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import ItemLedger from "@/models/itemLedgerModel";
import Item from "@/models/itemModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handleGET(req, auth) {
  try {
    await connect();
    const { searchParams } = new URL(req.url);
    const itemId = searchParams.get("itemId");

    if (!itemId) {
      return NextResponse.json(
        { success: false, error: "Item ID is required" },
        { status: 400 }
      );
    }

    if (itemId === "0") {
      const [items, ledgers] = await Promise.all([
        Item.find().lean(),
        ItemLedger.find().sort({ date: 1 }).lean(),
      ]);

      return NextResponse.json({ success: true, all: true, items, ledgers });
    }

    // A malformed id used to throw a CastError out of findById; a valid id for
    // an item that has since been deleted used to reach `item.name` on null and
    // crash the route. Both now answer plainly.
    if (!mongoose.Types.ObjectId.isValid(itemId)) {
      return NextResponse.json(
        { success: false, error: "Invalid item id." },
        { status: 400 }
      );
    }

    const item = await Item.findById(itemId).lean();
    if (!item) {
      return NextResponse.json(
        { success: false, error: "Item not found." },
        { status: 404 }
      );
    }

    const ledgers = await ItemLedger.find({ itemName: item.name })
      .sort({ date: 1 })
      .lean();

    return NextResponse.json({ success: true, item, ledgers });
  } catch (err) {
    console.error("Item ledger error:", err);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

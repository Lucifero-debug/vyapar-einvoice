import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Item from "@/models/itemModel";
import ItemLedger from "@/models/itemLedgerModel";
import { buildStockIndex } from "@/lib/itemStock.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

// Stock changes on every invoice, so a cached answer is a wrong answer.
export const dynamic = "force-dynamic";

/**
 * Current stock for every item, in one call.
 *
 * The billing pages need this for a dropdown of a few hundred items, so the
 * movements are summed in the database rather than shipped row by row -- the
 * stock ledger is the biggest collection in the app.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const [items, movements] = await Promise.all([
      Item.find({}, { name: 1, openingQuantity: 1, unit: 1 }).lean(),
      ItemLedger.aggregate([
        {
          $group: {
            _id: "$itemName",
            received: { $sum: "$receiptQuantity" },
            issued: { $sum: "$issueQuantity" },
          },
        },
      ]),
    ]);

    return NextResponse.json({
      message: "Stock fetched successfully",
      success: true,
      stock: buildStockIndex({ items, movements }),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

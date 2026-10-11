import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Bom from "@/models/bomModel";
import Item from "@/models/itemModel";
import ItemLedger from "@/models/itemLedgerModel";
import Order from "@/models/orderModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { buildStockIndex, stockOf } from "@/lib/itemStock.mjs";
import { pendingLineRows } from "@/lib/orderReports.mjs";
import { productionPlan } from "@/lib/productionPlan.mjs";

// Orders, stock and formulas all move under it, so a cached plan is a wrong
// plan -- the same reason item-stock says this.
export const dynamic = "force-dynamic";

/**
 * What to make, and what is short to make it.
 *
 * READ ONLY. It writes nothing and creates nothing: the purchase orders and
 * production entries it implies are raised on the screens that already exist.
 * A plan is a derived figure, and a derived figure that writes documents is a
 * wrong formula away from a real order.
 *
 *   party   narrow to one customer's orders
 *   nested  explode sub-formulas; on by default
 *
 * The arithmetic is all in lib/productionPlan.mjs, including the part that is
 * easy to get wrong twice over -- see the note there about allocating stock
 * once.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const { searchParams } = new URL(req.url);
    const party = (searchParams.get("party") || "").trim();
    const nested = searchParams.get("nested") !== "0";

    const open = { status: { $in: ["open", "partial"] } };
    const saleQuery = { ...open, type: "Sale" };
    if (party) saleQuery["customer.name"] = party;

    const [saleOrders, purchaseOrders, boms, items, movements] = await Promise.all([
      Order.find(saleQuery).lean(),
      // Not narrowed by party, deliberately: material already on order is
      // incoming supply whoever it was bought from, and filtering it by the
      // customer being planned for would double-count every shortfall.
      Order.find({ ...open, type: "Purchase" }).lean(),
      Bom.find({ hold: { $ne: true } }, { name: 1, outputItem: 1, forQuantity: 1, lines: 1 }).lean(),
      Item.find({}, { name: 1, openingQuantity: 1, unit: 1, cost: 1 }).lean(),
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

    const now = Date.now();
    const stock = buildStockIndex({ items, movements });
    const costMap = new Map(
      items.map((i) => [String(i.name || "").trim().toLowerCase(), Number(i.cost) || 0])
    );

    const plan = productionPlan({
      // The same flattening the pending reports use, so the plan and the
      // item-wise pending list cannot disagree about what is owed.
      saleRows: pendingLineRows(saleOrders, now),
      purchaseRows: pendingLineRows(purchaseOrders, now),
      boms,
      stockOf: (name) => {
        const entry = stockOf(stock, name);
        // null, not 0: an item with no master record is a different fact from
        // one with nothing on the shelf, and the plan says so.
        return entry ? entry.quantity : null;
      },
      costOf: (name) => costMap.get(String(name || "").trim().toLowerCase()) || 0,
      nested,
    });

    return NextResponse.json({
      success: true,
      party: party || null,
      nested,
      saleOrders: saleOrders.length,
      purchaseOrders: purchaseOrders.length,
      formulas: boms.length,
      ...plan,
    });
  } catch (err) {
    console.error("Production plan error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Item from "@/models/itemModel";
import ItemLedger from "@/models/itemLedgerModel";
import Order from "@/models/orderModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { isOrderType } from "@/lib/orderStatus.mjs";
import { buildStockIndex, stockOf } from "@/lib/itemStock.mjs";
import {
  itemPendingFrom,
  partyPendingFrom,
  pendingLineRows,
  pendingSummary,
  registerRows,
  withStock,
} from "@/lib/orderReports.mjs";

/**
 * The three order reports that read only the order book.
 *
 *   /api/order-report?view=register&type=Sale&from=2026-04-01&to=2026-10-10
 *   /api/order-report?view=party-pending&type=Sale
 *   /api/order-report?view=item-pending&type=Purchase&party=Acme%20Traders
 *
 * One route for all three because they are one query grouped three ways --
 * and because splitting them is how the register and the pending views end
 * up disagreeing about the same book. Every figure comes from
 * lib/orderReports.mjs; nothing is computed here.
 *
 * The reconciliation is a separate route: it has to read the invoice
 * collection as well, which is a different query shape and much heavier.
 *
 * `detail` is the flat line list behind the two grouped views, which is what
 * the CSV download for them uses -- an accountant wants the 588 lines, not
 * the 130 group totals.
 */
async function handleGET(req, auth) {
  try {
    await connect();
    const url = new URL(req.url);

    const view = String(url.searchParams.get("view") || "register").trim();
    const type = String(url.searchParams.get("type") || "").trim();
    const party = String(url.searchParams.get("party") || "").trim();
    const item = String(url.searchParams.get("item") || "").trim();
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    const query = {};
    if (isOrderType(type)) query.type = type;
    if (party) query["customer.name"] = party;

    // The pending views ask the database for the orders that could still owe
    // something, so a book with years of closed orders does not have to be
    // loaded in full to find this week's open ones. The rule in
    // lib/orderReports.mjs then re-filters each line, so a stored status that
    // has drifted cannot put a closed order on a pending report.
    if (view === "party-pending" || view === "item-pending" || view === "detail") {
      query.status = { $in: ["open", "partial"] };
    }

    if (from || to) {
      query.date = {};
      if (from) query.date.$gte = new Date(from);
      // Inclusive of the end day: a date picker sends midnight, so a plain
      // $lte would drop everything dated that day.
      if (to) query.date.$lte = new Date(new Date(to).setHours(23, 59, 59, 999));
    }

    const orders = await Order.find(query).sort({ date: -1, orderNo: -1 }).lean();

    const now = Date.now();

    // The item filter is applied to the LINES, before grouping -- never to
    // the groups. An order matches in Mongo if ANY of its lines is that item,
    // so narrowing afterwards by dropping groups would leave each surviving
    // group still totalling all its other items.
    const rows = pendingLineRows(orders, now);
    const filtered = item ? rows.filter((r) => r.item === item) : rows;

    let payload;

    switch (view) {
      case "party-pending":
        payload = { rows: partyPendingFrom(filtered) };
        break;
      case "item-pending": {
        // The stock beside the pending quantity, which is the other half of
        // the question this view is asked: "we owe 400, have we got them?"
        //
        // Summed from the stock ledger in the database rather than shipped
        // row by row -- that collection is the biggest in the app -- and
        // through buildStockIndex, so the figure is the one the stock report
        // shows rather than a second count that can disagree with it.
        //
        // Fetched only for THIS view: the register and the party-wise list
        // have no use for it, and loading the item master for them would be
        // paid on every report and used on one.
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
        const index = buildStockIndex({ items, movements });
        payload = {
          rows: withStock(itemPendingFrom(filtered), (name) => {
            const entry = stockOf(index, name);
            // null, not 0: "not in the item master" and "none left" are
            // different facts, and the first is usually a name mismatch
            // between the order and the master.
            return entry ? entry.quantity : null;
          }),
        };
        break;
      }
      case "detail":
        payload = { rows: filtered };
        break;
      case "register":
        payload = { rows: registerRows(orders, now) };
        break;
      default:
        return NextResponse.json(
          { success: false, error: `Unknown report view: ${view}` },
          { status: 400 }
        );
    }

    return NextResponse.json({
      success: true,
      view,
      type: isOrderType(type) ? type : "",
      // The strip above the grouped views. Built from the same FILTERED
      // lines the rows are, so the heading total cannot disagree with the
      // column beneath it -- which it would if it were computed from the
      // unfiltered orders.
      summary: pendingSummary(orders, now, filtered),
      orderCount: orders.length,
      ...payload,
    });
  } catch (err) {
    console.error("Error building order report:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

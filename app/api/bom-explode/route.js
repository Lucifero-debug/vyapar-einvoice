import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Bom from "@/models/bomModel";
import Item from "@/models/itemModel";
import ItemLedger from "@/models/itemLedgerModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { buildStockIndex, stockOf as stockEntry } from "@/lib/itemStock.mjs";
import { bomCost, byOutputItem, explode, mergeLines, shortfalls } from "@/lib/bom.mjs";

// The answer depends on current stock and current costs, so a cached one is a
// wrong one -- the same reason item-stock says this.
export const dynamic = "force-dynamic";

/**
 * Explode a formula for a given quantity: what it would consume, what it would
 * produce, what it would cost, and what is short.
 *
 * This is what the production form calls when a formula and a quantity have
 * been chosen. It writes nothing. Keeping it separate from `production-add`
 * means the figures on screen come from the same code that will do the saving,
 * rather than from a second implementation in the browser that drifts.
 *
 *   bomName | id     which formula
 *   quantity         how much of the output is being made
 *   nested           Sigfa's "With Sub Formula"; default on
 *
 * `shortfalls` is advice, not a veto -- see the note on it in lib/bom.mjs. A
 * shop that books the production before entering the purchase bill for its raw
 * material is doing something ordinary, and refusing would mean refusing to
 * record something that physically happened.
 */
async function handlePOST(req, auth) {
  try {
    await connect();

    const body = await req.json();
    const id = body.id;
    const name = String(body.bomName || body.name || "").trim();
    const outputQuantity = Number(body.quantity);
    const nested = body.nested === undefined ? true : Boolean(body.nested);

    if (!id && !name) {
      return NextResponse.json(
        { success: false, error: "Say which formula to use." },
        { status: 400 }
      );
    }
    if (!Number.isFinite(outputQuantity) || outputQuantity <= 0) {
      return NextResponse.json(
        { success: false, error: "Enter how much is being produced." },
        { status: 400 }
      );
    }

    if (id && !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ success: false, error: "Invalid formula id." }, { status: 400 });
    }

    // Everything in one go: the formula, the whole formula book for nesting,
    // the item master for costs and units, and the stock ledger summed in the
    // database. Four round trips to the database, not four per line.
    const [bom, allBoms, items, movements] = await Promise.all([
      id
        ? Bom.findById(id).lean()
        : Bom.findOne({ name }).collation({ locale: "en", strength: 2 }).lean(),
      nested
        ? Bom.find({}, { name: 1, outputItem: 1, forQuantity: 1, lines: 1 }).lean()
        : Promise.resolve([]),
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

    if (!bom) {
      return NextResponse.json({ success: false, error: "Formula not found." }, { status: 404 });
    }

    const costMap = new Map(
      items.map((i) => [String(i.name || "").trim().toLowerCase(), Number(i.cost) || 0])
    );
    const costOf = (itemName) => costMap.get(String(itemName || "").trim().toLowerCase()) || 0;

    const result = explode({
      bom,
      outputQuantity,
      index: byOutputItem(allBoms),
      nested,
    });

    // Merged, because nesting produces the same screw twice when two
    // sub-assemblies both use it, and issuing one item twice in a single
    // voucher reads as a mistake even when the total is right. Sigfa's
    // "Raw Material Merged In Formula Successfully."
    const lines = mergeLines(result.lines);

    const costing = bomCost({ lines, outputQuantity, costOf });

    const stock = buildStockIndex({ items, movements });
    const short = shortfalls({
      issues: lines.filter((l) => l.kind !== "byproduct"),
      stockOf: (itemName) => Number(stockEntry(stock, itemName)?.quantity) || 0,
    });

    return NextResponse.json({
      success: true,
      bom: {
        _id: bom._id,
        name: bom.name,
        outputItem: bom.outputItem,
        outputUnit: bom.outputUnit || "",
        forQuantity: bom.forQuantity,
        hold: Boolean(bom.hold),
      },
      outputQuantity,
      nested,
      lines,
      costing,
      shortfalls: short,
      warnings: result.warnings,
      truncated: result.truncated,
    });
  } catch (err) {
    console.error("BOM explode error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

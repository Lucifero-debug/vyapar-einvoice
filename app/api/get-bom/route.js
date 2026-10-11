import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Bom from "@/models/bomModel";
import Item from "@/models/itemModel";
import Production from "@/models/productionModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { bomCost, bomLines, explode, byOutputItem, mergeLines } from "@/lib/bom.mjs";

/**
 * One formula, with its costing worked out at today's prices.
 *
 * Looked up by `id`, or by `name` -- the name is the key a user types and the
 * only thing a production entry stores, so both have to work.
 *
 * The costing is computed here rather than stored, which is the whole point of
 * not keeping Sigfa's FRATE on the line: a formula opened today is costed
 * today. `missingCosts` names the components with no price in the master, so
 * the page can say "costed on 4 of 7 lines" instead of presenting a confident
 * number that quietly omitted the rest.
 *
 * `?expand=1` also returns the formula exploded to its raw materials, so the
 * form can show what a nested formula really consumes without a second round
 * trip.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const name = (searchParams.get("name") || "").trim();
    const expand = searchParams.get("expand") === "1";

    if (!id && !name) {
      return NextResponse.json(
        { success: false, error: "Give an id or a name." },
        { status: 400 }
      );
    }

    let bom = null;
    if (id) {
      // A malformed id used to throw a CastError out of findById on the other
      // master routes; answered plainly here instead.
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return NextResponse.json({ success: false, error: "Invalid formula id." }, { status: 400 });
      }
      bom = await Bom.findById(id).lean();
    } else {
      // Case-insensitively, like every other name lookup here: "bracket" and
      // "Bracket" are one formula (lib/uniqueName.mjs).
      bom = await Bom.findOne({ name })
        .collation({ locale: "en", strength: 2 })
        .lean();
    }

    if (!bom) {
      return NextResponse.json({ success: false, error: "Formula not found." }, { status: 404 });
    }

    // Costs for the lines, and for anything the explosion reaches below them.
    // One query for the whole master is cheaper than a per-line lookup and
    // keeps the nested case to a single round trip.
    const items = await Item.find({}, { name: 1, cost: 1, unit: 1, uqc: 1 }).lean();
    const costMap = new Map(items.map((i) => [String(i.name || "").trim().toLowerCase(), i]));
    const costOf = (itemName) =>
      Number(costMap.get(String(itemName || "").trim().toLowerCase())?.cost) || 0;

    // At its own batch size, which is the figure a user is looking at when
    // they open the screen.
    const direct = bomLines(bom).map((line) => ({
      itemName: line.itemName,
      kind: line.kind,
      quantity: line.quantity,
      unit: line.unit || "",
    }));

    const costing = bomCost({
      lines: direct,
      outputQuantity: bom.forQuantity,
      costOf,
    });

    let exploded = null;
    if (expand) {
      const all = await Bom.find({}, { name: 1, outputItem: 1, forQuantity: 1, lines: 1 }).lean();
      const result = explode({
        bom,
        outputQuantity: bom.forQuantity,
        index: byOutputItem(all),
      });
      const merged = mergeLines(result.lines);
      exploded = {
        lines: merged,
        warnings: result.warnings,
        truncated: result.truncated,
        costing: bomCost({ lines: merged, outputQuantity: bom.forQuantity, costOf }),
      };
    }

    const producedCount = await Production.countDocuments({ bomName: bom.name });

    return NextResponse.json({ success: true, bom, costing, exploded, producedCount });
  } catch (err) {
    console.error("Get BOM error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

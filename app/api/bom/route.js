import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Bom from "@/models/bomModel";
import Production from "@/models/productionModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { bomLines, linesOfKind } from "@/lib/bom.mjs";

/**
 * The formula list -- Sigfa's BOMList.
 *
 * Returns a row per formula with the counts a list needs, rather than every
 * line of every formula: a shop with two hundred formulas of a dozen lines
 * each would otherwise ship a few hundred kilobytes to draw a table of names.
 * The full document comes from get-bom when one is opened.
 *
 * `producedCount` is how many production entries came from each formula. It is
 * what the delete confirmation is built from, so the page can say what is
 * being given up before anything is removed -- one aggregation for the whole
 * list rather than a query per row.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const { searchParams } = new URL(req.url);
    const wantCounts = searchParams.get("counts") !== "0";

    const boms = await Bom.find(
      {},
      { name: 1, outputItem: 1, outputUnit: 1, forQuantity: 1, lines: 1, hold: 1, remarks: 1, updatedAt: 1 }
    )
      .sort({ name: 1 })
      .lean();

    let produced = new Map();
    if (wantCounts && boms.length) {
      // Grouped by name, because that is what a production entry stores -- it
      // keeps no reference to the formula document (see productionModel).
      const rows = await Production.aggregate([
        { $match: { bomName: { $in: boms.map((b) => b.name) } } },
        { $group: { _id: "$bomName", count: { $sum: 1 } } },
      ]);
      produced = new Map(rows.map((r) => [r._id, r.count]));
    }

    const list = boms.map((bom) => ({
      _id: bom._id,
      name: bom.name,
      outputItem: bom.outputItem,
      outputUnit: bom.outputUnit || "",
      forQuantity: bom.forQuantity,
      hold: Boolean(bom.hold),
      remarks: bom.remarks || "",
      updatedAt: bom.updatedAt,
      lineCount: bomLines(bom).length,
      materialCount: linesOfKind(bom, "material").length,
      wastageCount: linesOfKind(bom, "wastage").length,
      byproductCount: linesOfKind(bom, "byproduct").length,
      producedCount: produced.get(bom.name) || 0,
    }));

    return NextResponse.json({ success: true, boms: list });
  } catch (err) {
    console.error("BOM list error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);

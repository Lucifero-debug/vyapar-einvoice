import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Bom from "@/models/bomModel";
import Production from "@/models/productionModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { bomDeleteNotice } from "@/lib/bom.mjs";

/**
 * Delete a formula.
 *
 * Unlike deleting an item or an invoice, this is never REFUSED: production
 * entries snapshot their own lines (models/productionModel.js), so removing
 * the formula they came from breaks nothing and rewrites nothing.
 *
 * What it does instead is warn once. A formula used fifty times is a thing
 * somebody relies on, and the entries will keep naming a `bomName` that no
 * longer resolves -- which is fine, and still worth saying out loud before it
 * happens rather than after. `?confirm=1` is the answer to that warning.
 *
 * The sub-formula case is deliberately NOT a refusal either. Deleting a
 * formula that other formulas expand through does change what they consume:
 * the component becomes a raw item instead of being broken down. That is a
 * real consequence, so it is named in the notice -- but refusing would leave
 * no way to replace a sub-assembly with a purchased part, which is an ordinary
 * thing for a shop to do.
 */
async function handlePOST(req, auth) {
  try {
    await connect();

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const confirmed = searchParams.get("confirm") === "1";

    if (!id) {
      return NextResponse.json({ success: false, error: "Id missing in query." }, { status: 400 });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ success: false, error: "Invalid formula id." }, { status: 400 });
    }

    const bom = await Bom.findById(id).lean();
    if (!bom) {
      return NextResponse.json({ success: false, error: "Formula not found." }, { status: 404 });
    }

    const [producedCount, usedBy] = await Promise.all([
      Production.countDocuments({ bomName: bom.name }),
      // Formulas that list this formula's OUTPUT as a component -- the ones
      // whose explosion will change shape once this is gone.
      Bom.find({ "lines.itemName": bom.outputItem, _id: { $ne: bom._id } }, { name: 1 })
        .collation({ locale: "en", strength: 2 })
        .lean(),
    ]);

    const notices = [];
    const produced = bomDeleteNotice(bom, producedCount);
    if (produced) notices.push(produced);
    if (usedBy.length) {
      notices.push(
        `${usedBy.map((b) => `"${b.name}"`).join(", ")} ${
          usedBy.length === 1 ? "expands" : "expand"
        } through "${bom.outputItem}". Once this formula is gone they will consume it as a raw item instead of breaking it down.`
      );
    }

    if (notices.length && !confirmed) {
      return NextResponse.json({
        success: false,
        needsConfirm: true,
        notices,
        message: notices.join(" "),
      });
    }

    await Bom.findByIdAndDelete(id);

    return NextResponse.json({
      success: true,
      message: `Formula "${bom.name}" deleted`,
      deletedBom: bom,
    });
  } catch (err) {
    console.error("Delete BOM error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

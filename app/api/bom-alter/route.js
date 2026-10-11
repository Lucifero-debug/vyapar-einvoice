import mongoose from "mongoose";
import { NextResponse } from "next/server";
import Bom from "@/models/bomModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { bomProblems } from "@/lib/bom.mjs";
import { loadItemIndex, loopFromSaving, stampBomLines } from "@/lib/bomSave.mjs";

/**
 * Change an existing formula.
 *
 * NOTHING BLOCKS AN EDIT, however many production entries came from this
 * formula, and that is deliberate. A production entry stores its own exploded
 * lines (see models/productionModel.js), so correcting a recipe cannot rewrite
 * what was consumed last March. Compare `editBlockedReason` on an order, where
 * an edit CAN contradict history and so is refused -- the difference is the
 * snapshot, not a difference in how careful the two screens are.
 *
 * Every check in `bom-add` applies here too, and they are the same code
 * (lib/bomSave.mjs) rather than a second copy: `customer-add` and
 * `customer-alter` once held different duplicate-name rules, so a name blocked
 * on create could be reached by renaming.
 *
 * `excludeId` on the clash check is the part that matters -- without it,
 * re-saving a formula without touching its name collides with itself.
 */
async function handlePOST(req, auth) {
  try {
    const body = await req.json();
    const id = body.id || new URL(req.url).searchParams.get("id");

    if (!id) {
      return NextResponse.json({ success: false, error: "Id missing." }, { status: 400 });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ success: false, error: "Invalid formula id." }, { status: 400 });
    }

    const saved = await withTransaction(async (session) => {
      const existing = await Bom.findById(id, null, { session });
      if (!existing) {
        throw new AbortTransaction({ success: false, error: "Formula not found." }, 404);
      }

      const itemIndex = await loadItemIndex(session);

      const { lines, unknown } = stampBomLines(body.lines || [], itemIndex);
      if (unknown.length) {
        throw new AbortTransaction(
          {
            success: false,
            error: `Not in the item master: ${unknown.join(", ")}. Add them first.`,
            unknown,
          },
          400
        );
      }

      const outputItem = normalizeName(body.outputItem ?? existing.outputItem);
      const outputMaster = itemIndex.get(outputItem.toLowerCase());
      if (outputItem && !outputMaster) {
        throw new AbortTransaction(
          { success: false, error: `"${outputItem}" is not in the item master.` },
          400
        );
      }

      const candidate = {
        _id: existing._id,
        name: normalizeName(body.name ?? existing.name),
        outputItem,
        outputUnit: String(outputMaster?.unit || "").trim(),
        forQuantity: Number(body.forQuantity ?? existing.forQuantity),
        remarks: String(body.remarks ?? existing.remarks ?? "").trim(),
        hold: body.hold === undefined ? Boolean(existing.hold) : Boolean(body.hold),
        lines,
      };

      const problems = bomProblems(candidate);
      if (problems.length) {
        throw new AbortTransaction({ success: false, error: problems[0], problems }, 400);
      }

      // Its own record left out of its own comparison, or re-saving an
      // unchanged name is a clash with itself.
      const clash = await findNameClash(Bom, "name", candidate.name, {
        excludeId: existing._id,
        session,
      });
      if (clash) {
        throw new AbortTransaction(
          { success: false, error: `A formula named "${candidate.name}" already exists.` },
          409
        );
      }

      const loop = await loopFromSaving(candidate, { excludeId: existing._id, session });
      if (loop) {
        throw new AbortTransaction({ success: false, error: loop }, 400);
      }

      existing.name = candidate.name;
      existing.outputItem = candidate.outputItem;
      existing.outputUnit = candidate.outputUnit;
      existing.forQuantity = candidate.forQuantity;
      existing.remarks = candidate.remarks;
      existing.hold = candidate.hold;
      existing.lines = candidate.lines;
      // Sigfa's LUSERE / EDCNT.
      existing.updatedBy = auth?.name || auth?.email || "";
      existing.editCount = Number(existing.editCount || 0) + 1;

      await existing.save({ session });
      return existing;
    });

    return NextResponse.json({
      success: true,
      bom: saved,
      message: `Formula "${saved.name}" updated`,
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("BOM alter error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

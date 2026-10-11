import mongoose from "mongoose";
import { NextResponse } from "next/server";
import Production from "@/models/productionModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { writeProductionLedgerRows } from "@/lib/itemLedger.mjs";
import { buildProductionEntry } from "@/lib/productionSave.mjs";

/**
 * Change a production entry, and the stock it moved.
 *
 * Both, in one transaction -- the same rule `production-add` and
 * `delete-production` follow. An entry whose figures changed without its stock
 * rows changing is materials issued for quantities nobody produced, and that
 * is the shape of bug that only surfaces at stocktake, months later, with no
 * way left to work out which entry caused it.
 *
 *
 * THE DOCUMENT NUMBER DOES NOT CHANGE, AND THAT IS THE WHOLE DESIGN
 * ----------------------------------------------------------------
 * The stock rows are keyed "PRD-<docNo>", and `writeProductionLedgerRows`
 * opens by deleting every row under that key before writing the new ones. So
 * rewriting an entry under its OWN number replaces its stock movements
 * exactly, with no reversal step to get wrong -- which is why this route is
 * so much shorter than `sale-alter`, where the invoice number IS editable and
 * every balance has to be unwound by hand.
 *
 * Let the number change and that guarantee evaporates: the new rows land under
 * a new key while the old ones sit under the old one forever, counted by the
 * stock report and attached to a voucher that no longer exists. The number is
 * never typed anyway -- `production-add` allocates it from the counter and the
 * form has no field for it -- so there is nothing to take away from anybody.
 *
 * A `docNo` in the request is therefore IGNORED rather than refused: a form
 * that echoes back the whole entry it loaded should not be made to strip a
 * field, and silently keeping the real one is safe where honouring it is not.
 *
 *
 * WHAT A RE-SAVE RE-DERIVES, AND WHAT IT KEEPS
 * --------------------------------------------
 * Rates are read from the item master again, so a cost correction on an item
 * reaches an entry that is edited afterwards. Quantities are the form's, which
 * means the entry's own stored lines when the form sends back what it loaded
 * -- so a formula edited since the batch was made does not retroactively
 * rewrite what that batch consumed. The production screen's note has the
 * reasoning: a batch that actually used a bit more of something should be
 * recorded as it happened, not as the recipe says.
 */
async function handlePATCH(req, auth) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || new URL(req.url).searchParams.get("id") || "").trim();

    if (!id) {
      return NextResponse.json(
        { success: false, error: "Which production entry?" },
        { status: 400 }
      );
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ success: false, error: "Invalid id." }, { status: 400 });
    }

    const saved = await withTransaction(async (session) => {
      const existing = await Production.findById(id, null, { session }).lean();
      if (!existing) {
        throw new AbortTransaction(
          { success: false, error: "Production entry not found." },
          404
        );
      }

      // The same pipeline `production-add` runs: the item master, the lines,
      // the unknown-item check, the validation and the rate freezing. Shared
      // so an alter cannot value a batch differently from the way the
      // original save valued it.
      const { fields, frozen } = await buildProductionEntry({ body, session, auth });

      const updated = await Production.findOneAndUpdate(
        { _id: existing._id },
        {
          $set: {
            ...fields,
            // The number stays the entry's own, whatever the request said.
            docNo: existing.docNo,
            // Who made the entry is not who edited it. The schema already
            // carries both of Sigfa's columns -- LUSER as `createdBy` and
            // LUSERE as `updatedBy` -- so there is nothing to invent here, and
            // overwriting `createdBy` would lose the trail of who raised the
            // voucher in the first place. `updatedAt` comes from the schema's
            // own timestamps.
            createdBy: existing.createdBy,
            updatedBy: auth?.name || auth?.email || "",
          },
          // Sigfa counts edits on a voucher, and the schema already carried
          // the column before there was a route to increment it.
          $inc: { editCount: 1 },
        },
        { new: true, runValidators: true, session }
      ).lean();

      if (!updated) {
        throw new AbortTransaction(
          { success: false, error: "Production entry not found." },
          404
        );
      }

      // In the SAME transaction, under the SAME key, so the old movements are
      // deleted and the new ones written as one step.
      const rows = await writeProductionLedgerRows({
        session,
        docNo: updated.docNo,
        date: fields.date,
        outputItem: updated.outputItem,
        outputQuantity: updated.outputQuantity,
        lines: frozen,
        partyName: updated.partyName,
      });

      return { entry: updated, rows };
    });

    return NextResponse.json({
      success: true,
      production: saved.entry,
      stockRows: saved.rows,
      message: `Production ${saved.entry.docNo} updated`,
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("Production alter error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const PATCH = tenantRoute(handlePATCH);

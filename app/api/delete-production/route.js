import mongoose from "mongoose";
import { NextResponse } from "next/server";
import Production from "@/models/productionModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { deleteProductionLedgerRows } from "@/lib/itemLedger.mjs";
import { kindOf } from "@/lib/stockVoucher.mjs";

/**
 * Delete a production entry, and the stock it moved.
 *
 * Both, in one transaction. Deleting the voucher alone would leave its stock
 * rows behind forever: materials issued for a job that no longer exists and a
 * finished item received from nothing. That is the shape of bug that only
 * surfaces at stocktake, months later, with no way left to work out which
 * entry caused it.
 *
 * The rows are removed by the prefixed key -- "PRD-<docNo>" -- which is the
 * second half of why productionLedgerKey exists. A delete keyed on the bare
 * number would take invoice 5's stock movements with it.
 */
async function handlePOST(req, auth) {
  try {
    const id = new URL(req.url).searchParams.get("id");

    if (!id) {
      return NextResponse.json({ success: false, error: "Id missing in query." }, { status: 400 });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ success: false, error: "Invalid id." }, { status: 400 });
    }

    const result = await withTransaction(async (session) => {
      const entry = await Production.findById(id, null, { session }).lean();
      if (!entry) {
        throw new AbortTransaction(
          { success: false, error: "Production entry not found." },
          404
        );
      }

      // The kind decides the ledger key, so a goods issue's rows are
      // removed from under "GI-" and not looked for under "PRD-".
      const removed = await deleteProductionLedgerRows({
        session,
        kind: kindOf(entry),
        docNo: entry.docNo,
      });
      await Production.deleteOne({ _id: entry._id }, { session });

      return { entry, removed };
    });

    return NextResponse.json({
      success: true,
      message: `Production ${result.entry.docNo} deleted`,
      stockRowsRemoved: result.removed,
      deletedProduction: result.entry,
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("Delete production error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

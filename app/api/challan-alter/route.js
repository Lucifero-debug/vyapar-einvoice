import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Challan from "@/models/challanModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { ChallanInputError, prepareChallanInput } from "@/lib/challanInput.mjs";
import { challanFields } from "@/lib/challanSave.mjs";
import { writeChallanLedgerRows } from "@/lib/itemLedger.mjs";
import { carryBilled, challanKind, editBlockedReason } from "@/lib/challanStatus.mjs";

/**
 * Alter a challan.
 *
 * A line an invoice has drawn on keeps its id, its item and at least the
 * billed quantity (SIGFA: "Quantity Is Less Than Quantity Entered Against
 * This Challan."); the party and the stock effect are fixed once anything is
 * billed. The billed figures are carried from the stored challan, never from
 * the request. The stock rows are rewritten in the same transaction.
 */
async function handlePOST(req, auth) {
  try {
    const body = await req.json().catch(() => null);
    let input;
    try {
      input = prepareChallanInput(body);
    } catch (err) {
      if (err instanceof ChallanInputError) {
        return NextResponse.json({ success: false, error: err.message }, { status: 400 });
      }
      throw err;
    }
    if (!input.challanNo) {
      return NextResponse.json({ success: false, error: "Which challan? No number was given." }, { status: 400 });
    }

    await connect();

    const challan = await withTransaction(async (session) => {
      const previous = await Challan.findOne({ challanNo: input.challanNo, type: input.type }).session(session).lean();
      if (!previous) {
        throw new AbortTransaction({ success: false, error: "Challan not found." }, 404);
      }

      // A request that does not say keeps the stored stock effect, rather
      // than the new-challan default -- an alteration must not quietly start
      // (or stop) moving stock.
      if (body.stockEffect === undefined) input.stockEffect = Boolean(previous.stockEffect);

      const items = carryBilled(previous.items, input.items);
      const blocked = editBlockedReason(previous, { ...input, items });
      if (blocked) throw new AbortTransaction({ success: false, error: blocked }, 409);

      const fields = await challanFields({ session, input, items, previous });

      const updated = await Challan.findOneAndUpdate(
        { challanNo: input.challanNo, type: input.type },
        {
          $set: { ...fields, updatedBy: auth?.name || auth?.email || "" },
          $inc: { editCount: 1 },
        },
        { new: true, session }
      ).lean();

      await writeChallanLedgerRows({ session, challan: updated });
      return updated;
    });

    return NextResponse.json({
      success: true,
      challan,
      message: `${challanKind(challan.type).label} ${challan.challanNo} updated.`,
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("Error altering challan:", err);
    return NextResponse.json({ success: false, error: "The challan could not be saved." }, { status: 500 });
  }
}

export const POST = tenantRoute(handlePOST);

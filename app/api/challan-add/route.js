import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Challan from "@/models/challanModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { getNextChallanNo, raiseChallanCounter } from "@/lib/getNextChallanNo";
import { ChallanInputError, prepareChallanInput } from "@/lib/challanInput.mjs";
import { challanFields } from "@/lib/challanSave.mjs";
import { writeChallanLedgerRows } from "@/lib/itemLedger.mjs";
import { challanKind } from "@/lib/challanStatus.mjs";

/** A challan that is not an MRI stores no MRI fields at all. */
const dropEmptyMri = ({ mriNo, mriRemark, againstMriNo, ...rest }) =>
  mriNo ? { ...rest, mriNo, mriRemark, againstMriNo } : rest;

/**
 * Make a sales or purchase challan.
 *
 * In ONE transaction: the number, the challan and -- when it has stock
 * effect -- its stock rows. Nothing is posted to the accounts. `billedQty`,
 * the status and the totals are never taken from the request
 * (lib/challanInput.mjs refuses them).
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

    await connect();

    const challan = await withTransaction(async (session) => {
      // The number the form showed is a peek; honour it if still free.
      let challanNo;
      if (input.challanNo) {
        const taken = await Challan.findOne({ challanNo: input.challanNo, type: input.type }, { _id: 1 }, { session }).lean();
        if (taken) {
          challanNo = await getNextChallanNo(input.type, session);
        } else {
          challanNo = input.challanNo;
          await raiseChallanCounter(input.type, challanNo, session);
        }
      } else {
        challanNo = await getNextChallanNo(input.type, session);
      }

      // A new challan has nothing billed, whatever was sent.
      const items = input.items.map(({ _id, ...line }) => ({ ...line, billedQty: 0 }));
      const fields = await challanFields({ session, input, items });

      const [created] = await Challan.create(
        [{ ...dropEmptyMri(fields), challanNo, createdBy: auth?.name || auth?.email || "", editCount: 0 }],
        { session }
      );

      await writeChallanLedgerRows({ session, challan: created.toObject() });
      return created;
    });

    return NextResponse.json({
      success: true,
      challan,
      message: `${challanKind(challan.type).label} ${challan.challanNo} saved.`,
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("Error saving challan:", err);
    return NextResponse.json({ success: false, error: "The challan could not be saved." }, { status: 500 });
  }
}

export const POST = tenantRoute(handlePOST);

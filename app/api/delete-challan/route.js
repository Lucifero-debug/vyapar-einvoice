import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Challan from "@/models/challanModel";
import Invoice from "@/models/invoiceModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { assertMriDeletable } from "@/lib/mriSave.mjs";
import { deleteChallanLedgerRows } from "@/lib/itemLedger.mjs";
import { challanKind, deleteBlockedReason, isChallanType } from "@/lib/challanStatus.mjs";

/**
 * Delete a challan, and the stock rows it wrote.
 *
 *   POST /api/delete-challan?type=Sale&challanNo=7
 *
 * Refused once any invoice has drawn on it (SIGFA: "Can't Delete, Used In
 * ..."): the invoice lines point at it, and deleting it would leave them
 * pointing at nothing.
 */
async function handlePOST(req) {
  try {
    const url = new URL(req.url);
    const challanNo = Number(url.searchParams.get("challanNo"));
    const type = String(url.searchParams.get("type") || "").trim();
    if (!Number.isInteger(challanNo) || challanNo <= 0 || !isChallanType(type)) {
      return NextResponse.json({ success: false, error: "A challan number and a type are needed." }, { status: 400 });
    }

    await connect();

    await withTransaction(async (session) => {
      const existing = await Challan.findOne({ challanNo, type }).session(session).lean();
      if (!existing) throw new AbortTransaction({ success: false, error: "Challan not found." }, 404);
      const blocked = deleteBlockedReason(existing);
      if (blocked) throw new AbortTransaction({ success: false, error: blocked }, 409);
      // A backstop beside the billed figures: any invoice still pointing at
      // this challan keeps it.
      const used = await Invoice.findOne(
        { "items.challanNo": challanNo, "items.challanType": type },
        { invoiceNo: 1 },
        { session }
      ).lean();
      if (used) {
        throw new AbortTransaction(
          { success: false, error: `${challanKind(type).label} ${challanNo} is used in invoice ${used.invoiceNo}. Alter or delete that invoice first.` },
          409
        );
      }
      // An MRI a Re-MRI was raised against stays (lib/mriSave.mjs).
      await assertMriDeletable(existing, session);
      await Challan.deleteOne({ challanNo, type }, { session });
      await deleteChallanLedgerRows({ session, type, challanNo });
    });

    return NextResponse.json({ success: true, message: `${challanKind(type).label} ${challanNo} deleted.` });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("Error deleting challan:", err);
    return NextResponse.json({ success: false, error: "The challan could not be deleted." }, { status: 500 });
  }
}

export const POST = tenantRoute(handlePOST);

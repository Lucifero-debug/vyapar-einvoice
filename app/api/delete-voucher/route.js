import { NextResponse } from "next/server";
import Voucher from "../../../models/voucherModel";
import Ledger from "../../../models/ledgerModel";
import Customer from "../../../models/custModel";
import { balancePipeline } from "@/lib/balance.mjs";
import { buildVoucherBalanceDeltas } from "@/lib/voucherLedger.mjs";
import { recomputeLedgerBalances } from "@/lib/runningBalances.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Voucher ID missing" }, { status: 400 });
    }

    // Balance rollback, ledger cleanup and the delete itself are one unit.
    const deletedVoucher = await withTransaction(async (session) => {
    // 1️⃣ Fetch voucher before deletion
    const voucher = await Voucher.findById(id).session(session);
    if (!voucher) {
      throw new AbortTransaction({ error: "Voucher not found" }, 404);
    }

    const { customers } = voucher;

    // 2️⃣ Rollback balances — the exact inverse of what voucher-add applied.
    //
    // Derived from the same builder voucher-add applies, so it covers the
    // account the money moved through as well as the parties.
    const deltas = buildVoucherBalanceDeltas({
      acName: voucher.acName,
      customers: customers || [],
    });

    for (const { name, delta } of deltas) {
      await Customer.findOneAndUpdate(
        { name },
        balancePipeline(-delta),
        { session }
      );
    }

    // 3️⃣ Delete related ledger entries
    await Ledger.deleteMany({ voucherId: id }, { session });

    // 4️⃣ Delete voucher itself
      const removed = await Voucher.findByIdAndDelete(id, { session });

      await recomputeLedgerBalances(deltas.map((d) => d.name), session);

      return removed;
    });

    return NextResponse.json({
      success: true,
      message: "Voucher and related ledger entries deleted successfully.",
      deletedVoucher,
    });

  } catch (error) {
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    console.error("Delete Voucher Error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

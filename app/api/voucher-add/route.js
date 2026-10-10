import { NextResponse } from "next/server";
import Voucher from "../../../models/voucherModel";
import Ledger from "../../../models/ledgerModel";
import Customer from "../../../models/custModel";
import { balancePipeline } from "@/lib/balance.mjs";
import {
  buildVoucherBalanceDeltas,
  buildVoucherLedgerRows,
} from "@/lib/voucherLedger.mjs";
import { recomputeLedgerBalances } from "@/lib/runningBalances.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    const body = await req.json();
    const { acName, date, againstBill, acType, paymentType, narration, customers } = body;

    if (!acName || !date || !paymentType || !customers?.length) {
      return NextResponse.json(
        { error: "Missing required fields." },
        { status: 400 }
      );
    }

    // Voucher, its ledger rows and the party balances commit together.
    const newVoucher = await withTransaction(async (session) => {
      const [voucher] = await Voucher.create(
        [
          {
            acName,
            date,
            againstBill,
            acType,
            paymentType,
            narration, // ✅ main narration stored
            customers,
            createdAt: new Date(),
          },
        ],
        { session }
      );

      // -------------------------
      // LEDGER ENTRIES CREATION
      // -------------------------
      await Ledger.insertMany(
        buildVoucherLedgerRows({
          acName,
          date,
          paymentType,
          narration,
          customers,
          voucherId: voucher._id,
        }),
        { session }
      );

      // 🔄 Update balances — parties AND the account the money moved through,
      // which used to be left out so a cash account's ledger filled up while
      // its balance never moved.
      const missing = [];
      for (const { name, delta } of buildVoucherBalanceDeltas({ acName, customers })) {
        const updated = await Customer.findOneAndUpdate(
          { name },
          balancePipeline(delta),
          { new: true, session }
        );
        // A name with no account behind it used to be skipped in silence,
        // writing a ledger row whose balance never moved.
        if (!updated) missing.push(name);
      }

      if (missing.length) {
        throw new AbortTransaction(
          {
            error: `No account found for: ${missing.join(", ")}`,
          },
          400
        );
      }

      await recomputeLedgerBalances(
        [acName, ...customers.map((c) => c.name)],
        session
      );

      return voucher;
    });

    return NextResponse.json(
      { message: "Voucher and ledger entries added successfully", id: newVoucher._id },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    console.error("Error adding voucher:", error);
    return NextResponse.json(
      { error: "Failed to add voucher", details: error.message },
      { status: 500 }
    );
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

import { NextResponse } from 'next/server';
import Voucher from '../../../models/voucherModel';
import Ledger from '../../../models/ledgerModel';
import Customer from '../../../models/custModel';
import mongoose from 'mongoose';
import { balancePipeline } from '@/lib/balance.mjs';
import {
  buildVoucherBalanceDeltas,
  buildVoucherLedgerRows,
} from '@/lib/voucherLedger.mjs';
import { recomputeLedgerBalances } from '@/lib/runningBalances.mjs';
import { withTransaction, AbortTransaction } from '@/lib/withTransaction.mjs';
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    const data = await req.json();

    console.log("Received body:", data);

    const { id, acName, date, againstBill, acType, paymentType, narration, customers } = data;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid voucher ID' }, { status: 400 });
    }

    // Reversal, row replacement and re-application are one unit. Failing
    // part-way used to leave balances reversed with no ledger rows to match.
    const savedVoucher = await withTransaction(async (session) => {
    // 1. Fetch the existing voucher
    const existingVoucher = await Voucher.findById(id).session(session);
    if (!existingVoucher) {
      throw new AbortTransaction({ error: 'Voucher not found' }, 404);
    }

    // 2. Reverse balances and delete old ledger entries.
    // Derived from the same builder `voucher-add` applies, so the reversal
    // covers the account the money moved through as well as the parties.
    const previousDeltas = buildVoucherBalanceDeltas({
      acName: existingVoucher.acName,
      customers: existingVoucher.customers || [],
    });
    for (const { name, delta } of previousDeltas) {
      await Customer.findOneAndUpdate(
        { name },
        balancePipeline(-delta),
        { session }
      );
    }

    // Remove old ledger entries for this voucher
    await Ledger.deleteMany({ voucherId: id }, { session });

    // 3. Update the voucher document
    const updatedVoucher = await Voucher.findByIdAndUpdate(
      id,
      { acName, date, againstBill, acType, paymentType, narration, customers },
      { new: true, session }
    );

    // 4. Create new ledger entries and update balances.
    //
    // These rows come from the same builder `voucher-add` uses. They used to be
    // hand-rolled here in a different shape: no `customerName` (so the ledger
    // could not group them), the party always booked as a credit regardless of
    // the side actually entered, a `type` field the schema drops, and one
    // main-account row per line instead of a single aggregate.
    await Ledger.insertMany(
      buildVoucherLedgerRows({
        acName,
        date,
        paymentType,
        narration,
        customers,
        voucherId: updatedVoucher._id,
      }),
      { session }
    );

    // Re-apply on the correct side, from the same builder the reversal used.
    // This used to add `amount` regardless of whether the line was a debit or a
    // credit, so editing a receipt flipped it into a payment.
    const missing = [];
    for (const { name, delta } of buildVoucherBalanceDeltas({ acName, customers })) {
      const updated = await Customer.findOneAndUpdate(
        { name },
        balancePipeline(delta),
        { new: true, session }
      );
      if (!updated) missing.push(name);
    }

    if (missing.length) {
      throw new AbortTransaction(
        { error: `No account found for: ${missing.join(", ")}` },
        400
      );
    }

      await recomputeLedgerBalances(
        [
          existingVoucher.acName,
          acName,
          ...previousDeltas.map((d) => d.name),
          ...customers.map((c) => c.name),
        ],
        session
      );

      return updatedVoucher;
    });

    return NextResponse.json({
      message: 'Voucher updated successfully',
      success: true,
      voucher: savedVoucher,
    });

  } catch (error) {
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    console.error("[VOUCHER_UPDATE_ERROR]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

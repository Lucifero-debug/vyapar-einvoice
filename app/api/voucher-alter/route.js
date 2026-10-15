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
import { validateAllocations } from '@/lib/openBillsFor.mjs';
import { voucherProblems } from '@/lib/voucherKinds.mjs';
import { isExpenseJournal } from '@/lib/journalTypes.mjs';
import { resolveExpenseVoucher } from '@/lib/expenseVoucher.mjs';
import { withTransaction, AbortTransaction } from '@/lib/withTransaction.mjs';
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    const data = await req.json();


    const { id, kind, acName, date, againstBill, acType, paymentType, narration, customers } = data;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid voucher ID' }, { status: 400 });
    }

    const journalType = data.journalType;

    // An `Expense With GST` journal arrives as ONE expense, not as lines:
    // they are derived inside the transaction, where the supplier's state
    // and the Input heads can be read. So it is checked there, against what
    // is actually about to be written.
    if (!isExpenseJournal(journalType)) {
      // The same validator voucher-add runs, so an edit cannot save a shape a
      // new entry would have been refused -- which is how a journal comes to
      // be out of balance only after somebody edited it.
      const problems = voucherProblems({ kind, acName, paymentType, customers });
      if (problems.length) {
        return NextResponse.json({ error: problems[0], problems }, { status: 400 });
      }
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
    // The STORED kind, not the incoming one: this is undoing what was
    // posted. Reversing a journal as though it had a cash leg would look for
    // an account called undefined and leave its real lines un-reversed.
    const previousDeltas = buildVoucherBalanceDeltas({
      kind: existingVoucher.kind,
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

    // === Bills this voucher settles ===
    //
    // Checked inside the transaction, against the outstanding as it stands
    // now -- and with THIS voucher left out of what counts as settled.
    // Without that exclusion, re-saving a voucher without touching its
    // adjustment refuses itself, for the same reason re-saving a customer
    // collided with its own name before findNameClash took an excludeId.
    //
    // The expense comes first, because what it derives is what gets checked.

    // Re-derived from the edited expense, exactly as a new one is: an edit
    // that moved the supplier to another state must re-split the tax, and one
    // that changed the amount must re-figure it. This voucher's OWN previous
    // figures were reversed above, so what is written now is the whole of
    // what it claims.
    const resolvedExpense = await resolveExpenseVoucher({
      journalType,
      expense: data.expense,
      companyId: auth?.companyId,
      session,
    });

    if (resolvedExpense?.problems?.length) {
      throw new AbortTransaction(
        { error: resolvedExpense.problems[0], problems: resolvedExpense.problems },
        400
      );
    }

    const posted = resolvedExpense ? resolvedExpense.lines : customers;

    if (resolvedExpense) {
      const lineProblems = voucherProblems({
        kind,
        acName,
        paymentType,
        customers: posted,
      });
      if (lineProblems.length) {
        throw new AbortTransaction({ error: lineProblems[0], problems: lineProblems }, 400);
      }
    }

    const { customers: lines, problems } = await validateAllocations({
      customers: posted,
      excludeVoucherId: id,
      session,
    });

    if (problems.length) {
      throw new AbortTransaction({ error: problems[0], problems }, 400);
    }

    // 3. Update the voucher document
    const updatedVoucher = await Voucher.findByIdAndUpdate(
      id,
      {
        kind,
        acName,
        date,
        againstBill,
        acType,
        paymentType,
        narration,
        customers: lines,
        journalType,
        // Null rather than left out when this stops being an expense:
        // Mongoose drops an undefined from an update, so the voucher would
        // keep the claim of a journal it no longer is.
        expense: resolvedExpense ? resolvedExpense.expense : null,
      },
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
        kind,
        acName,
        date,
        paymentType,
        narration,
        customers: posted,
        voucherId: updatedVoucher._id,
      }),
      { session }
    );

    // Re-apply on the correct side, from the same builder the reversal used.
    // This used to add `amount` regardless of whether the line was a debit or a
    // credit, so editing a receipt flipped it into a payment.
    const missing = [];
    for (const { name, delta } of buildVoucherBalanceDeltas({
      kind,
      acName,
      customers: posted,
    })) {
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
        // Either acName is absent when the kind is a journal -- before or
        // after the edit -- and a blank name would send the recompute after
        // an account nobody has.
        [
          existingVoucher.acName,
          acName,
          ...previousDeltas.map((d) => d.name),
          ...posted.map((c) => c.name),
        ].filter(Boolean),
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

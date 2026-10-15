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
import { validateAllocations } from "@/lib/openBillsFor.mjs";
import { voucherProblems } from "@/lib/voucherKinds.mjs";
import { isExpenseJournal } from "@/lib/journalTypes.mjs";
import { resolveExpenseVoucher } from "@/lib/expenseVoucher.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    const body = await req.json();
    const { kind, acName, date, againstBill, acType, paymentType, narration, customers } = body;
    const journalType = body.journalType;

    if (!date) {
      return NextResponse.json({ error: "A voucher needs a date." }, { status: 400 });
    }

    // An `Expense With GST` journal does not arrive with its lines: it
    // arrives as ONE expense and the lines are derived from it inside the
    // transaction below, because deriving them needs the supplier's state,
    // our own, and the Input heads. So the line checks that follow are made
    // against what was derived, not against what was posted.
    const expenseJournal = isExpenseJournal(journalType);

    if (!expenseJournal) {
      // Every rule about what a kind may look like lives in one module, called
      // by the screen as a courtesy and here as the rule -- which side a line's
      // figure must sit on, that a journal has no cash leg, that a journal
      // balances. The check this replaces asked only whether four fields were
      // present, so a receipt entered as a payment passed it.
      const problems = voucherProblems({ kind, acName, paymentType, customers });
      if (problems.length) {
        return NextResponse.json({ error: problems[0], problems }, { status: 400 });
      }
    }

    // Voucher, its ledger rows and the party balances commit together.
    const newVoucher = await withTransaction(async (session) => {
      // === The expense, if this is one ===
      //
      // Null for every other voucher, and then nothing below changes. The
      // heads it may create are made inside this session, so a refusal after
      // this point takes them back out again.
      const resolvedExpense = await resolveExpenseVoucher({
        journalType,
        expense: body.expense,
        companyId: auth?.companyId,
        session,
      });

      if (resolvedExpense?.problems?.length) {
        throw new AbortTransaction(
          { error: resolvedExpense.problems[0], problems: resolvedExpense.problems },
          400
        );
      }

      // The derived lines stand in for whatever the form sent. Sigfa prints
      // "Only One Entry Per Voucher" under this grid and these are that one
      // entry's legs.
      const posted = resolvedExpense ? resolvedExpense.lines : customers;

      if (resolvedExpense) {
        // The same module, now against the lines actually being written: a
        // journal has no account absorbing the opposite of its lines, so its
        // own lines are the only thing that can balance it.
        const lineProblems = voucherProblems({
          kind,
          acName,
          paymentType,
          customers: posted,
        });
        if (lineProblems.length) {
          throw new AbortTransaction(
            { error: lineProblems[0], problems: lineProblems },
            400
          );
        }
      }
      // === Bills this voucher settles ===
      //
      // Sigfa's "Against Bill". Checked INSIDE the transaction, against the
      // outstanding figure as it stands now: two people settling the same
      // bill at once would each be allowed by a snapshot taken before the
      // other committed. lib/billAdjust.mjs carries the rules.
      const { customers: lines, problems } = await validateAllocations({
        customers: posted,
        session,
      });

      if (problems.length) {
        throw new AbortTransaction({ error: problems[0], problems }, 400);
      }

      const [voucher] = await Voucher.create(
        [
          {
            kind,
            acName,
            date,
            againstBill,
            acType,
            paymentType,
            narration, // ✅ main narration stored
            customers: lines,
            // Absent on every voucher that is not a journal, and read as the
            // general journal when absent -- lib/journalTypes.mjs.
            journalType,
            // What was claimed, as it was claimed. Left off entirely when
            // there is no expense, rather than written as an empty block.
            ...(resolvedExpense ? { expense: resolvedExpense.expense } : {}),
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
          kind,
          acName,
          date,
          paymentType,
          narration,
          customers: posted,
          voucherId: voucher._id,
        }),
        { session }
      );

      // 🔄 Update balances — parties AND the account the money moved through,
      // which used to be left out so a cash account's ledger filled up while
      // its balance never moved.
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
        // acName is absent on a journal, and a blank name in this list would
        // have the recompute look for an account nobody has.
        [acName, ...posted.map((c) => c.name)].filter(Boolean),
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

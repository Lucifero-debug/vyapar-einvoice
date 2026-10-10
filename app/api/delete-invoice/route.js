import { NextResponse } from "next/server";
import Invoice from "../../../models/invoiceModel";
import Customer from "../../../models/custModel";
import Ledger from "../../../models/ledgerModel";
import ItemLedger from "../../../models/itemLedgerModel";
import { balancePipeline, round2, toDisplay, voucherDelta } from "@/lib/balance.mjs";
import { invoicePostingDeltas } from "@/lib/invoicePosting.mjs";
import {
  recomputeItemBalances,
  recomputeLedgerBalances,
} from "@/lib/runningBalances.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { LOCKED_STATUS, deleteBlockedReason } from "@/lib/einvoiceLock.mjs";
import { releaseOrderQty } from "@/lib/orderClaims.mjs";

async function handlePOST(req, auth) {
  try {
    const url = new URL(req.url);
    const invoiceNo = url.searchParams.get("id");

    if (!invoiceNo) {
      return NextResponse.json({ error: "Invoice number missing in query." }, { status: 400 });
    }

    // Invoice, its ledger rows, its stock rows and the balance reversal all
    // commit together — a partial delete used to leave dangling ledger entries
    // or a balance reversed against an invoice that still existed.
    const { deletedInvoice, deletedLedgerCount, partyName, partyBalance } =
      await withTransaction(async (session) => {
        // Read before deleting. Once the IRP has acknowledged an invoice it
        // holds a signed copy naming this number, and the buyer will claim
        // credit against that copy -- so ours has to stay. Checking the row
        // while it is still there beats deleting it and relying on a rollback
        // to put it back. A row that does not exist falls through to the 404
        // below.
        const existing = await Invoice.findOne(
          { invoiceNo: Number(invoiceNo) },
          { invoiceNo: 1, irn: 1, ackDt: 1, einvoiceStatus: 1 }
        )
          .session(session)
          .lean();

        const blocked = deleteBlockedReason(existing);
        if (blocked) {
          throw new AbortTransaction(
            { error: blocked, irn: existing.irn },
            LOCKED_STATUS
          );
        }

        const deletedInvoice = await Invoice.findOneAndDelete(
          { invoiceNo: Number(invoiceNo) },
          { session }
        );

        if (!deletedInvoice) {
          throw new AbortTransaction({ error: "Invoice not found." }, 404);
        }

        // === Find this invoice's ledger rows ===
        //
        // By `voucherId` and nothing else. Rows used to be matched on their
        // narration too ("...Invoice No: 12"), which is free text a user also
        // types on a receipt voucher against that same bill -- so deleting the
        // invoice silently ate the VOUCHER's row, leaving the party's balance
        // permanently disagreeing with its own ledger. Every row an invoice
        // writes carries its `voucherId`; the narration match only ever added
        // other people's rows.
        const rows = await Ledger.find(
          { voucherId: deletedInvoice._id },
          { customerName: 1, debit: 1, credit: 1 },
          { session }
        ).lean();

        const partyName = deletedInvoice.customer?.name;

        // Reverse the settlement legs by what was ACTUALLY posted, against
        // whichever account they landed in. Re-deriving them instead would
        // move money that was never posted on invoices raised before the
        // receipt leg existed, and would guess wrong on any invoice whose
        // payment type has since been edited.
        const settlement = new Map();
        for (const row of rows) {
          if (!row.customerName || row.customerName === partyName) continue;
          settlement.set(
            row.customerName,
            round2(
              (settlement.get(row.customerName) || 0) +
                voucherDelta({ debit: row.debit, credit: row.credit })
            )
          );
        }

        const deleteResult = await Ledger.deleteMany(
          { voucherId: deletedInvoice._id },
          { session }
        );

        await ItemLedger.deleteMany({ invoiceNo: Number(invoiceNo) }, { session });

        // === Reverse the balances ===
        //
        // Deleting an invoice undoes exactly what posting it did, derived from
        // the same function `save-invoice` and `sale-alter` apply. This used to
        // reverse by the stored `balanceDue` while the posting moved the party
        // by finalAmount - received: identical whenever the client's arithmetic
        // agreed, and a permanent drift whenever it did not.
        const deltas = invoicePostingDeltas({
          type: deletedInvoice.type,
          isReturn: deletedInvoice.return,
          finalAmount:
            deletedInvoice.finalAmount ??
            Number(deletedInvoice.balanceDue || 0) +
              Number(deletedInvoice.received || 0),
          received: deletedInvoice.received,
        });

        const moves = new Map();
        const move = (name, delta) => {
          if (!name || !delta) return;
          moves.set(name, round2((moves.get(name) || 0) + delta));
        };
        move(partyName, -deltas.partyDelta);
        for (const [name, posted] of settlement) move(name, -posted);

        let partyBalance = 0;
        for (const [name, delta] of moves) {
          const updated = await Customer.findOneAndUpdate(
            { name },
            balancePipeline(delta),
            { new: true, session }
          );
          if (updated && name === partyName) partyBalance = updated.lastBal;
        }

        await recomputeLedgerBalances([...moves.keys()], session);
        await recomputeItemBalances(
          (deletedInvoice.items || []).map((i) => i?.name),
          session
        );

        // Hand the quantities back to whatever orders this bill consumed, so
        // the goods become pending again rather than staying billed against an
        // invoice that no longer exists. lib/orderClaims.mjs.
        await releaseOrderQty({ session, items: deletedInvoice.items });

        return {
          deletedInvoice,
          deletedLedgerCount: deleteResult.deletedCount,
          partyName,
          partyBalance,
        };
      });

    return NextResponse.json({
      message: "Invoice and related ledger entries deleted successfully",
      success: true,
      deletedLedgerCount,
      deletedInvoice,
      updatedCustomer: partyName
        ? {
            name: partyName,
            balance: toDisplay(partyBalance).amount,
            signedBalance: partyBalance,
            mode: toDisplay(partyBalance).mode,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    console.error("❌ Delete Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

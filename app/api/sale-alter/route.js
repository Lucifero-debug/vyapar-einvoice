import { NextResponse } from "next/server";
import Invoice from "../../../models/invoiceModel";
import Customer from "../../../models/custModel";
import Ledger from "../../../models/ledgerModel";
import Item from "../../../models/itemModel";
import State from "../../../models/stateModel";
import { applyDelta, toDisplay } from "@/lib/balance.mjs";
import { resolveCashAccount } from "@/lib/cashAccount.mjs";
import {
  buildInvoiceLedgerRows,
  invoicePostingDeltas,
} from "@/lib/invoicePosting.mjs";
import { writeItemLedgerRows } from "@/lib/itemLedger.mjs";
import {
  recomputeItemBalances,
  recomputeLedgerBalances,
} from "@/lib/runningBalances.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import {
  BUYER_PROJECTION,
  buyerSnapshot,
  needsStateLookup,
  placeOfSupply,
} from "@/lib/buyerSnapshot.mjs";
import { stampItemLines } from "@/lib/uqc.mjs";
import { LOCKED_STATUS, editBlockedReason } from "@/lib/einvoiceLock.mjs";
import { reconcileOrderQty } from "@/lib/orderClaims.mjs";

async function handlePOST(req, auth) {
  try {
    const invoiceData = await req.json();

    // The invoice number is an editable field on the form, so it cannot also be
    // the lookup key: changing #5 to #6 used to find invoice SIX and overwrite
    // it with #5's contents, leaving #5 untouched. The page sends the number it
    // opened with, and that is what identifies the row.
    const lookupNo = Number(
      invoiceData.originalInvoiceNo ?? invoiceData.invoiceNo
    );
    const nextNo = Number(invoiceData.invoiceNo);

    if (!Number.isFinite(lookupNo)) {
      return NextResponse.json(
        { success: false, error: "Invoice number missing." },
        { status: 400 }
      );
    }

    // Edit and every posting it implies commit together: a failure between them
    // used to leave the party's balance reflecting an invoice that no longer
    // existed in that form.
    const { updatedInvoice, customer } = await withTransaction(async (session) => {
      // Snapshot the invoice as it stands so its old effect can be reversed
      // before the new one is applied.
      const previousInvoice = await Invoice.findOne({ invoiceNo: lookupNo })
        .session(session)
        .lean();

      if (!previousInvoice) {
        throw new AbortTransaction({ success: false, error: "Invoice not found" });
      }

      // Nothing about a reported invoice may change -- including its number.
      // The IRP's signed copy names that number, so renumbering the row is as
      // much of a divergence as editing the amounts. See lib/einvoiceLock.mjs.
      const blocked = editBlockedReason(previousInvoice);
      if (blocked) {
        throw new AbortTransaction(
          { success: false, error: blocked, irn: previousInvoice.irn },
          LOCKED_STATUS
        );
      }

      // Renumbering onto an invoice that already exists would destroy it.
      if (Number.isFinite(nextNo) && nextNo !== lookupNo) {
        const clash = await Invoice.findOne({ invoiceNo: nextNo })
          .session(session)
          .lean();
        if (clash) {
          throw new AbortTransaction({
            success: false,
            error: `Invoice No ${nextNo} already exists.`,
          });
        }
      }

      // The buyer, as the master stands now. Read before the update because
      // the invoice carries its own copy of them -- and because the block
      // written here used to list name, phone and email only, which silently
      // dropped `custId` from every invoice that was ever edited.
      const buyer = await Customer.findOne(
        { name: invoiceData.customer?.name },
        BUYER_PROJECTION,
        { session }
      ).lean();

      const buyerBlock = buyerSnapshot(buyer, invoiceData.customer);

      // The place of supply is the party's own state, from their master -- not
      // whatever the form sent. It used to be a dropdown picked per bill, and
      // the state code is what decides CGST+SGST against IGST, so a slip there
      // is not cosmetic. lib/buyerSnapshot.mjs.
      let place = placeOfSupply(buyerBlock);
      if (needsStateLookup(buyerBlock)) {
        // Only for a party recorded before the state dropdown existed, who
        // has the name and no code (or the reverse). Normally skipped.
        const states = await State.find({}, { name: 1, code: 1 }, { session }).lean();
        place = placeOfSupply(buyerBlock, states);
      }

      // The unit code and the goods/service flag come from the item master,
      // never from the page, and are COPIED onto each line -- an item whose
      // unit code is corrected next year must not change the unit on a bill
      // already reported to the IRP. lib/uqc.mjs.
      const itemMasters = await Item.find(
        { name: { $in: (invoiceData.items || []).map((i) => i?.name).filter(Boolean) } },
        { name: 1, uqc: 1, isService: 1 },
        { session }
      ).lean();

      const updatedInvoice = await Invoice.findOneAndUpdate(
        { invoiceNo: lookupNo },
        {
          invoiceNo: Number.isFinite(nextNo) ? nextNo : lookupNo,
          date: invoiceData.date,
          customer: buyerBlock,
          paymentType: invoiceData.paymentType,
          stateOfSupply: place.stateOfSupply,
          stateCode: place.stateCode,
          taxType: invoiceData.taxType,
          gst: invoiceData.gst,
          totalAmount: invoiceData.totalAmount,
          // finalAmount used to be left out entirely, so an edited invoice kept
          // its original grand total while every other figure moved.
          finalAmount: Number(invoiceData.finalAmount) || 0,
          received: Number(invoiceData.received) || 0,
          balanceDue: invoiceData.balanceDue,
          items: stampItemLines(invoiceData.items, itemMasters),
          partyTaxes: invoiceData.partyTaxes || [],
          hsnTotals: invoiceData.hsnTotals || [],
          weight: Number(invoiceData.weight) || 0,
          transport: invoiceData.transport || "",
          grNo: invoiceData.grNo || "",
          grDate: invoiceData.grDate ? new Date(invoiceData.grDate) : null,
          orderNo: Number(invoiceData.orderNo) || 0,
          orderDate: invoiceData.orderDate ? new Date(invoiceData.orderDate) : null,
          pvtMark: invoiceData.pvtMark || "",
          caseDetails: invoiceData.caseDetails || "",
          freight: invoiceData.freight || "",
          ewayBillNo: invoiceData.ewayBillNo || "",
          ewayBillDate: invoiceData.ewayBillDate
            ? new Date(invoiceData.ewayBillDate)
            : null,
          type: invoiceData.type,
          return: invoiceData.return || false,
        },
        { new: true, session }
      );

      if (!updatedInvoice) {
        throw new AbortTransaction({ success: false, error: "Invoice not found" });
      }

      // ---- reverse the old posting ----------------------------------------
      const before = invoicePostingDeltas({
        type: previousInvoice.type,
        isReturn: previousInvoice.return,
        finalAmount:
          previousInvoice.finalAmount ??
          Number(previousInvoice.balanceDue || 0) +
            Number(previousInvoice.received || 0),
        received: previousInvoice.received,
      });

      // The reversal belongs to whoever the invoice was billed to BEFORE the
      // edit. Applying it to the new name instead meant that moving an invoice
      // from A to B left A never reversed, and B carrying both A's reversal and
      // its own posting.
      const previousName = previousInvoice.customer?.name;
      if (previousName) {
        const previousCustomer = await Customer.findOne(
          { name: previousName },
          null,
          { session }
        );
        if (previousCustomer) {
          applyDelta(previousCustomer, -before.partyDelta);
          await previousCustomer.save({ session });
        }
      }

      // ---- apply the new one ----------------------------------------------
      const customer = await Customer.findOne(
        { name: invoiceData.customer.name },
        null,
        { session }
      );

      if (!customer) {
        throw new AbortTransaction({ success: false, error: "Customer not found" });
      }

      const after = invoicePostingDeltas({
        type: invoiceData.type,
        isReturn: Boolean(invoiceData.return),
        finalAmount:
          invoiceData.finalAmount ??
          Number(invoiceData.balanceDue || 0) + Number(invoiceData.received || 0),
        received: invoiceData.received,
      });

      // Re-read, in case the party is unchanged and the reversal above already
      // moved this very document.
      const target =
        previousName === invoiceData.customer.name
          ? await Customer.findOne({ name: invoiceData.customer.name }, null, { session })
          : customer;

      applyDelta(target, after.partyDelta);
      await target.save({ session });

      // ---- cash ------------------------------------------------------------
      let cashAccount = null;
      if (before.cashDelta !== 0 || after.cashDelta !== 0) {
        cashAccount = await resolveCashAccount(session);
        applyDelta(cashAccount, -before.cashDelta + after.cashDelta);
        await cashAccount.save({ session });
      }

      // ---- rewrite the rows -------------------------------------------------
      // The ledger was never touched here at all, so an edited invoice left its
      // original rows in place and the report drifted from the balance forever.
      await Ledger.deleteMany({ voucherId: updatedInvoice._id }, { session });
      await Ledger.create(
        buildInvoiceLedgerRows({
          type: invoiceData.type,
          customerName: invoiceData.customer.name,
          cashAccountName: cashAccount?.name,
          invoiceNo: updatedInvoice.invoiceNo,
          date: updatedInvoice.date || new Date(),
          paymentType: invoiceData.paymentType,
          voucherId: updatedInvoice._id,
          deltas: after,
          partyBalance: target.lastBal,
          cashBalance: cashAccount?.lastBal ?? 0,
        }),
        { session }
      );

      // Stock was not maintained here either: changing a quantity left the old
      // one in the stock ledger. Clear the old number's rows too, in case the
      // invoice was renumbered.
      if (Number.isFinite(nextNo) && nextNo !== lookupNo) {
        await writeItemLedgerRows({
          session,
          invoiceNo: lookupNo,
          date: updatedInvoice.date || new Date(),
          type: invoiceData.type,
          isReturn: Boolean(invoiceData.return),
          items: [],
          partyName: invoiceData.customer.name,
        });
      }

      await writeItemLedgerRows({
        session,
        invoiceNo: updatedInvoice.invoiceNo,
        date: updatedInvoice.date || new Date(),
        type: invoiceData.type,
        isReturn: Boolean(invoiceData.return),
        items: invoiceData.items,
        partyName: invoiceData.customer.name,
      });

      await recomputeLedgerBalances(
        [previousName, invoiceData.customer.name, cashAccount?.name],
        session
      );
      await recomputeItemBalances(
        [
          ...(previousInvoice.items || []).map((i) => i?.name),
          ...(invoiceData.items || []).map((i) => i?.name),
        ],
        session
      );

      // === Move the orders by the DIFFERENCE only ===
      //
      // Not by releasing everything and re-claiming it: an edit that merely
      // shifts a quantity between two lines of the same order would then
      // release line A and claim line B as two separate writes, and the
      // over-billing guard would see an inconsistent order in between.
      //
      // `updatedInvoice.items` rather than `invoiceData.items`, so the
      // comparison is against what was actually stored. lib/orderClaims.mjs.
      await reconcileOrderQty({
        session,
        before: previousInvoice.items,
        after: updatedInvoice.items,
      });

      return { updatedInvoice, customer: target };
    });

    return NextResponse.json({
      message: "Invoice updated successfully",
      success: true,
      updatedInvoice,
      customerBalance: {
        name: customer.name,
        balance: toDisplay(customer.lastBal).amount,
        signedBalance: customer.lastBal,
        mode: customer.lastMode,
      },
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    console.error(error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

import { NextResponse } from "next/server";
import Invoice from "../../../models/invoiceModel";
import Customer from "../../../models/custModel";
import Ledger from "../../../models/ledgerModel";
import Item from "../../../models/itemModel";
import State from "../../../models/stateModel";
import { applyDelta, balancePipeline, toDisplay } from "@/lib/balance.mjs";
import { resolvePaymentAccount } from "@/lib/cashAccount.mjs";
import { glDeltas } from "@/lib/invoiceGl.mjs";
import { resolveGlAccounts } from "@/lib/glAccounts.mjs";
import {
  balanceMovesFromRows,
  withPartyCashLeg,
  buildInvoiceLedgerRows,
  invoicePostingDeltas,
} from "@/lib/invoicePosting.mjs";
import { writeItemLedgerRows } from "@/lib/itemLedger.mjs";
import {
  recomputeItemBalances,
  recomputeLedgerBalances,
} from "@/lib/runningBalances.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { mriFields } from "@/lib/mriSave.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import {
  BUYER_PROJECTION,
  buyerSnapshot,
  needsStateLookup,
  placeOfSupply,
} from "@/lib/buyerSnapshot.mjs";
import { stampItemLines } from "@/lib/uqc.mjs";
import Company from "@/models/companyModel";
import { taxTypeFor } from "@/lib/gst.mjs";
import { LOCKED_STATUS, editBlockedReason } from "@/lib/einvoiceLock.mjs";
import { reconcileOrderQty } from "@/lib/orderClaims.mjs";
import { reconcileChallanQty } from "@/lib/challanClaims.mjs";
import Challan from "@/models/challanModel";
import {
  challanLineProblems,
  challanRefsOf,
  invoiceStockLines,
  stampChallanStock,
} from "@/lib/challanStatus.mjs";
import { settledBillProblem } from "@/lib/billAdjust.mjs";
import { settledAgainst } from "@/lib/openBillsFor.mjs";
import Order from "@/models/orderModel";
import {
  linesNeedingMaster,
  orderLineProblems,
  orderRefsOf,
  partyProblem,
  paymentAccountProblem,
  prepareInvoiceInput,
  unknownItems,
} from "@/lib/invoiceInput.mjs";

async function handlePOST(req, auth) {
  try {
    const body = await req.json().catch(() => null);

    // Validated and recomputed before anything is read or written: the same
    // allowlist and the same arithmetic as save-invoice (lib/invoiceInput.mjs).
    // This route used to store `balanceDue`, `totalAmount`, `gst`, the HSN
    // summary, the party taxes and every line figure exactly as sent.
    const prepared = prepareInvoiceInput(body, { mode: "edit" });
    if (!prepared.ok) {
      return NextResponse.json({ success: false, error: prepared.error }, { status: 400 });
    }
    const invoiceData = prepared.invoice;

    const notAParty = partyProblem(invoiceData.customer.name);
    if (notAParty) {
      return NextResponse.json({ success: false, error: notAParty }, { status: 400 });
    }

    // The invoice number is an editable field on the form, so it cannot also be
    // the lookup key: changing #5 to #6 used to find invoice SIX and overwrite
    // it with #5's contents, leaving #5 untouched. The page sends the number it
    // opened with, and that is what identifies the row.
    //
    // Both are positive whole numbers by now -- a 0, a fraction or a negative
    // used to be accepted as the new number.
    const lookupNo = invoiceData.originalInvoiceNo;
    const nextNo = invoiceData.invoiceNo ?? lookupNo;

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
      if (nextNo !== lookupNo) {
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
        { name: invoiceData.customer.name },
        BUYER_PROJECTION,
        { session }
      ).lean();

      // Refused before the update rather than after it. The old order wrote
      // the invoice with an empty buyer block first and relied on the
      // rollback; nothing should be written for a party this firm does not
      // have.
      if (!buyer) {
        throw new AbortTransaction({ success: false, error: "Customer not found" });
      }
      const headProblem = partyProblem(buyer.name);
      if (headProblem) {
        throw new AbortTransaction({ success: false, error: headProblem }, 400);
      }

      const buyerBlock = buyerSnapshot(buyer, invoiceData.customer);

      // Vouchers that settled this bill name it by type and number, and are
      // counted against its party and amount due. Renumbering it, moving it
      // to another party or kind, or cutting what is due below what has been
      // settled would orphan or double that money. lib/billAdjust.mjs.
      const settled = await settledAgainst({
        invoiceNo: previousInvoice.invoiceNo,
        type: previousInvoice.type,
        session,
      });
      const settledProblem = settledBillProblem({
        before: previousInvoice,
        after: {
          invoiceNo: nextNo,
          type: invoiceData.type,
          return: invoiceData.return,
          customer: { name: buyerBlock?.name ?? buyer.name },
          balanceDue: invoiceData.balanceDue,
        },
        ...settled,
      });
      if (settledProblem) {
        throw new AbortTransaction({ success: false, error: settledProblem }, 409);
      }

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

      /*
        CGST+SGST or IGST, from the two state codes -- the same rule and the
        same reasoning as save-invoice, where it is set out in full.

        Derived on an EDIT too, and from the place resolved just above, so the
        tax type cannot drift away from the place of supply written on the
        same document. This route already re-derives the place rather than
        trusting the form; a bill whose place said Haryana while its taxType
        said local would post the wrong heads and file in the wrong table, and
        an edit is a re-post -- lib/invoiceGl.mjs recomputes the GL from it.
      */
      const ourFirm = await Company.findById(
        auth.companyId,
        { stateCode: 1 },
        { session }
      ).lean();
      const taxType = taxTypeFor(ourFirm?.stateCode, place.stateCode) ?? invoiceData.taxType;

      // The unit code and the goods/service flag come from the item master,
      // never from the page, and are COPIED onto each line -- an item whose
      // unit code is corrected next year must not change the unit on a bill
      // already reported to the IRP. lib/uqc.mjs.
      const itemMasters = await Item.find(
        { name: { $in: invoiceData.items.map((i) => i.name) } },
        { name: 1, uqc: 1, isService: 1 },
        { session }
      ).lean();

      // Every line must be one of THIS firm's items -- the query is
      // tenant-scoped, so another firm's item is simply not found.
      const missing = unknownItems(linesNeedingMaster(invoiceData.items), itemMasters);
      if (missing.length) {
        throw new AbortTransaction(
          {
            success: false,
            error: `Not in your item master: ${missing.join(", ")}. Add the item first.`,
          },
          400
        );
      }

      // Every order line a bill settles must exist on THIS firm's order and
      // name the same item. Read tenant-scoped, so another firm's order is
      // simply absent. lib/orderClaims.mjs then settles by line id.
      const refs = orderRefsOf(invoiceData.items);
      if (refs.length) {
        const orders = await Order.find(
          { $or: refs.map((r) => ({ orderNo: r.orderNo, type: r.type })) },
          { orderNo: 1, type: 1, "items._id": 1, "items.name": 1 },
          { session }
        ).lean();
        const orderProblems = orderLineProblems(invoiceData.items, orders);
        if (orderProblems.length) {
          throw new AbortTransaction({ success: false, error: orderProblems.join(" ") }, 400);
        }
      }

      // The challans this bill draws on, checked and stamped from the
      // challans themselves -- exactly as save-invoice does.
      const challanRefs = challanRefsOf(invoiceData.items);
      if (challanRefs.length) {
        const challans = await Challan.find(
          { $or: challanRefs.map((r) => ({ challanNo: r.challanNo, type: r.type })) },
          { challanNo: 1, type: 1, stockEffect: 1, "customer.name": 1, "items._id": 1, "items.name": 1 },
          { session }
        ).lean();
        const challanProblems = challanLineProblems(invoiceData.items, challans, {
          invoiceType: invoiceData.type,
          partyName: buyer.name,
        });
        if (challanProblems.length) {
          throw new AbortTransaction({ success: false, error: challanProblems.join(" ") }, 400);
        }
        invoiceData.items = stampChallanStock(invoiceData.items, challans);
      }

      // A purchase M.R.I. keeps its number across an edit; one that a Re-MRI
      // points at cannot stop being an MRI or change supplier. lib/mriSave.mjs.
      const mriData = await mriFields({
        session,
        mri: invoiceData.mri,
        previous: previousInvoice,
        party: buyer.name,
        items: invoiceData.items,
      });

      const updatedInvoice = await Invoice.findOneAndUpdate(
        { invoiceNo: lookupNo },
        // The same fields this route has always written, now from the
        // validated input, with every figure recomputed from the lines.
        // `shippedTo`, `dispatchFrom` and `partyBillNo` stay out, as they
        // always have: the edit screen does not reload the first two, so
        // writing them would blank what the bill was saved with.
        {
          invoiceNo: nextNo,
          date: invoiceData.date,
          customer: buyerBlock,
          paymentType: invoiceData.paymentType,
          stateOfSupply: place.stateOfSupply,
          stateCode: place.stateCode,
          taxType,
          gst: invoiceData.gst,
          totalAmount: invoiceData.totalAmount,
          // finalAmount used to be left out entirely, so an edited invoice kept
          // its original grand total while every other figure moved. `??`
          // throughout: a bill of zero is a bill of zero.
          finalAmount: invoiceData.finalAmount,
          received: invoiceData.received,
          balanceDue: invoiceData.balanceDue,
          items: stampItemLines(invoiceData.items, itemMasters),
          partyTaxes: invoiceData.partyTaxes,
          hsnTotals: invoiceData.hsnTotals,
          weight: invoiceData.weight,
          transport: invoiceData.transport,
          grNo: invoiceData.grNo,
          grDate: invoiceData.grDate,
          orderNo: invoiceData.orderNo ?? 0,
          orderDate: invoiceData.orderDate,
          pvtMark: invoiceData.pvtMark,
          caseDetails: invoiceData.caseDetails,
          freight: invoiceData.freight,
          ewayBillNo: invoiceData.ewayBillNo,
          ewayBillDate: invoiceData.ewayBillDate,
          type: invoiceData.type,
          return: invoiceData.return,
          mriNo: mriData.mriNo,
          mriRemark: mriData.mriRemark,
          againstMriNo: mriData.againstMriNo,
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
        isReturn: invoiceData.return,
        finalAmount: invoiceData.finalAmount,
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

      // ---- reverse everything else by WHAT WAS ACTUALLY POSTED ------------
      //
      // The cash account and the contra heads, read off the rows this invoice
      // wrote rather than re-derived. The same principle `delete-invoice`
      // already applies, and it is what makes this correct in three cases the
      // old code got wrong:
      //
      //   the money went somewhere else   the rows name the account it
      //                                   actually landed in, so a cheque
      //                                   invoice is not reversed out of the
      //                                   cash till
      //   the invoice predates a leg      an invoice with no contra rows has
      //                                   no contra reversed, instead of
      //                                   being credited with heads it never
      //                                   touched
      //   the payment type was edited     the reversal follows the old rows,
      //                                   the re-post follows the new type
      //
      // The PARTY stays on the derived `before`/`after` above, which is
      // deliberate: that path works for every invoice in the book, including
      // any whose rows were lost.
      const oldRows = await Ledger.find(
        { voucherId: updatedInvoice._id },
        { customerName: 1, account: 1, debit: 1, credit: 1 },
        { session }
      ).lean();

      // The party was already reversed by `before.partyDelta`. Its cash leg,
      // when the invoice was billed to the cash account itself, still has to
      // be -- by the derived amount, not the party's row total, which an
      // older edit may have left stale. lib/invoicePosting.mjs.
      const reverse = withPartyCashLeg(balanceMovesFromRows(oldRows), oldRows, previousName, before.cashDelta);
      for (const [name, posted] of reverse) {
        await Customer.findOneAndUpdate({ name }, balancePipeline(-posted), { session });
      }

      // ---- rewrite the rows -------------------------------------------------
      // The ledger was never touched here at all, so an edited invoice left its
      // original rows in place and the report drifted from the balance forever.
      //
      // The payment account now follows the invoice's own payment type, as
      // save-invoice does. It used to be `resolveCashAccount`, which always
      // answers "Cash" -- so editing a cheque invoice moved the money into the
      // till, and the two routes disagreed about where the same bill settled.
      let payAccount = null;
      if (after.cashDelta !== 0) {
        payAccount = await resolvePaymentAccount(invoiceData.paymentType, session);
        // A payment type naming a party instead of a cash or bank account
        // would book the receipt to that party. lib/invoiceInput.mjs.
        const badAccount = paymentAccountProblem(payAccount, invoiceData.paymentType);
        if (badAccount) {
          throw new AbortTransaction({ success: false, error: badAccount }, 400);
        }
      }

      const stored = await resolveGlAccounts(
        glDeltas(invoiceData)
          .moves.map((m) => m.account)
          .filter((n) => n !== invoiceData.customer.name),
        session
      );

      const rows = buildInvoiceLedgerRows({
        type: invoiceData.type,
        customerName: invoiceData.customer.name,
        cashAccountName: payAccount?.name,
        invoiceNo: updatedInvoice.invoiceNo,
        date: updatedInvoice.date || new Date(),
        paymentType: invoiceData.paymentType,
        voucherId: updatedInvoice._id,
        deltas: after,
        partyBalance: 0,
        cashBalance: 0,
        invoice: { ...invoiceData, invoiceNo: updatedInvoice.invoiceNo },
      }).map((row) => ({
        ...row,
        customerName: stored.get(row.customerName) || row.customerName,
      }));

      // Apply the new side from the rows, party excluded -- it was already
      // moved by `after.partyDelta` above.
      const apply = withPartyCashLeg(balanceMovesFromRows(rows), rows, invoiceData.customer.name, after.cashDelta);
      for (const [name, delta] of apply) {
        await Customer.findOneAndUpdate({ name }, balancePipeline(delta), { session });
      }

      await Ledger.deleteMany({ voucherId: updatedInvoice._id }, { session });
      await Ledger.create(rows, { session });

      // Stock was not maintained here either: changing a quantity left the old
      // one in the stock ledger. Clear the old number's rows too, in case the
      // invoice was renumbered.
      if (nextNo !== lookupNo) {
        await writeItemLedgerRows({
          session,
          invoiceNo: lookupNo,
          date: updatedInvoice.date || new Date(),
          type: invoiceData.type,
          isReturn: invoiceData.return,
          items: [],
          partyName: invoiceData.customer.name,
        });
      }

      await writeItemLedgerRows({
        session,
        invoiceNo: updatedInvoice.invoiceNo,
        date: updatedInvoice.date || new Date(),
        type: invoiceData.type,
        isReturn: invoiceData.return,
        // Not the lines whose challan already moved the stock.
        items: invoiceStockLines(invoiceData.items),
        partyName: invoiceData.customer.name,
      });

      await recomputeLedgerBalances(
        [
          previousName,
          invoiceData.customer.name,
          // Every account either side touched, so a head that was posted to
          // before the edit and not after still gets its running column
          // rewritten.
          ...reverse.keys(),
          ...apply.keys(),
        ],
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
      // And the challans, by the difference only (lib/challanClaims.mjs).
      await reconcileChallanQty({
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
    // A renumber racing another save onto the same number. The transaction
    // rolled back; nothing changed.
    if (error?.code === 11000 && error?.keyPattern?.invoiceNo) {
      return NextResponse.json(
        { success: false, error: "That invoice number was just used by another save. Choose another." },
        { status: 409 }
      );
    }
    console.error(error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

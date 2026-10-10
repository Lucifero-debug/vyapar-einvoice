import { NextResponse } from "next/server";
import Invoice from "@/models/invoiceModel";
import { getNextInvoiceNo, raiseInvoiceCounter } from "@/lib/getNextInvoiceNo";
import Customer from "../../../models/custModel";
import Item from "../../../models/itemModel";
import State from "../../../models/stateModel";
import Ledger from "../../../models/ledgerModel";
import { balancePipeline, round2 } from "@/lib/balance.mjs";
import { resolvePaymentAccount } from "@/lib/cashAccount.mjs";
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
import { claimOrderQty } from "@/lib/orderClaims.mjs";

async function handlePOST(req, auth) {
  try {
    const body = await req.json();

    // Invoice, balance, ledger and stock ledger commit together or not at all.
    // The invoice used to be written before the "customer not found" check,
    // which stranded an orphaned invoice on every miss.
    const newInvoice = await withTransaction(async (session) => {
      // Settle the number BEFORE writing. The form supplies one (from the
      // peek endpoint), which two people billing at once would both receive:
      // the unique index turned that into a failed save and a lost invoice.
      // A number that is still free is honoured; anything else is reserved
      // atomically from the counter.
      const requested = Number(body.invoiceNo);
      let invoiceNo;

      if (Number.isFinite(requested) && requested > 0) {
        const taken = await Invoice.findOne({ invoiceNo: requested }, { _id: 1 }, { session }).lean();
        if (taken) {
          invoiceNo = await getNextInvoiceNo(session);
        } else {
          invoiceNo = requested;
          await raiseInvoiceCounter(requested, session);
        }
      } else {
        invoiceNo = await getNextInvoiceNo(session);
      }

      // The money figures are DERIVED here, never taken on trust. `balanceDue`
      // used to be whatever the client sent: the posting moved the party by
      // finalAmount - received while `delete-invoice` reversed by balanceDue,
      // so any client whose arithmetic disagreed (the AI upload path passes the
      // extractor's numbers straight through) left a permanent drift behind.
      const finalAmount = round2(
        body.finalAmount ?? Number(body.balanceDue || 0) + Number(body.received || 0)
      );
      const received = round2(body.received);
      const balanceDue = round2(finalAmount - received);

      // CUSTOMER & LEDGER LOGIC
      // Uploads used to skip this entirely, so an AI-imported purchase bill
      // created an invoice and stock rows but never reached payables. An
      // invoice nobody can attribute is refused outright rather than quietly
      // kept outside the books.
      //
      // Read BEFORE the invoice is written, because the invoice now carries a
      // copy of the buyer, and because refusing an unknown party without
      // having written anything first beats rolling the write back.
      const customer = await Customer.findOne(
        { name: body.customer?.name },
        BUYER_PROJECTION,
        { session }
      ).lean();

      if (!customer) {
        throw new AbortTransaction({
          success: false,
          error: "Customer not found",
        });
      }

      const buyer = buyerSnapshot(customer, body.customer);

      // The place of supply is the party's own state, from their master -- not
      // whatever the form sent. It used to be a dropdown picked per bill, and
      // the state code is what decides CGST+SGST against IGST, so a slip there
      // is not cosmetic. lib/buyerSnapshot.mjs.
      let place = placeOfSupply(buyer);
      if (needsStateLookup(buyer)) {
        // Only for a party recorded before the state dropdown existed, who
        // has the name and no code (or the reverse). Normally skipped.
        const states = await State.find({}, { name: 1, code: 1 }, { session }).lean();
        place = placeOfSupply(buyer, states);
      }

      // The unit code and the goods/service flag come from the item master,
      // never from the page, and are COPIED onto each line -- an item whose
      // unit code is corrected next year must not change the unit on a bill
      // already reported to the IRP. lib/uqc.mjs.
      const itemMasters = await Item.find(
        { name: { $in: (body.items || []).map((i) => i?.name).filter(Boolean) } },
        { name: 1, uqc: 1, isService: 1 },
        { session }
      ).lean();

      const [invoice] = await Invoice.create(
        [
          {
            ...body,
            items: stampItemLines(body.items, itemMasters),
            stateOfSupply: place.stateOfSupply,
            stateCode: place.stateCode,
            invoiceNo,
            finalAmount,
            received,
            balanceDue,
            // The buyer as the master stands today, copied onto the document.
            // An e-invoice is a filing: what was reported has to stay readable
            // off the invoice itself. lib/buyerSnapshot.mjs.
            customer: buyer,
          },
        ],
        { session }
      );

      // Posting the net `balanceDue` is what made a fully-paid sale vanish:
      // the delta came out as zero and the money received was never booked.
      const deltas = invoicePostingDeltas({
        type: body.type,
        isReturn: Boolean(body.return),
        finalAmount,
        received,
      });

      // Where the money actually went. The form's payment type used to be
      // ignored, so cheques landed in the till.
      let payAccountName;
      if (deltas.settled !== 0) {
        const payAccount = await resolvePaymentAccount(body.paymentType, session);
        payAccountName = payAccount.name;
      }

      // Accumulate by ACCOUNT NAME before writing. A cash sale billed to the
      // cash account itself names the same document twice; loading it twice
      // and saving both copies meant the second write discarded the first.
      const moves = new Map();
      const move = (name, delta) => {
        if (!name || !delta) return;
        moves.set(name, round2((moves.get(name) || 0) + delta));
      };
      move(customer.name, deltas.partyDelta);
      move(payAccountName, deltas.cashDelta);

      const balances = new Map();
      for (const [name, delta] of moves) {
        // Pipeline update: the increment and the Dr/Cr refresh land in one
        // round trip and cannot interleave with a concurrent write.
        const updated = await Customer.findOneAndUpdate(
          { name },
          balancePipeline(delta),
          { new: true, session }
        );
        if (updated) balances.set(name, updated.lastBal);
      }

      await Ledger.create(
        buildInvoiceLedgerRows({
          type: body.type,
          customerName: customer.name,
          cashAccountName: payAccountName,
          invoiceNo,
          date: invoice.date || new Date(),
          paymentType: body.paymentType,
          voucherId: invoice._id,
          deltas,
          partyBalance: balances.get(customer.name) ?? 0,
          cashBalance: balances.get(payAccountName) ?? 0,
        }),
        { session }
      );

      // ITEM LEDGER LOGIC (always runs)
      await writeItemLedgerRows({
        session,
        invoiceNo,
        date: invoice.date || new Date(),
        type: body.type,
        isReturn: Boolean(body.return),
        items: body.items,
        partyName: body.customer?.name,
      });

      // The stored running figures only stay true if the whole account or item
      // is rewritten in order -- a back-dated entry changes everything after it.
      await recomputeLedgerBalances([customer.name, payAccountName], session);
      await recomputeItemBalances((body.items || []).map((i) => i?.name), session);

      // === Settle the orders this bill fulfils ===
      //
      // Inside the transaction, and last: over-billing aborts the whole thing,
      // so an invoice is never written against a commitment that cannot cover
      // it. A line with no order reference is simply skipped, which is every
      // line on an ordinary over-the-counter bill.
      //
      // The arithmetic lives in lib/orderClaims.mjs and nowhere else -- see
      // the note there about why three call sites would not stay in step.
      await claimOrderQty({ session, items: invoice.items });

      return invoice;
    });

    return NextResponse.json({
      success: true,
      invoice: newInvoice,
      message: "Invoice created and Ledger updated",
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("Error creating invoice:", err);
    return NextResponse.json({ success: false, error: err.message });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

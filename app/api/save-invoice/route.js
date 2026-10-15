import { NextResponse } from "next/server";
import Invoice from "@/models/invoiceModel";
import {
  getNextInvoiceNo,
  getNextSeriesNo,
  raiseInvoiceCounter,
} from "@/lib/getNextInvoiceNo";
import Customer from "../../../models/custModel";
import Item from "../../../models/itemModel";
import State from "../../../models/stateModel";
import Ledger from "../../../models/ledgerModel";
import { balancePipeline } from "@/lib/balance.mjs";
import { resolvePaymentAccount } from "@/lib/cashAccount.mjs";
import {
  balanceMovesFromRows,
  buildInvoiceLedgerRows,
  invoicePostingDeltas,
} from "@/lib/invoicePosting.mjs";
import { glDeltas } from "@/lib/invoiceGl.mjs";
import { resolveGlAccounts } from "@/lib/glAccounts.mjs";
import { writeItemLedgerRows } from "@/lib/itemLedger.mjs";
import Series from "@/models/seriesModel";
import {
  docTypeForBill,
  effectsStock,
  fyStartYear,
  seriesSnapshot,
  voucherNoFor,
} from "@/lib/series.mjs";
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
import { claimOrderQty } from "@/lib/orderClaims.mjs";
import { claimChallanQty } from "@/lib/challanClaims.mjs";
import Challan from "@/models/challanModel";
import {
  challanLineProblems,
  challanRefsOf,
  invoiceStockLines,
  stampChallanStock,
} from "@/lib/challanStatus.mjs";
import Order from "@/models/orderModel";
import {
  isDuplicateSubmission,
  linesNeedingMaster,
  orderLineProblems,
  orderRefsOf,
  partyProblem,
  paymentAccountProblem,
  prepareInvoiceInput,
  unknownItems,
} from "@/lib/invoiceInput.mjs";

/**
 * An invoice built from an ALLOWLIST, never from the request body.
 *
 * This route used to spread the whole request body into the new invoice
 * document, so any key the request carried reached it -- including
 * `companyId`, which the tenant plugin leaves alone when it is already set. A body naming another
 * firm's id wrote the invoice into that firm's books while its ledger and
 * stock rows landed in the caller's. `irn`/`einvoiceStatus` could arrive
 * pre-set (freezing the bill), and `emailLog` could be forged.
 *
 * lib/invoiceInput.mjs now builds the invoice field by field, refuses the
 * server-managed fields by name, and derives every figure from the lines with
 * the screen's own arithmetic. Whether the party, the items and the orders
 * exist is checked below through tenant-scoped queries -- another firm's
 * records are simply not found.
 */

async function handlePOST(req, auth) {
  try {
    const body = await req.json().catch(() => null);

    // Validated and recomputed BEFORE anything touches the database. A bad
    // request is a 400 with a sentence the screen can show.
    const prepared = prepareInvoiceInput(body, { mode: "create" });
    if (!prepared.ok) {
      return NextResponse.json({ success: false, error: prepared.error }, { status: 400 });
    }
    const input = prepared.invoice;

    const notAParty = partyProblem(input.customer.name);
    if (notAParty) {
      return NextResponse.json({ success: false, error: notAParty }, { status: 400 });
    }

    // Invoice, balance, ledger and stock ledger commit together or not at all.
    // The invoice used to be written before the "customer not found" check,
    // which stranded an orphaned invoice on every miss.
    const saved = await withTransaction(async (session) => {
      // Settle the number BEFORE writing. The form supplies one (from the
      // peek endpoint), which two people billing at once would both receive:
      // the unique index turned that into a failed save and a lost invoice.
      // A number that is still free is honoured; anything else is reserved
      // atomically from the counter.
      const requested = input.invoiceNo;
      let invoiceNo;

      if (requested) {
        const taken = await Invoice.findOne({ invoiceNo: requested }, null, { session }).lean();
        if (taken) {
          // A double-click, or a retry after the first response was lost,
          // asks for the number its own first attempt just took. Same party,
          // date, lines and money within a couple of minutes is that same
          // bill: hand it back instead of raising a second one. Nothing is
          // written. lib/invoiceInput.mjs, isDuplicateSubmission.
          if (isDuplicateSubmission(taken, input, { userId: auth?.userId })) {
            return { invoice: taken, duplicate: true };
          }
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
      //
      // And now ALL of them are: `finalAmount` too is recomputed from the lines,
      // the party taxes and the freight, exactly as the screen adds them up
      // (lib/invoiceInput.mjs). A request whose own total disagreed was
      // already refused above.
      const { finalAmount, received, balanceDue } = input;

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
        { name: input.customer.name },
        BUYER_PROJECTION,
        { session }
      ).lean();

      if (!customer) {
        throw new AbortTransaction({
          success: false,
          error: "Customer not found",
        });
      }

      // Again on the name as STORED, in case the request matched a posting
      // head's own spelling.
      const headProblem = partyProblem(customer.name);
      if (headProblem) {
        throw new AbortTransaction({ success: false, error: headProblem }, 400);
      }

      // `input.customer` carries no custId, so the snapshot takes the
      // master's own _id -- never an id the request supplied.
      const buyer = buyerSnapshot(customer, input.customer);

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

      /*
        CGST+SGST or IGST -- decided by the two state codes, not by the form.

        The place of supply above has always come from the master rather than
        the request, for the reason written there. The TAX TYPE did not: it
        arrived as `input.taxType` from two radio buttons on the billing
        screen, so a Delhi firm billing a Haryana party and leaving the radio
        on its "local" default posted CGST and SGST (lib/invoiceGl.mjs reads
        taxType for the heads) and filed the bill in the wrong GSTR-1 table
        (lib/gstReturns.mjs isInterState reads the same field). Nothing on the
        screen or in the books said so afterwards.

        So it is derived from OUR state and the place of supply, by the one
        rule the form now shows as well -- lib/gst.mjs taxTypeFor.

        What was submitted is used ONLY when taxTypeFor returns null, which it
        does when either code is unknown: a firm whose profile predates the
        state fields, or a party with no state on their master. Overriding
        with a guess there would be a tax decision made by a default, which is
        exactly what this is replacing.
      */
      const ourFirm = await Company.findById(
        auth.companyId,
        { stateCode: 1 },
        { session }
      ).lean();
      const taxType = taxTypeFor(ourFirm?.stateCode, place.stateCode) ?? input.taxType;

      // The unit code and the goods/service flag come from the item master,
      // never from the page, and are COPIED onto each line -- an item whose
      // unit code is corrected next year must not change the unit on a bill
      // already reported to the IRP. lib/uqc.mjs.
      const itemMasters = await Item.find(
        { name: { $in: input.items.map((i) => i.name) } },
        { name: 1, uqc: 1, isService: 1 },
        { session }
      ).lean();

      // Every line must be one of THIS firm's items. The query above is
      // tenant-scoped, so another firm's item is simply missing from it --
      // and a line nobody's master knows would write a stock row for an item
      // that does not exist.
      const missing = unknownItems(linesNeedingMaster(input.items), itemMasters);
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
      const refs = orderRefsOf(input.items);
      if (refs.length) {
        const orders = await Order.find(
          { $or: refs.map((r) => ({ orderNo: r.orderNo, type: r.type })) },
          { orderNo: 1, type: 1, "items._id": 1, "items.name": 1 },
          { session }
        ).lean();
        const orderProblems = orderLineProblems(input.items, orders);
        if (orderProblems.length) {
          throw new AbortTransaction({ success: false, error: orderProblems.join(" ") }, 400);
        }
      }

      // === The challans this bill draws on (lib/challanStatus.mjs) ===
      //
      // Each challan line must exist on THIS firm's challan, of this bill's
      // side, for this party, and name the same item -- and one bill does not
      // mix challans that moved stock with ones that did not (SIGFA: "Please
      // Select Challans With Same Effect Value !"). Then each line is stamped,
      // from the challan, with whether its stock has already moved.
      const challanRefs = challanRefsOf(input.items);
      if (challanRefs.length) {
        const challans = await Challan.find(
          { $or: challanRefs.map((r) => ({ challanNo: r.challanNo, type: r.type })) },
          { challanNo: 1, type: 1, stockEffect: 1, "customer.name": 1, "items._id": 1, "items.name": 1 },
          { session }
        ).lean();
        const challanProblems = challanLineProblems(input.items, challans, {
          invoiceType: input.type,
          partyName: customer.name,
        });
        if (challanProblems.length) {
          throw new AbortTransaction({ success: false, error: challanProblems.join(" ") }, 400);
        }
        input.items = stampChallanStock(input.items, challans);
      }

      // === A purchase M.R.I.? Its number, and any Ag. MRI No. (lib/mriSave.mjs) ===
      const mriData = await mriFields({ session, mri: input.mri, party: customer.name, items: input.items });

      // === The series this bill is raised under (Sigfa's Series Master) ===
      //
      // Read ONCE, here, and then everything it decides is frozen onto the
      // row below: the printed number, the headings and the declaration.
      // lib/series.mjs states why none of it may be read back live -- a
      // series edited next year must not renumber a bill already issued.
      //
      // A series the master does not hold resolves to null and the bill then
      // behaves exactly as every bill does today: plain number, no headings,
      // stock moves. That covers a series deleted after the bill was raised,
      // and a code that reached the body some other way.
      const seriesDocType = docTypeForBill({ type: input.type, isReturn: input.return });
      const seriesRow =
        input.series && seriesDocType
          ? await Series.findOne({ code: input.series, docType: seriesDocType })
              .session(session)
              .lean()
          : null;
      const seriesProfile = seriesSnapshot(seriesRow);
      // Sigfa's "Effect In Stock". No series, or a series that does not say
      // otherwise, moves stock -- which is every bill this app has written so
      // far, so nothing changes until somebody turns it off deliberately.
      const movesStock = effectsStock(seriesRow);

      // === The number the CUSTOMER sees ===
      //
      // Reserved from the series' own counter, inside the same transaction as
      // everything else here, so a save that rolls back releases the number
      // rather than leaving a hole in a book GST requires to be consecutive.
      //
      // Never taken from the form. `invoiceNo` above still honours a number
      // typed by hand, because that sequence is the firm's own business; this
      // one is not, so the billing screen shows it read-only and the figure
      // comes from here. The year is the BILL'S, so one dated back into March
      // is counted in the year it is dated.
      //
      // Allocated even when the master no longer holds the series, for the
      // same reason the peek counts the bills rather than the master row: a
      // series switched off mid-year must not start again at 1 if it is
      // picked again.
      const finYear = fyStartYear(input.date);
      const seriesNo = input.series
        ? await getNextSeriesNo({ series: input.series, finYear }, session)
        : null;

      // Posting the net `balanceDue` is what made a fully-paid sale vanish:
      // the delta came out as zero and the money received was never booked.
      const deltas = invoicePostingDeltas({
        type: input.type,
        isReturn: input.return,
        finalAmount,
        received,
      });

      // Where the money actually went. The form's payment type used to be
      // ignored, so cheques landed in the till. Resolved before the invoice is
      // written, so a payment type naming a party rather than a cash or bank
      // account is refused before anything exists to roll back.
      let payAccountName;
      if (deltas.settled !== 0) {
        const payAccount = await resolvePaymentAccount(input.paymentType, session);
        const badAccount = paymentAccountProblem(payAccount, input.paymentType);
        if (badAccount) {
          throw new AbortTransaction({ success: false, error: badAccount }, 400);
        }
        payAccountName = payAccount.name;
      }

      // Field by field from the validated input. NOTHING here is spread from
      // the request: companyId is stamped by the tenant plugin, and the
      // e-invoice and email fields belong to their own routes.
      const [invoice] = await Invoice.create(
        [
          {
            invoiceNo,
            series: input.series,
            // The series' own running number and the year it runs in. Null on
            // a bill with no series, which keeps it out of the partial unique
            // index -- models/invoiceModel.js. Written as two plain fields
            // rather than spread in: nothing is ever spread into this call,
            // which is what stops a request field reaching the document.
            seriesNo,
            finYear: seriesNo === null ? null : finYear,
            // What PRINTS: the financial year, a slash and `seriesNo` padded
            // by the series. Settled now and never recomputed.
            //
            // A series the master no longer holds still prints its number,
            // just without the padding -- that setting went with the row.
            // Composing from nothing would leave a numbered bill printing a
            // blank where its number goes.
            voucherNo: voucherNoFor(
              seriesNo,
              input.series ? seriesRow || { code: input.series } : null,
              input.date
            ),
            seriesSnapshot: seriesProfile,
            date: input.date,
            type: input.type,
            return: input.return,
            paymentType: input.paymentType,
            taxType,
            items: stampItemLines(input.items, itemMasters),
            partyTaxes: input.partyTaxes,
            hsnTotals: input.hsnTotals,
            gst: input.gst,
            totalAmount: input.totalAmount,
            finalAmount,
            received,
            balanceDue,
            stateOfSupply: place.stateOfSupply,
            stateCode: place.stateCode,
            shippedTo: input.shippedTo,
            dispatchFrom: input.dispatchFrom,
            transport: input.transport,
            grNo: input.grNo,
            grDate: input.grDate,
            pvtMark: input.pvtMark,
            caseDetails: input.caseDetails,
            freight: input.freight,
            weight: input.weight,
            orderNo: input.orderNo,
            orderDate: input.orderDate,
            ewayBillNo: input.ewayBillNo,
            ewayBillDate: input.ewayBillDate,
            partyBillNo: input.partyBillNo,
            // Purchase M.R.I. -- set only when it is one (lib/mriSave.mjs).
            mriNo: mriData.mriNo || undefined,
            mriRemark: mriData.mriNo ? mriData.mriRemark : undefined,
            againstMriNo: mriData.againstMriNo || undefined,
            // Who raised it, from the session. Server-set like companyId:
            // the double-submit check above only matches a user's own bill.
            createdBy: auth?.userId,
            // The buyer as the master stands today, copied onto the document.
            // An e-invoice is a filing: what was reported has to stay readable
            // off the invoice itself. lib/buyerSnapshot.mjs.
            customer: buyer,
          },
        ],
        { session }
      );

      // === The contra side ===
      //
      // Sales or Purchase, the GST heads and the round-off. Until this was
      // added, "Sales Account" existed only as text in the contra column of
      // the party's row and GST was not posted at all, so a trial balance
      // drawn from this ledger was short by exactly sales plus tax --
      // silently, because every report read one account at a time.
      // lib/invoiceGl.mjs derives it from the LINES, not from the totals the
      // client sent.
      //
      // The heads are found or created first, so the rows below name whatever
      // spelling is actually stored: a head saved as "Round off" must not be
      // posted to as "Round Off" and split in two.
      const contra = glDeltas({ ...input, finalAmount, customer: buyer });
      const stored = await resolveGlAccounts(
        contra.moves.map((m) => m.account).filter((n) => n !== customer.name),
        session
      );

      // ROWS FIRST, then the balances they imply. The `partyBalance` and
      // `cashBalance` passed in are the running figures printed on the rows,
      // and `recomputeLedgerBalances` below rewrites every one of them end to
      // end -- so building with zeros and recomputing lands in exactly the
      // same place, and lets the balance moves come from the rows themselves.
      const rows = buildInvoiceLedgerRows({
        type: input.type,
        customerName: customer.name,
        cashAccountName: payAccountName,
        invoiceNo,
        date: invoice.date || new Date(),
        paymentType: input.paymentType,
        voucherId: invoice._id,
        deltas,
        partyBalance: 0,
        cashBalance: 0,
        invoice: { ...input, finalAmount, customer: buyer, invoiceNo },
      }).map((row) => ({
        ...row,
        customerName: stored.get(row.customerName) || row.customerName,
      }));

      // ONE source of truth for the balance updates: what the rows say.
      // `delete-invoice` already reverses by reading these rows back, so
      // deriving the posting from the same place is what stops the two
      // drifting -- the bug that was found when deleting reversed by the
      // stored `balanceDue` while posting moved the party by
      // finalAmount - received. The party's own rows still sum to
      // `deltas.partyDelta`, so no party balance shifts because of this.
      const moves = balanceMovesFromRows(rows);

      for (const [name, delta] of moves) {
        // Pipeline update: the increment and the Dr/Cr refresh land in one
        // round trip and cannot interleave with a concurrent write.
        await Customer.findOneAndUpdate({ name }, balancePipeline(delta), {
          new: true,
          session,
        });
      }

      await Ledger.create(rows, { session });

      // ITEM LEDGER LOGIC (always runs). Lines billing a challan that
      // already moved the goods write no stock row of their own -- SIGFA's
      // Dsale -- or the stock would go out twice.
      //
      // And a series with Effect In Stock off writes none at all. Passed as
      // an EMPTY LIST rather than skipped, because the helper clears this
      // invoice's existing rows first -- so turning the effect off and
      // re-saving takes the old movements back out instead of leaving them.
      await writeItemLedgerRows({
        session,
        invoiceNo,
        date: invoice.date || new Date(),
        type: input.type,
        isReturn: input.return,
        items: movesStock ? invoiceStockLines(input.items) : [],
        partyName: customer.name,
      });

      // The stored running figures only stay true if the whole account or item
      // is rewritten in order -- a back-dated entry changes everything after it.
      // Every account the rows touched, not just the party and the cash
      // account: the contra heads have a running column too.
      await recomputeLedgerBalances([...moves.keys()], session);
      await recomputeItemBalances(input.items.map((i) => i.name), session);

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
      // And the challans, the same way (lib/challanClaims.mjs).
      await claimChallanQty({ session, items: invoice.items });

      return { invoice, duplicate: false };
    });

    if (saved.duplicate) {
      return NextResponse.json({
        success: true,
        duplicate: true,
        invoice: saved.invoice,
        message: `Invoice ${saved.invoice.invoiceNo} was already saved.`,
      });
    }

    return NextResponse.json({
      success: true,
      invoice: saved.invoice,
      message: "Invoice created and Ledger updated",
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    // Two saves racing for the same number past the duplicate check above.
    // Nothing was written -- the transaction rolled back -- so say so plainly
    // rather than surfacing a raw E11000. Only for the invoice number's own
    // index: a clash anywhere else is a different fault and keeps its message.
    if (err?.code === 11000 && err?.keyPattern?.invoiceNo) {
      return NextResponse.json(
        { success: false, error: "That invoice number was just used by another save. Save again." },
        { status: 409 }
      );
    }
    console.error("Error creating invoice:", err);
    return NextResponse.json({ success: false, error: err.message });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);

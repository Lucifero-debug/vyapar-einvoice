/**
 * Turning one `Expense With GST` journal into the lines it posts.
 *
 * NOT pure, and one of the documented exceptions in lib/ — the same exception
 * as glAccounts.mjs, itemLedger.mjs, runningBalances.mjs and cashAccount.mjs.
 * It reads the supplier's state, the firm's state and the three Input heads,
 * none of which a pure module can do. THE RULES stay in lib/journalTypes.mjs,
 * which runs under bare node; what is here is the fetching.
 *
 * Called by voucher-add and voucher-alter, inside their transaction, so a
 * refused expense leaves nothing behind and the head created for a firm's
 * first taxed expense is rolled back with it.
 *
 * WHAT COMES BACK is the voucher's ordinary `customers` lines plus the
 * expense block to store. Nothing downstream learns a new shape: the ledger
 * rows, the balance deltas and the delete path all treat it as the journal it
 * is.
 */

import Company from "../models/companyModel";
import Customer from "../models/custModel";
import State from "../models/stateModel";
import { resolveGlAccounts } from "./glAccounts.mjs";
import { TAX_ACCOUNTS } from "./invoiceGl.mjs";
import { needsStateLookup, placeOfSupply } from "./placeOfSupply.mjs";
import {
  expenseLegs,
  expenseProblems,
  expenseTax,
  expenseTaxType,
  isExpenseJournal,
  normalizeExpense,
} from "./journalTypes.mjs";
import { round2 } from "./balance.mjs";

/**
 * Resolve the expense, or answer null when this is not one.
 *
 * Returns `{ lines, expense, problems }`. A caller with `problems` must write
 * nothing: the figures alongside them are the unvalidated draft, kept only so
 * a screen can show what it was looking at.
 *
 *   companyId  whose firm's state decides the place of supply
 *   session    the caller's transaction, passed to every read and to the
 *              head creation, so a rollback takes the new heads with it
 */
export async function resolveExpenseVoucher({
  journalType,
  expense,
  companyId,
  session = null,
} = {}) {
  if (!isExpenseJournal(journalType)) return null;

  const opts = session ? { session } : {};
  let draft = normalizeExpense(expense);

  // === The place of supply ===
  //
  // The supplier's own state, from their master -- not from the form. The
  // state code is what decides CGST+SGST against IGST, so a slip here is not
  // cosmetic; save-invoice takes the party's state the same way and for the
  // same reason.
  const supplier = draft.party
    ? await Customer.findOne(
        { name: draft.party },
        { name: 1, state: 1, stateCode: 1, gstIn: 1 },
        opts
      )
        .collation({ locale: "en", strength: 2 })
        .lean()
    : null;

  // The GSTIN on the supplier's master when the form sent none -- it was
  // entered once in Setup, and refusing the expense as "GSTIN missing" while
  // it sits on file is the bug this closes. A GSTIN typed on the form wins:
  // it is the one on the bill in hand.
  if (!draft.supplierGstin && supplier?.gstIn) {
    draft = normalizeExpense({ ...draft, supplierGstin: supplier.gstIn });
  }

  let place = placeOfSupply(supplier || {});
  if (supplier && needsStateLookup(supplier)) {
    // Only for a party recorded before the state dropdown existed, who has
    // the name and no code, or the reverse. Normally skipped.
    const states = await State.find({}, { name: 1, code: 1 }, opts).lean();
    place = placeOfSupply(supplier, states);
  }

  const ourFirm = companyId
    ? await Company.findById(companyId, { stateCode: 1 }, opts).lean()
    : null;

  /*
    CGST+SGST or IGST, decided by the two state codes.

    What the form sent is used ONLY when `expenseTaxType` returns null, which
    it does when either code is unknown -- a firm whose profile predates the
    state fields, or a supplier with no state on their master. That is a
    stated choice, not a default: with neither a derivation nor a statement,
    `expenseProblems` refuses the voucher rather than picking one. A
    `|| "local"` here would be a tax decision made by a default, which
    lib/gst.mjs names as the thing not to do.
  */
  const stated = String(expense?.taxType ?? "").trim().toLowerCase();
  const taxType =
    expenseTaxType(ourFirm?.stateCode, place.stateCode) ??
    (stated === "local" || stated === "central" ? stated : null);

  const problems = expenseProblems(draft, { taxType });
  if (problems.length) {
    return { lines: [], expense: { ...draft, taxType: taxType || "" }, problems };
  }

  // === The three Input heads ===
  //
  // Created on demand, exactly as an invoice's are: a firm that has never had
  // a taxed expense needs no Input IGST head, and making this path depend on
  // a migration having been run is how you get an install that cannot post.
  // Only the heads this expense will actually touch, so a local expense does
  // not quietly create an Input IGST that never carries anything.
  const tax = expenseTax({ ...draft, taxType });
  const wanted = [
    tax.cgst ? TAX_ACCOUNTS.inputCgst : null,
    tax.sgst ? TAX_ACCOUNTS.inputSgst : null,
    tax.igst ? TAX_ACCOUNTS.inputIgst : null,
  ].filter(Boolean);

  const resolved = await resolveGlAccounts(wanted, session);

  // The STORED name, which may differ from the requested one in case or
  // padding. The ledger joins on the name, so a head stored as "Input Cgst"
  // must be posted to under that spelling rather than split into two.
  const accounts = {
    inputCgst: resolved.get(TAX_ACCOUNTS.inputCgst) || TAX_ACCOUNTS.inputCgst,
    inputSgst: resolved.get(TAX_ACCOUNTS.inputSgst) || TAX_ACCOUNTS.inputSgst,
    inputIgst: resolved.get(TAX_ACCOUNTS.inputIgst) || TAX_ACCOUNTS.inputIgst,
  };

  return {
    lines: expenseLegs(draft, { taxType, accounts }),
    // Frozen: what was claimed, as it was claimed. models/voucherModel.js
    // says why none of it is recomputed when the voucher is read back.
    expense: {
      ...draft,
      taxType,
      cgst: tax.cgst,
      sgst: tax.sgst,
      igst: tax.igst,
      total: round2(draft.taxable + tax.total),
    },
    problems: [],
  };
}

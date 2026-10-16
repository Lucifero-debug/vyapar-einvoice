/**
 * The Journal's Type field — Sigfa's `Journal` screen.
 *
 * Pure apart from the two modules whose rules this reuses rather than copies
 * (lib/gst.mjs, lib/balance.mjs), so `node scripts/journal-types.test.mjs`
 * runs it directly.
 *
 *
 * WHAT THE SCREENSHOT SHOWS, AND WHAT IT DOES NOT
 * -----------------------------------------------
 * A screenshot of SIGFA 10.5-G16's Journal screen, which cannot be read out
 * of SIGFA105.exe from here. On it:
 *
 *   - a `Type` field at the top of the voucher, beneath `Date`, holding the
 *     value `Expense With GST`
 *   - a grid headed `Account Name | Debit | Credit | Type | Number`
 *   - under the grid, in Sigfa's own words: `Only One Entry Per Vouche[r]`
 *   - the keys `Next [Alt + N]  Save [Alt + S]  Exit [ESC]`
 *
 * `Expense With GST` below is QUOTED from that screen, and so is the
 * one-entry-per-voucher rule. Everything else here is this app's own
 * decision, marked where it matters — the same discipline
 * lib/voucherKinds.mjs states for the four voucher kinds, and for the same
 * reason: so nobody later mistakes a design choice for a finding.
 *
 * In particular, the grid's own `Type` and `Number` columns are EMPTY in the
 * screenshot. They are not guessed at here. What this app needs from an
 * expense — the supplier's bill number and date — is carried as named fields
 * on the voucher instead, because the GST return needs them by name.
 *
 *
 * WHY A TYPE AT ALL
 * -----------------
 * A journal is "Dr any account, Cr any account" and that is its whole value:
 * depreciation, a bad debt, a provision. An expense bearing GST is the one
 * case where the lines are NOT free — the tax has to split by place of
 * supply, land on the three Input heads by name, and be claimable as credit.
 * Typing those legs by hand works exactly until somebody puts the tax on the
 * wrong head or splits a 18% inter-state expense into CGST and SGST, and a
 * trial balance that still foots gives no sign of either.
 *
 * So the Type narrows the entry: pick `Expense With GST` and the voucher asks
 * for one expense, and the legs are derived.
 *
 *
 * ONE ENTRY PER VOUCHER
 * ---------------------
 * Sigfa's own line, and it is kept. One expense, one supplier, one rate, one
 * bill — which is also what the GST return needs, because an input credit is
 * claimed against a supplier's document and two expenses sharing a voucher
 * would have nothing to be claimed against separately.
 */

import { round2 } from "./balance.mjs";
import { splitGst, taxTypeFor } from "./gst.mjs";

const text = (value, max = 0) => {
  if (value === null || value === undefined) return "";
  const out = String(value).replace(/\s+/g, " ").trim();
  return max > 0 ? out.slice(0, max) : out;
};

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/* ───────────────────────────── the Type field ───────────────────────────── */

/**
 * What a journal can be.
 *
 * `GENERAL` is the journal this app already had and is still the default: an
 * entry with no type behind it reads as one, so nothing saved before this
 * field existed changes meaning. Its label is this app's.
 *
 * `EXPENSE_GST` is quoted from Sigfa's screen.
 */
export const JOURNAL_TYPES = {
  GENERAL: {
    code: "GENERAL",
    label: "Journal",
    oneEntry: false,
  },
  EXPENSE_GST: {
    code: "EXPENSE_GST",
    // Sigfa's own wording, from the Type box.
    label: "Expense With GST",
    // Sigfa's own rule, printed under the grid.
    oneEntry: true,
  },
};

export const JOURNAL_TYPE_CODES = Object.keys(JOURNAL_TYPES);

/**
 * Which type a voucher is.
 *
 * An absent type reads as GENERAL rather than being stamped with one — the
 * same reading lib/voucherKinds.mjs does for an absent `kind` and
 * lib/stockVoucher.mjs for an absent MKEY. A default on the field would turn
 * that reading into a stored fact the next time an old voucher was saved.
 */
export const journalTypeOf = (value) =>
  JOURNAL_TYPES[text(value).toUpperCase()] || JOURNAL_TYPES.GENERAL;

export const isExpenseJournal = (value) =>
  journalTypeOf(value).code === "EXPENSE_GST";

/* ──────────────────────────── one expense entry ──────────────────────────── */

/** Every field of an expense, and nothing else. */
export const EXPENSE_DEFAULTS = {
  // Who it is owed to, and what it is for.
  party: "",
  expenseAccount: "",
  // The money, before tax.
  taxable: 0,
  gstRate: 0,
  // What the credit is claimed against. A supplier's document, which is what
  // makes the credit claimable at all.
  supplierGstin: "",
  billNo: "",
  billDate: "",
  // The service's code. An expense is a service far more often than not, so
  // this is an SAC; the field takes an HSN just as well and the return prints
  // whichever was entered.
  sac: "",
  narration: "",
};

export const EXPENSE_FIELDS = Object.keys(EXPENSE_DEFAULTS);

/** The whole expense from whatever the form or the route sent. */
export const normalizeExpense = (input = {}) => ({
  party: text(input.party),
  expenseAccount: text(input.expenseAccount),
  taxable: round2(num(input.taxable)),
  gstRate: num(input.gstRate),
  supplierGstin: text(input.supplierGstin).toUpperCase(),
  billNo: text(input.billNo, 32),
  // Kept as the "YYYY-MM-DD" the date box holds, not a Date: this is written
  // to the voucher and read back by the return, and a Date here would be
  // parsed as UTC midnight and slip a day west of Greenwich.
  billDate: text(input.billDate).slice(0, 10),
  sac: text(input.sac, 8),
  narration: text(input.narration, 200),
});

/**
 * The tax on an expense, split the way the place of supply says.
 *
 * `taxType` comes from `taxTypeFor` and is "local", "central", or null when
 * nobody has said. NULL IS NOT A SPLIT: it returns zeros and `expenseProblems`
 * refuses the entry. Defaulting to local here would be a tax decision made by
 * a default, which lib/gst.mjs names as the thing not to do.
 *
 * The halves come from `splitGst`, so a rate landing on an odd paisa
 * reconciles to the tax exactly — the same arithmetic every invoice uses.
 */
export const expenseTax = ({ taxable, gstRate, taxType }) => {
  const base = round2(num(taxable));
  const rate = num(gstRate);
  const total = round2((base * rate) / 100);

  if (taxType === "central") {
    return { cgst: 0, sgst: 0, igst: total, total };
  }
  if (taxType === "local") {
    const { cgst, sgst } = splitGst(total);
    return { cgst, sgst, igst: 0, total };
  }
  return { cgst: 0, sgst: 0, igst: 0, total: 0 };
};

/** What the supplier is owed: the expense plus its tax. */
export const expenseTotal = ({ taxable, gstRate, taxType }) =>
  round2(round2(num(taxable)) + expenseTax({ taxable, gstRate, taxType }).total);

/**
 * What is wrong with this expense, in the order a person would meet it.
 *
 * `taxType` is passed in rather than worked out here, because deciding it
 * needs two state codes this module has no business fetching. The caller gets
 * it from `taxTypeFor(firmStateCode, supplierStateCode)` and passes whatever
 * that said — including null, which is refused below by name.
 */
export const expenseProblems = (expense = {}, { taxType } = {}) => {
  const draft = normalizeExpense(expense);
  const problems = [];

  if (!draft.party) problems.push("Choose the supplier this expense is owed to.");
  if (!draft.expenseAccount) problems.push("Choose the expense account to debit.");

  if (!(draft.taxable > 0)) {
    problems.push("Enter the expense amount, before tax.");
  }

  if (draft.gstRate < 0 || draft.gstRate > 100) {
    problems.push("The GST rate has to be between 0 and 100.");
  }

  // Only once there is tax to place. A nil-rated expense needs no split and
  // no place of supply, so asking for one would refuse a valid entry.
  if (draft.gstRate > 0 && taxType !== "local" && taxType !== "central") {
    problems.push(
      "The place of supply is not known, so CGST/SGST or IGST cannot be decided. " +
        "Set the state on this party and on your own firm."
    );
  }

  // What makes the credit claimable. Without the supplier's document there is
  // nothing for the return to claim it against, so this is refused rather
  // than filed as an unsupported claim.
  if (draft.gstRate > 0 && !draft.supplierGstin) {
    problems.push("The supplier's GSTIN is needed to claim the input credit.");
  }

  // The supplier's bill number and date are required on EVERY expense, a
  // nil-rated one included: the firm's rule, so each expense can be traced
  // to the paper it was booked from. (They used to be asked for only when
  // there was a credit to claim.)
  if (!draft.billNo) {
    problems.push("Enter the supplier's bill number.");
  }
  if (!draft.billDate) {
    problems.push("Enter the supplier's bill date.");
  }

  return problems;
};

/* ────────────────────────────── the three legs ────────────────────────────── */

/**
 * The ledger lines one expense expands into.
 *
 *   Dr  the expense head          the amount before tax
 *   Dr  Input CGST + Input SGST   or Input IGST, by place of supply
 *   Cr  the supplier              the total
 *
 * Returned in the shape the voucher already stores its lines in — name,
 * debit, credit, narration — so nothing downstream has to learn a new one:
 * `buildVoucherLedgerRows` writes them, the trial balance sums them, and a
 * deletion reverses them, all unchanged.
 *
 * `accounts` names the three input heads, passed in rather than imported, so
 * this module stays runnable under bare node while the names stay owned by
 * lib/invoiceGl.mjs — one place where "Input CGST" is spelled.
 *
 * A LEG WORTH NOTHING IS NOT WRITTEN. A nil-rated expense produces two lines,
 * not four with two zeros, because a zero row in a party's ledger is a row
 * somebody has to read and discount.
 */
export const expenseLegs = (expense = {}, { taxType, accounts = {} } = {}) => {
  const draft = normalizeExpense(expense);
  const tax = expenseTax({ ...draft, taxType });
  const total = round2(draft.taxable + tax.total);

  const legs = [
    {
      name: draft.expenseAccount,
      debit: draft.taxable,
      credit: 0,
      narration: draft.narration,
    },
  ];

  if (tax.cgst) {
    legs.push({ name: accounts.inputCgst, debit: tax.cgst, credit: 0, narration: "" });
  }
  if (tax.sgst) {
    legs.push({ name: accounts.inputSgst, debit: tax.sgst, credit: 0, narration: "" });
  }
  if (tax.igst) {
    legs.push({ name: accounts.inputIgst, debit: tax.igst, credit: 0, narration: "" });
  }

  legs.push({
    name: draft.party,
    debit: 0,
    credit: total,
    narration: draft.narration,
  });

  return legs;
};

/**
 * Does this set of legs balance?
 *
 * A journal has no account absorbing the opposite of its lines, so its own
 * lines are the only thing that can balance it — lib/voucherKinds.mjs makes
 * that a rule. `expenseLegs` balances by construction; this exists so the
 * test can say so, and so a route can check what it is about to write rather
 * than trusting the function that built it.
 */
export const legsBalance = (legs = []) => {
  const debit = round2(legs.reduce((sum, leg) => round2(sum + num(leg?.debit)), 0));
  const credit = round2(legs.reduce((sum, leg) => round2(sum + num(leg?.credit)), 0));
  return debit === credit;
};

/**
 * The place of supply for an expense, from the two state codes.
 *
 * A thin pass-through to `taxTypeFor`, here only so that every caller of this
 * module reaches the rule through one door and nobody is tempted to write
 * `|| "local"` on the way.
 */
export const expenseTaxType = (firmStateCode, supplierStateCode) =>
  taxTypeFor(firmStateCode, supplierStateCode);

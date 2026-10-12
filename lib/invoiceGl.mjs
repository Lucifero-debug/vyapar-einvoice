/**
 * The legs of an invoice that were never posted.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run the
 * fixture tests directly. Never import Mongoose in here.
 *
 *
 * WHAT WAS MISSING
 * ----------------
 * An invoice posted the party's side and, when something was settled at the
 * counter, both sides of the receipt. It named "Sales Account" in the contra
 * column of the party's row -- as TEXT -- and wrote no row owned by that
 * account, and nothing at all for GST. So the ledger was a party-and-cash
 * subledger, not a general ledger: a trial balance drawn from it was short by
 * exactly sales plus tax, and short SILENTLY, because every report that
 * existed read one account at a time.
 *
 * This module supplies the other side. With it, one invoice balances:
 *
 *   Sale of 11,800 (10,000 taxable + 1,800 GST, intra-state)
 *     Party                Dr 11,800
 *     Sales Account                   Cr 10,000
 *     Output CGST                     Cr    900
 *     Output SGST                     Cr    900
 *
 *
 * THE FIGURES COME FROM THE LINES
 * -------------------------------
 * Not from `totalAmount` or `gst` on the invoice. Those arrive from the client
 * -- `save-invoice` spreads the request body -- and the AI upload path passes
 * an extractor's numbers straight through. The LINES are the authority, which
 * is the same conclusion lib/hsnTotals.mjs reached after the stored HSN
 * summary was found to be unreliable, and `buildHsnSummary` is reused here
 * rather than a second summing written beside it.
 *
 * `finalAmount` is the exception, and deliberately: the party is already moved
 * by it, that posting works, and changing it would shift balances on every
 * invoice in the book. So the party's side stays exactly as it was, and this
 * module makes the OTHER side add up to it.
 *
 *
 * WHICH IS WHY THERE IS A ROUND-OFF HEAD
 * --------------------------------------
 * `finalAmount` minus taxable minus tax is rarely zero: freight, a bill-level
 * discount, a rounded total, or an uploaded bill whose extracted figures do
 * not quite reconcile. That difference has to land somewhere or the entry does
 * not balance, and an entry that does not balance makes the whole trial
 * balance worthless rather than one invoice wrong.
 *
 * It goes to "Round Off", under Indirect Expenses. NOT into Sales: a Sales
 * figure quietly inflated by freight stops agreeing with the GST returns,
 * which is the one number a client will check against something external.
 * Anything larger than `ROUNDING_TOLERANCE` is still posted -- the books
 * balance either way -- but `isMaterialDifference` flags it so the backfill
 * and the report can name the invoice instead of burying it.
 */

import { round2 } from "./balance.mjs";
import { buildHsnSummary, hsnGrandTotal } from "./hsnTotals.mjs";
import { resolveGroup } from "./accountGroups.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** The standard heads, by the names their ledger rows are joined on. */
export const SALES_ACCOUNT = "Sales Account";
export const PURCHASE_ACCOUNT = "Purchase Account";
export const ROUND_OFF_ACCOUNT = "Round Off";

/**
 * The GST heads. Output on a sale, input on a purchase -- they are different
 * accounts because they are different things: output tax is money owed to the
 * government, input tax is credit claimable from it, and a balance sheet that
 * netted them would hide both.
 */
export const TAX_ACCOUNTS = {
  outputCgst: "Output CGST",
  outputSgst: "Output SGST",
  outputIgst: "Output IGST",
  inputCgst: "Input CGST",
  inputSgst: "Input SGST",
  inputIgst: "Input IGST",
};

/**
 * Which group each head belongs to in the chart of accounts
 * (lib/accountGroups.mjs). Used by the resolver that creates them.
 */
export const GL_ACCOUNT_GROUPS = {
  [SALES_ACCOUNT]: "Sales Account",
  [PURCHASE_ACCOUNT]: "Purchase Account",
  [ROUND_OFF_ACCOUNT]: "Indirect Expenses",
  [TAX_ACCOUNTS.outputCgst]: "Duties And Taxes",
  [TAX_ACCOUNTS.outputSgst]: "Duties And Taxes",
  [TAX_ACCOUNTS.outputIgst]: "Duties And Taxes",
  [TAX_ACCOUNTS.inputCgst]: "Duties And Taxes",
  [TAX_ACCOUNTS.inputSgst]: "Duties And Taxes",
  [TAX_ACCOUNTS.inputIgst]: "Duties And Taxes",
};

/** Every head this module can post to. */
export const GL_ACCOUNTS = Object.keys(GL_ACCOUNT_GROUPS);

const foldName = (name) => String(name ?? "").trim().toLowerCase();

/** The head a name IS, compared as the posting path compares it (case-insensitively), or null. */
export const glHeadOf = (name) => GL_ACCOUNTS.find((head) => foldName(head) === foldName(name)) || null;

/**
 * Does this group hold customers and suppliers rather than ledger heads?
 *
 * Sundry Debtors / Creditors, their legacy spellings ("customer",
 * "supplier" -- lib/accountGroups.mjs resolves them), any firm-defined
 * customer group ("Retail" -- not a chart-of-accounts group at all), or no
 * group. A head the posting path creates always carries its chart group
 * (GL_ACCOUNT_GROUPS), so it is never mistaken for a party.
 */
const PARTY_GROUP_CODES = new Set([27, 28]);
const isPartyGroup = (group) => {
  const resolved = resolveGroup(group);
  return !resolved || PARTY_GROUP_CODES.has(resolved.code);
};

/**
 * Why this account name may not be used, or null.
 *
 * Invoices find their heads BY NAME, case-insensitively (lib/glAccounts.mjs).
 * So a party created as "Output IGST" before a firm's first inter-State bill
 * would itself receive the IGST of every bill after it; and renaming the
 * "Sales Account" head makes the next invoice create a fresh one and split
 * the firm's sales across two. Both are refused at the master.
 *
 *   name          the name being saved
 *   group         the group it is being saved under
 *   previousName  for an edit, the name it had
 *   previousGroup for an edit, the group it had -- a PARTY that wrongly holds
 *                 a head's name (made before this check) may be renamed out
 *                 of it; only a real head is held to its name
 */
export function headNameProblem({ name, group, previousName = null, previousGroup = null } = {}) {
  const was = previousName ? glHeadOf(previousName) : null;
  const wasParty = isPartyGroup(previousGroup);
  if (was && !wasParty && foldName(name) !== foldName(previousName)) {
    return `"${previousName}" is a ledger head that invoices post to. Renaming it would make the next invoice start a new "${was}" and split the account in two.`;
  }
  const head = glHeadOf(name);
  if (head && isPartyGroup(group)) {
    return `"${name}" is the name of a ledger head (${GL_ACCOUNT_GROUPS[head]}). A customer or supplier cannot use it: invoices would post to this party. Choose another name.`;
  }
  return null;
}

/**
 * How far `finalAmount` may stand from taxable + tax before it stops looking
 * like rounding and starts looking like a mistake.
 *
 * One rupee. A rounded bill total moves by paise; freight or a bill-level
 * discount moves it by rupees, and that is worth a human looking at.
 */
export const ROUNDING_TOLERANCE = 1;

/**
 * Which direction this document posts in.
 *
 *   Sale            party Dr, income Cr        -> +1
 *   Sale return     the reverse                -> -1
 *   Purchase        party Cr, expense Dr       -> -1
 *   Purchase return the reverse                -> +1
 *
 * The same four cases as `invoiceDelta` in lib/balance.mjs, and deliberately
 * derived the same way rather than read off the party's delta: an invoice of
 * zero value has a delta of zero and still has a direction.
 */
export const postingDirection = ({ type, isReturn = false }) =>
  (text(type) === "Purchase" ? -1 : 1) * (isReturn ? -1 : 1);

/** A signed movement, as the debit/credit pair a ledger row stores. */
export const sides = (delta) => ({
  debit: delta > 0 ? round2(Math.abs(delta)) : 0,
  credit: delta < 0 ? round2(Math.abs(delta)) : 0,
});

/**
 * Is this an inter-state supply, and therefore IGST rather than CGST + SGST?
 *
 * Read from `taxType`, which the billing forms set from the place of supply
 * (lib/buyerSnapshot.mjs decides that, from the party's own state). Anything
 * that is not recognisably central is treated as local, which is the common
 * case and the safer default: splitting a tax that should have been IGST puts
 * the same total in two heads of the same group, while treating a local
 * supply as IGST would misstate a return.
 */
export const isInterState = (invoice) => /central|inter/i.test(text(invoice?.taxType));

/**
 * The taxable value and the tax, summed from the lines.
 *
 * Via `buildHsnSummary`, which is what the printed bill and the HSN backfill
 * already use -- so the three cannot disagree about what an invoice's taxable
 * value is.
 */
export const lineTotals = (invoice) => {
  const grand = hsnGrandTotal(buildHsnSummary(invoice?.items || []));
  return { taxable: grand.taxable, tax: grand.gstAmount };
};

/**
 * Every account movement one invoice makes, the party included.
 *
 * Signed deltas, positive Dr. They sum to zero by construction: that is the
 * property the whole trial balance rests on, and the one the tests check
 * hardest, for every combination of type, return and tax.
 *
 * `finalAmount` is the party's side, taken as given. Everything else is the
 * contra, and the round-off absorbs whatever is left so the two agree.
 */
export const glDeltas = (invoice) => {
  const dir = postingDirection({ type: invoice?.type, isReturn: Boolean(invoice?.return) });
  const final = round2(
    invoice?.finalAmount ?? num(invoice?.balanceDue) + num(invoice?.received)
  );
  const { taxable, tax } = lineTotals(invoice);
  const difference = round2(final - taxable - tax);

  const income = text(invoice?.type) === "Purchase" ? PURCHASE_ACCOUNT : SALES_ACCOUNT;
  const inter = isInterState(invoice);
  const output = text(invoice?.type) !== "Purchase";

  const moves = [];
  const add = (account, delta) => {
    const d = round2(delta);
    if (!account || d === 0) return;
    moves.push({ account, delta: d });
  };

  // The party, exactly as it is posted today. Not recomputed here -- see the
  // note above about why `finalAmount` is the one figure taken as given.
  add(text(invoice?.customer?.name), round2(dir * final));

  // The contra side, each component carrying the opposite sign.
  add(income, round2(-dir * taxable));

  if (inter) {
    add(output ? TAX_ACCOUNTS.outputIgst : TAX_ACCOUNTS.inputIgst, round2(-dir * tax));
  } else {
    // Half each. Halved from the TOTAL rather than summed from per-line halves,
    // so a tax of 900.01 cannot produce two 450.005 legs that round to 450.01
    // apiece and overstate the tax by a paisa. The second half is the
    // remainder, so the two always add back to the total exactly.
    const half = round2(round2(-dir * tax) / 2);
    const rest = round2(round2(-dir * tax) - half);
    add(output ? TAX_ACCOUNTS.outputCgst : TAX_ACCOUNTS.inputCgst, half);
    add(output ? TAX_ACCOUNTS.outputSgst : TAX_ACCOUNTS.inputSgst, rest);
  }

  add(ROUND_OFF_ACCOUNT, round2(-dir * difference));

  return {
    moves,
    taxable,
    tax,
    finalAmount: final,
    difference,
    interState: inter,
    direction: dir,
  };
};

/** Does the difference look like a mistake rather than rounding? */
export const isMaterialDifference = (difference) =>
  Math.abs(num(difference)) > ROUNDING_TOLERANCE;

/**
 * The ledger rows for the contra side -- everything except the party and the
 * receipt, which `buildInvoiceLedgerRows` already writes.
 *
 * `customerName` is the account the row BELONGS to and `account` is its
 * contra, which is the convention the whole ledger follows: a Sales Account
 * row names the party it came from, so the Sales ledger reads as a list of
 * customers.
 */
export const glRows = ({ invoice, invoiceNo, date, voucherId, paymentType }) => {
  const { moves } = glDeltas(invoice);
  const partyName = text(invoice?.customer?.name);
  const kind = text(invoice?.type) === "Purchase" ? "Purchase" : "Invoice";
  const narration = `By ${kind} No: ${invoiceNo ?? invoice?.invoiceNo ?? ""}`;

  return moves
    // The party's own row is written by buildInvoiceLedgerRows, with the
    // running balance it already computes. Writing it here too would double
    // the party's movement -- which is why this returns only the contra.
    .filter((m) => m.account !== partyName)
    .map((m) => ({
      customerName: m.account,
      date,
      account: partyName,
      paymentType: text(paymentType) || "Credit",
      ...sides(m.delta),
      // Left at zero on purpose. The running figure is recomputed end to end
      // by recomputeLedgerBalances, and every report derives it on read
      // anyway (lib/accountBooks.mjs). A guess here would be a stale guess.
      balance: 0,
      narration,
      voucherId,
    }));
};

/**
 * Do these rows balance?
 *
 * For the test, for the backfill's report, and for anything that wants to
 * check its own work. Returns the signed difference, which is zero when the
 * entry is sound.
 */
export const rowsImbalance = (rows = []) =>
  round2(
    rows.reduce((sum, row) => round2(sum + num(row?.debit) - num(row?.credit)), 0)
  );

/**
 * What raised a ledger row, in the two letters a Type column has space for.
 *
 * Pure, like the rest of lib/*.mjs, so `node scripts/ledger-types.test.mjs`
 * runs it directly.
 *
 *
 * WHY A ROW HAS TO ANSWER THIS BY ITSELF
 * --------------------------------------
 * Every reader of the ledger reads ROWS. The ledger report, the day book and
 * the cash book never open the invoice or the voucher behind a row -- there
 * is no join to make, and making one per row is the kind of thing that turns
 * a ledger into a page that takes four seconds to print.
 *
 * So the document's name travels ON the row. Vouchers have done that since
 * `voucherKind` was added (models/ledgerModel.js); invoices now do it through
 * `docType`, stamped by lib/invoicePosting.mjs.
 *
 *
 * THE THREE ANSWERS, IN ORDER
 * ---------------------------
 *   stored docType      an invoice, a return -- SERIES_DOC_TYPES
 *   stored voucherKind  a receipt, a payment, a journal, a contra
 *   read off the row    for rows written before either field existed
 *
 * The third is a READING, not a fact, and it says so: `inferred` is true and
 * a caller can mark it. The same decision as `kindOf` in lib/voucherKinds.mjs
 * -- the figures already answer the question, so answering it is better than
 * a blank column, and better than a migration that stamps a guess onto live
 * rows and turns the guess into stored data.
 *
 * It only ever reads a PARTY row, which is the one whose shape is
 * unambiguous: the contra account names the side, and which column the figure
 * sits in names the direction.
 *
 *     Sales Account     debit   a sale            credit  a sale return
 *     Purchase Account  credit  a purchase        debit   a purchase return
 *
 * That table is lib/billingTypes.mjs's posting table read backwards, and it
 * holds because `invoiceDelta` has only ever moved a party one way per
 * document. An old receipt leg or GL row is left blank rather than guessed
 * at: its account says nothing about which document wrote it.
 *
 *
 * WHAT CANNOT APPEAR HERE, AND WHY THAT IS RIGHT
 * ----------------------------------------------
 * 'SC' and 'PC' -- sale and purchase challan -- are real document types with
 * Sigfa's own MKEYs (lib/series.mjs), and they will never show in a ledger,
 * because a challan posts no ledger rows at all. A delivery note moves goods,
 * not money; the money moves when the challan is billed, and that row is the
 * invoice's. The codes are defined, nothing writes them here, and that is the
 * correct answer rather than a gap to fill.
 */

import { docTypeLabel, docTypeShort, isSeriesDocType } from "./series.mjs";
import { VOUCHER_KINDS } from "./voucherKinds.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Nothing recognised: a column prints an empty cell. */
const NOTHING = { short: "", label: "", inferred: false };

/*
  The two contra accounts an invoice's party row names.

  Written in lib/invoicePosting.mjs, as literals, and matched here as
  literals rather than imported: this module stays free of the posting chain
  (invoicePosting -> invoiceGl -> ...). If either name is ever changed there,
  the fallback below quietly stops recognising old rows -- which is why
  scripts/ledger-types.test.mjs reads that file and fails if the two spellings
  no longer match.
*/
export const SALES_CONTRA = "Sales Account";
export const PURCHASE_CONTRA = "Purchase Account";

/**
 * The document read off a party row that carries no stored type.
 *
 * Returns a SERIES_DOC_TYPES code, or "" when the row is not one of the four
 * shapes above.
 */
export const inferredDocType = (row) => {
  const account = text(row?.account);
  const debit = num(row?.debit);
  const credit = num(row?.credit);

  // One side only. A row with both columns filled, or neither, is not a
  // shape this can read, and picking the larger would be inventing an answer.
  if (debit > 0 === credit > 0) return "";

  if (account === SALES_CONTRA) return debit > 0 ? "SALE_INVOICE" : "SALE_RETURN";
  if (account === PURCHASE_CONTRA) return credit > 0 ? "PURCHASE_INVOICE" : "PURCHASE_RETURN";
  return "";
};

/**
 * What to print in a Type column for one ledger row.
 *
 *   short     'SI', 'PR', 'RC' -- or "" when nothing is known
 *   label     'Sales Invoice', 'Receipt' -- the full name, for a tooltip
 *   inferred  true when it was read off the figures rather than stored
 *
 * Never null, never throws: a report column cannot be the thing that takes
 * the page down over a row somebody wrote by hand in the database.
 */
export const ledgerRowType = (row) => {
  const stored = text(row?.docType);
  if (isSeriesDocType(stored)) {
    return { short: docTypeShort(stored), label: docTypeLabel(stored), inferred: false };
  }

  const kind = VOUCHER_KINDS[text(row?.voucherKind)];
  if (kind) return { short: kind.short, label: kind.label, inferred: false };

  const read = inferredDocType(row);
  if (read) return { short: docTypeShort(read), label: docTypeLabel(read), inferred: true };

  return NOTHING;
};

/**
 * Every code this column can print, for a legend or a filter.
 *
 * Four documents and six vouchers. 'CN' is the credit note, not the contra:
 * the contra is 'CT', which lib/voucherKinds.mjs explains.
 */
export const LEDGER_TYPE_CODES = [
  "SI",
  "PI",
  "SR",
  "PR",
  "RC",
  "PY",
  "JV",
  "CT",
  "CN",
  "DN",
];

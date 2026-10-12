/**
 * Writing an invoice's stock rows.
 *
 * Split out from `invoicePosting.mjs` so that module stays free of Mongoose and
 * can be exercised by the fixture tests under bare node.
 */

import ItemLedger from "../models/itemLedgerModel";
import { isInwardStock } from "./balance.mjs";
// The key and the directions both depend on WHICH stock voucher this is --
// Production, Goods Issued or Goods Received -- so both come from
// lib/stockVoucher.mjs. `stockMovements` returns exactly what
// `productionMovements` returned for a production entry; it is a
// generalisation of it, not a second implementation beside it.
import { stockLedgerKey, stockMovements } from "./stockVoucher.mjs";
import { recomputeItemBalances } from "./runningBalances.mjs";

/**
 * Replace an invoice's stock rows with ones matching its current items.
 *
 * Always deletes first, so this is the same call whether the invoice is new or
 * being edited -- an edit that changed quantities used to leave the original
 * ones in the stock ledger forever.
 *
 * `balanceQuantity` is a running figure derived from the most recent row. Both
 * the stock report and this recompute it on read, so it is a convenience
 * rather than the source of truth; a back-dated entry will not rewrite the
 * rows that already follow it.
 */
export async function writeItemLedgerRows({
  session,
  invoiceNo,
  date,
  type,
  isReturn = false,
  items = [],
  partyName,
}) {
  await ItemLedger.deleteMany({ invoiceNo }, { session });

  if (!Array.isArray(items) || items.length === 0) return 0;

  // Direction comes from the same { type, isReturn } the balance rule reads.
  const inward = isInwardStock({ type, isReturn });

  let written = 0;
  for (const item of items) {
    if (!item?.name) continue;

    const quantity = Number(item.quantity) || 0;
    const receiptQuantity = inward ? quantity : 0;
    const issueQuantity = inward ? 0 : quantity;

    const lastEntry = await ItemLedger.findOne({ itemName: item.name })
      .sort({ date: -1 })
      .session(session)
      .lean();
    const previous = lastEntry ? lastEntry.balanceQuantity : 0;

    await ItemLedger.create(
      [
        {
          date,
          invoiceNo,
          typeOfVoucher: type,
          partyName: partyName || "Bulk Upload",
          receiptQuantity,
          issueQuantity,
          balanceQuantity: previous + receiptQuantity - issueQuantity,
          itemName: item.name,
        },
      ],
      { session }
    );
    written += 1;
  }

  return written;
}

/**
 * Replace a production entry's stock rows.
 *
 * Separate from `writeItemLedgerRows` above because a production entry moves
 * stock in BOTH directions at once -- materials out, the finished item and any
 * by-products in -- while an invoice moves everything one way and derives that
 * one direction from { type, isReturn }. Trying to serve both from one
 * function would mean a direction argument per line, which is just this
 * function with extra steps.
 *
 * THE KEY IS PREFIXED, and that is the whole reason `productionLedgerKey`
 * exists. `invoiceNo` on a stock row is a string shared by every voucher type,
 * and the delete below is keyed on it. A production entry numbered 5 writing
 * its rows under "5" would wipe invoice 5's stock movements on save, and wipe
 * them again on delete. Invoice keys are digits; "PRD-5" cannot collide.
 *
 * Deletes first, so this is the same call whether the entry is new or being
 * re-saved -- the same shape as the invoice writer, and for the same reason:
 * an edit that changed quantities used to leave the original rows behind
 * forever.
 */
export async function writeProductionLedgerRows({
  session,
  // Which of the three stock vouchers this is. Absent means Production, so
  // every existing caller keeps working unchanged -- and so does every row
  // written before the other two kinds existed.
  kind,
  docNo,
  date,
  outputItem,
  outputQuantity,
  lines = [],
  partyName,
}) {
  // Each kind has its own prefix -- "PRD-", "GI-", "GR-" -- which is what
  // lets the three share a collection and still number independently.
  // Production keeps the prefix it already had, so its existing rows are
  // untouched.
  const key = stockLedgerKey(kind, docNo);

  // The items this entry moved BEFORE the edit, so an item dropped from it
  // still has its running figures rewritten below.
  const movedBefore = await ItemLedger.distinct("itemName", { invoiceNo: key }).session(session);

  await ItemLedger.deleteMany({ invoiceNo: key }, { session });

  const { issues, receipts } = stockMovements({
    kind,
    outputItem,
    outputQuantity,
    lines,
  });

  // Receipts before issues, so a formula that both consumes and produces the
  // same item reads in the order it happened.
  const rows = [
    ...receipts.map((r) => ({ ...r, receipt: true })),
    ...issues.map((r) => ({ ...r, receipt: false })),
  ];

  let written = 0;
  for (const row of rows) {
    const receiptQuantity = row.receipt ? row.quantity : 0;
    const issueQuantity = row.receipt ? 0 : row.quantity;

    // `balanceQuantity` is a derived convenience, recomputed on read by both
    // the stock report and lib/itemStock.mjs -- which sums the movements
    // rather than trusting this column, precisely because a back-dated entry
    // leaves every row after it stale. Written here to match the invoice
    // rows, not relied on.
    const lastEntry = await ItemLedger.findOne({ itemName: row.itemName })
      .sort({ date: -1 })
      .session(session)
      .lean();
    const previous = lastEntry ? lastEntry.balanceQuantity : 0;

    await ItemLedger.create(
      [
        {
          date,
          invoiceNo: key,
          typeOfVoucher: "Production",
          // Sigfa's "Y  Ask Party In Production." is optional there too, and
          // the column is required here -- so a plain label rather than a
          // blank that would fail validation.
          partyName: partyName || "Production",
          receiptQuantity,
          issueQuantity,
          balanceQuantity: previous + receiptQuantity - issueQuantity,
          itemName: row.itemName,
        },
      ],
      { session }
    );
    written += 1;
  }

  // The running figures kept on the rows, rewritten in date order for every item this
  // entry touched before or after the edit. The invoice routes always did
  // this; the stock vouchers did not, so a back-dated production entry left
  // every later `balanceQuantity` wrong. Same session, same transaction.
  await recomputeItemBalances([...movedBefore, ...rows.map((r) => r.itemName)], session);

  return written;
}

/** Remove a production entry's stock rows. Used when the entry is deleted. */
export async function deleteProductionLedgerRows({ session, kind, docNo }) {
  const key = stockLedgerKey(kind, docNo);
  const touched = await ItemLedger.distinct("itemName", { invoiceNo: key }).session(session);
  const { deletedCount } = await ItemLedger.deleteMany({ invoiceNo: key }, { session });
  // The rows after the deleted ones carried running figures that counted it.
  await recomputeItemBalances(touched, session);
  return deletedCount || 0;
}

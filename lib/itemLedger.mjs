/**
 * Writing an invoice's stock rows.
 *
 * Split out from `invoicePosting.mjs` so that module stays free of Mongoose and
 * can be exercised by the fixture tests under bare node.
 */

import ItemLedger from "../models/itemLedgerModel";
import { isInwardStock } from "./balance.mjs";

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

/**
 * Recompute the running figures stored on ledger rows.
 *
 * `Ledger.balance` and `ItemLedger.balanceQuantity` used to be written as
 * "whatever the most recently dated row said, plus this movement". That is
 * wrong in two ways: same-day rows have no defined order, so the predecessor
 * was arbitrary; and a back-dated entry never rewrote the rows that already
 * followed it, so everything after it stayed stale for good.
 *
 * Rather than patch one row at a time, the affected account or item is
 * recomputed end to end, in a defined order (date, then insertion order via
 * `_id`), from its opening position. Both reports already recompute on read,
 * so this is what makes the stored figure agree with what people actually see.
 *
 * Cost is proportional to one party's or one item's history, not the whole
 * table. That is comfortable at the scale this runs at; if a single account
 * ever accumulates tens of thousands of rows, this is the thing to revisit.
 */

import Customer from "../models/custModel";
import Item from "../models/itemModel";
import ItemLedger from "../models/itemLedgerModel";
import Ledger from "../models/ledgerModel";
import { round2 } from "./balance.mjs";

const unique = (values) =>
  [...new Set(values.filter((v) => v !== undefined && v !== null && v !== ""))];

/** Rewrite `balance` for every row belonging to these accounts. */
export async function recomputeLedgerBalances(names, session) {
  const targets = unique(names);
  if (targets.length === 0) return;

  for (const name of targets) {
    const [account, rows] = await Promise.all([
      Customer.findOne({ name }, { openingBal: 1 }, { session }).lean(),
      Ledger.find({ customerName: name }, { debit: 1, credit: 1 }, { session })
        .sort({ date: 1, _id: 1 })
        .lean(),
    ]);

    if (rows.length === 0) continue;

    let running = Number(account?.openingBal) || 0;
    const writes = rows.map((row) => {
      running = round2(running + (row.debit || 0) - (row.credit || 0));
      return {
        updateOne: { filter: { _id: row._id }, update: { $set: { balance: running } } },
      };
    });

    await Ledger.bulkWrite(writes, { session });
  }
}

/** Rewrite `balanceQuantity` for every row belonging to these items. */
export async function recomputeItemBalances(itemNames, session) {
  const targets = unique(itemNames);
  if (targets.length === 0) return;

  for (const itemName of targets) {
    const [master, rows] = await Promise.all([
      Item.findOne({ name: itemName }, { openingQuantity: 1 }, { session }).lean(),
      ItemLedger.find(
        { itemName },
        { receiptQuantity: 1, issueQuantity: 1 },
        { session }
      )
        .sort({ date: 1, _id: 1 })
        .lean(),
    ]);

    if (rows.length === 0) continue;

    // Starts from the item's opening stock, so the stored figure matches what
    // the stock report shows rather than counting from zero.
    let running = Number(master?.openingQuantity) || 0;
    const writes = rows.map((row) => {
      running += (row.receiptQuantity || 0) - (row.issueQuantity || 0);
      return {
        updateOne: {
          filter: { _id: row._id },
          update: { $set: { balanceQuantity: running } },
        },
      };
    });

    await ItemLedger.bulkWrite(writes, { session });
  }
}

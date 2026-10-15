/**
 * What "clear the transactions" means, in one place.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run the
 * fixture test directly. Never import Mongoose in here.
 *
 * THE DISTINCTION THAT MATTERS
 * ----------------------------
 * There are two different wipes and they are easy to confuse:
 *
 *   clear everything     - the books AND the masters. Starting from nothing.
 *   clear transactions   - the books only. Customers, items, HSN codes, price
 *                          lists, groups and states all stay. This is what you
 *                          want between a trial run and going live.
 *
 * The second one cannot simply delete and stop. `Customer.lastBal` is a
 * running figure accumulated from the very documents being deleted, so leaving
 * it alone produces a book where parties owe money for invoices that no longer
 * exist -- a ledger showing no rows beside a master saying Rs 50,000 Dr.
 * Every party is reset to its opening balance in the same transaction.
 *
 * Stock needs no equivalent step: it is summed from the stock ledger rows on
 * every read (see lib/itemStock.mjs), so emptying that collection returns every
 * item to its opening quantity by itself. `Item.lastQuantity` is typed in by
 * hand and is not derived from anything, so it is master data and stays.
 */

import { modeOf, round2 } from "./balance.mjs";

/**
 * The phrase the caller has to type. Deliberately NOT the same as the one for
 * the full wipe -- muscle memory from typing one must not fire the other.
 */
export const CLEAR_TRANSACTIONS_PHRASE = "CLEAR TRANSACTIONS";

/** Collections a transaction clear empties, by collection name. */
export const TRANSACTION_COLLECTIONS = [
  "invoices",
  // Orders are books, not masters. They post nothing to the ledger and move
  // no stock, so there is no balance to reset alongside them -- but a trial
  // run's orders surviving into the live book would leave every one of them
  // pending forever, since the invoices that settled them are gone.
  "orders",
  "vouchers",
  "ledgers",
  "itemledgers",
  // Production entries ARE books: unlike a formula, each one moved stock, and
  // its rows are in `itemledgers` above. Clearing the stock ledger without
  // clearing these would leave vouchers claiming movements that no longer
  // exist, and the whole point of this wipe is a book that agrees with itself.
  "productions",
  // Challans move stock (rows in `itemledgers`) and are billed by invoices
  // above; left behind they would sit "pending" against bills that are gone.
  "challans",
  // Low-stock alerts are derived from the stock ledger above. Left behind,
  // a cleared book would open with alerts about stock it no longer records
  // (they would resolve on the next dashboard load, but should not survive
  // the wipe at all).
  "stockalerts",
  // Without this the invoice counter survives and numbering carries on from
  // wherever the deleted invoices left off.
  "counters",
];

/**
 * Collections it must leave standing. Listed rather than implied, so the test
 * can assert the two sets never overlap: adding "customers" to the list above
 * would silently turn this into the full wipe.
 */
export const MASTER_COLLECTIONS = [
  "customers",
  "items",
  // A bill of material is a recipe, not a transaction -- Sigfa files it under
  // Masters too. It survives a transaction clear for the same reason the item
  // master does: it is what you typed in before going live, and typing two
  // hundred formulas again is not a migration step anybody would forgive.
  "boms",
  "hsns",
  "pricelists",
  "customergroups",
  // The ITEM groups, a separate master from the party groups above. Typed in
  // before going live like everything else here, and the items they file are
  // kept above, so the shelves survive a transaction clear with the goods.
  "itemgroups",
  "states",
  // The document series -- Sigfa's SubKey. Typed in before going live like
  // every other master here, and the slips that carry a series are cleared
  // above, so the labels survive the wipe and can be used again.
  "series",
];

/**
 * What a party's running balance should be once its transactions are gone:
 * its opening balance, and a mode matching that sign.
 *
 * Mirrors `setBalance()` in balance.mjs -- the mode is never an independent
 * value, always the sign of the figure beside it.
 */
export const openingReset = (customer) => {
  const opening = round2(Number(customer?.openingBal) || 0);
  return { lastBal: opening, lastMode: modeOf(opening) };
};

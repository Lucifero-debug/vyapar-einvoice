/**
 * What is actually on the shelf, for one item.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run the
 * fixture test directly. Never import Mongoose in here.
 *
 * WHERE THE FIGURE COMES FROM
 * ---------------------------
 * NOT from `Item.lastQuantity`. That field looks like the stock counterpart of
 * `Customer.lastBal`, but it is not: nothing in the posting path ever writes
 * it. It is typed into the item master by hand and is stale the moment anything
 * is bought or sold. Showing it as "current stock" would be a confident lie.
 *
 * The real figure is the one the stock report computes:
 *
 *     openingQuantity  +  every receipt  -  every issue
 *
 * Summed from the ledger rows rather than read off the newest row's
 * `balanceQuantity`, because that column is a derived cache that a back-dated
 * entry leaves stale until `recomputeItemBalances()` rewrites it. A sum cannot
 * be stale and does not care what order the rows are in.
 */

/** Trim, so a stray space in a name does not become a second item. */
const key = (name) => String(name || "").trim();

/** Case-insensitive form, used only as a fallback match. */
const loose = (name) => key(name).toLowerCase();

/**
 * One entry per item: `{ name, quantity, unit }`.
 *
 * `items`     - item master records, needing `name` and `openingQuantity`
 * `movements` - `{ _id | itemName, received, issued }`, as the ledger
 *               aggregation groups them
 *
 * An item with no movements still appears, at its opening quantity. A movement
 * for an item that is no longer in the master also appears, counted from zero,
 * rather than being silently dropped.
 */
export function buildStockIndex({ items = [], movements = [] } = {}) {
  const out = new Map();

  for (const item of items) {
    const name = key(item?.name);
    if (!name) continue;
    out.set(name, {
      name,
      quantity: Number(item?.openingQuantity) || 0,
      unit: key(item?.unit),
    });
  }

  for (const move of movements) {
    const name = key(move?.itemName ?? move?._id);
    if (!name) continue;
    const delta = (Number(move?.received) || 0) - (Number(move?.issued) || 0);
    const existing = out.get(name);
    if (existing) existing.quantity += delta;
    else out.set(name, { name, quantity: delta, unit: "" });
  }

  return [...out.values()];
}

/**
 * The entry for one item name, or null.
 *
 * Exact first, because that is how the ledger is joined. The case-insensitive
 * fallback only catches a name that differs by case or padding -- which would
 * otherwise read as "this item has no stock record" on a page where it is
 * plainly selected.
 */
export function stockOf(index = [], name) {
  const wanted = key(name);
  if (!wanted) return null;

  const exact = index.find((entry) => key(entry?.name) === wanted);
  if (exact) return exact;

  const target = loose(wanted);
  return index.find((entry) => loose(entry?.name) === target) || null;
}

/**
 * A quantity as a person would write it: no trailing zeros, no exponent, and
 * the unit after it when the item has one.
 *
 *   240, "PCS"    ->  "240 PCS"
 *   12.50, "KG"   ->  "12.5 KG"
 *   0.333333, ""  ->  "0.333"
 */
export function formatQuantity(value, unit = "") {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  // Three decimals is plenty for kilos and metres, and parseFloat drops the
  // trailing zeros that toFixed leaves behind.
  const text = String(parseFloat(safe.toFixed(3)));
  const suffix = key(unit);
  return suffix ? `${text} ${suffix}` : text;
}

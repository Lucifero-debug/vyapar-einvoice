/**
 * Party price lists: what an item costs THIS customer, and the discount that
 * goes with it.
 *
 * A row mirrors the price-list screen:
 *
 *   Item Name | Unit | Sale Price | MRP | Discount %
 *
 * ONE DISCOUNT PER ROW
 * --------------------
 * A row carries a single discount percentage, the same single percentage an
 * invoice line carries. Lists saved when the screen had three successive
 * discounts (Dis 1 / Dis 2 / Dis 3) still load: their chain is collapsed into
 * the one equivalent percentage -- 10 / 5 / 2 becomes 16.21, not 17 -- so they
 * keep billing exactly what they billed before.
 *
 * Kept free of Mongoose: the billing pages are client components and import
 * this directly.
 */

import { round2 } from "./balance.mjs";

/** A percentage that cannot be negative or take more than the whole amount. */
const pct = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 100);
};

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * A money cell, or `null` when it is blank or unusable.
 *
 * `null` means "fall back to the item master". It is NOT the same as 0, which
 * means the item is free. A negative or non-numeric cell is a typo, so it
 * reads as blank -- it used to be coerced to 0, which quietly put the item on
 * the list at no charge.
 */
const money = (value) => {
  if (blank(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const blank = (value) => value === "" || value === null || value === undefined;

/**
 * A legacy Dis 1 / Dis 2 / Dis 3 chain as one percentage. The discounts applied
 * one after another, so 10 / 5 / 2 is 16.21%, not 17%.
 */
function legacyChain(dis1, dis2, dis3) {
  const remaining = [dis1, dis2, dis3].reduce(
    (factor, d) => factor * (1 - pct(d) / 100),
    1
  );
  return round2((1 - remaining) * 100);
}

/**
 * A stored or submitted row's discount. Reads `discount`, and for rows saved
 * before the screen had a single discount, collapses their old chain.
 */
export function rowDiscount(row) {
  if (!row) return 0;
  if (!blank(row.discount)) return round2(pct(row.discount));
  return legacyChain(row.dis1, row.dis2, row.dis3);
}

/** The rate after the discount. Rounded to 2dp, as on the invoice line. */
export function netRate(salePrice, discount) {
  const gross = num(salePrice);
  return round2(gross - (gross * pct(discount)) / 100);
}

/** A row is worth storing once it names an item and carries any figure.
 *  `price` is the old name for the rate and is still accepted on the way in. */
const rowHasContent = (row) =>
  !blank(row.salePrice) ||
  !blank(row.price) ||
  !blank(row.mrp) ||
  !blank(row.discount) ||
  !blank(row.dis1) ||
  !blank(row.dis2) ||
  !blank(row.dis3) ||
  !blank(row.unit);

/**
 * Normalise what the form sends: drop empty and duplicate rows, coerce the
 * numbers, and keep nothing that does not name an item.
 *
 * A row with an item but a blank Sale Price is still kept -- it may carry only
 * a discount, and the rate then comes from the item master.
 */
export function cleanPriceListItems(items) {
  if (!Array.isArray(items)) return [];

  const seen = new Set();
  const out = [];

  for (const row of items) {
    if (!row || !row.itemId) continue;
    if (!rowHasContent(row)) continue;

    const key = String(row.itemId);
    if (seen.has(key)) continue;

    // Coerce FIRST, then decide whether anything survived. A row whose only
    // content was an unusable figure carries no instruction at all, so storing
    // it would just shadow the item master with nothing.
    // `price` is the old name for the rate and is still read here.
    const salePrice = money(row.salePrice) ?? money(row.price);
    const mrp = money(row.mrp);
    const discount = rowDiscount(row);
    const unit = row.unit || "";

    if (salePrice === null && mrp === null && !discount && !unit) continue;

    seen.add(key);
    out.push({ itemId: row.itemId, name: row.name, unit, salePrice, mrp, discount });
  }

  return out;
}

/** This party's row for an item, or null. */
export function findPriceListRow(item, priceList) {
  if (!item || !priceList) return null;
  return (
    (priceList.items || []).find(
      (row) => String(row.itemId) === String(item._id)
    ) || null
  );
}

/**
 * Everything a billing line needs for one item.
 *
 * Falls back to the item master field by field, so a row that sets only a
 * discount still bills at the master rate, and a row that sets only a rate
 * still picks up the master's discount.
 */
export function resolveItemPricing(item, priceList) {
  const masterRate = num(item?.salePrice);
  const masterDiscount = pct(item?.discount);
  const row = findPriceListRow(item, priceList);

  if (!row) {
    return {
      rate: masterRate,
      discount: masterDiscount,
      mrp: num(item?.mrp),
      unit: item?.unit || "",
      source: "master",
    };
  }

  // `price` is what rows were called before the screen grew its discount
  // columns; read it so lists saved then still bill correctly.
  // A stored row may hold null (blank), a number, or -- on a row written
  // before this was tightened -- a 0 that was really a rejected typo. Only a
  // genuine number is honoured; anything else falls back to the master.
  const listed = money(row.salePrice) ?? money(row.price);
  const listedDiscount = rowDiscount(row);

  return {
    rate: listed === null ? masterRate : listed,
    discount: listedDiscount > 0 ? listedDiscount : masterDiscount,
    mrp: money(row.mrp) ?? num(item?.mrp),
    unit: row.unit || item?.unit || "",
    source: "list",
  };
}

/**
 * The rate alone. Kept because the billing pages called this before pricing
 * grew into an object; `resolveItemPricing` is what new code should use.
 */
export function resolveItemRate(item, priceList) {
  return resolveItemPricing(item, priceList).rate;
}

/** "Party · 25-09-2026", used wherever a price list is picked from a list. */
export function priceListLabel(priceList) {
  const d = priceList?.date ? new Date(priceList.date) : null;
  const date = d && !Number.isNaN(d.getTime())
    ? `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`
    : "";
  return [priceList?.partyName || "Unknown party", date].filter(Boolean).join(" · ");
}

/** The party's most recent price list, or null. */
export function latestPriceListFor(priceLists, partyId) {
  if (!partyId) return null;
  return (priceLists || [])
    .filter((pl) => String(pl.party) === String(partyId))
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;
}

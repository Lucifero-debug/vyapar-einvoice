/**
 * What to make, and what is short to make it.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/production-plan.test.mjs directly. Never import Mongoose in here.
 *
 *
 * THIS IS NOT FROM SIGFA
 * ----------------------
 * Sigfa has no planner. Its binary holds `PlanGrid`, `PlanGrid1` and
 * `Sigfa10.PlanGrid` -- a VB grid control -- plus `PLANo`, a document-number
 * field, and `Deposit Planning`, which is a banking feature. Every `MRP`
 * string in it is Maximum Retail Price: `Check Sale Price With MRP`,
 * `Excise Calculation On MRP`, `TxtMRP`. There are no PLAN, SCHED or REQ
 * tables in the program file or in the client's live data.
 *
 * So nothing here was copied. What it does have to work with is everything
 * the rest of this app already knows: what has been promised (pending sales
 * orders), what each thing is made of (lib/bom.mjs), what is on the shelf
 * (lib/itemStock.mjs) and what is already coming (pending purchase orders).
 *
 *
 * THE ARITHMETIC, AND THE TWO PLACES IT IS EASY TO GET WRONG
 * ---------------------------------------------------------
 * For each item customers are waiting for:
 *
 *     to make = pending on sales orders - what is already in stock
 *
 * NOT simply the pending quantity. A shop holding 300 of something and owing
 * 400 needs to make 100, and a plan that said 400 would consume four times
 * the raw material it should. The finished item's own stock is netted off
 * BEFORE the formula is exploded, which is the first thing to get wrong.
 *
 * Then, for each raw material the explosion reaches:
 *
 *     short = required - stock on hand - already on purchase order
 *
 * The last term is the second thing to get wrong. Leaving it out tells you to
 * buy what you have already bought, and a planner that does that once is a
 * planner nobody opens again. It is reported as its own column rather than
 * folded into the stock figure, so a shortfall that looks surprisingly small
 * can be seen to be small for a reason.
 *
 * Both subtractions are floored at zero. A negative shortfall is surplus, and
 * on a list people scan quickly "-250 short" reads as the opposite of what it
 * means.
 *
 *
 * STOCK IS ALLOCATED ONCE, AND ONLY ONCE
 * --------------------------------------
 * The subtle part, and it was wrong in the first draft of this file.
 *
 * Stock gets used twice over unless something stops it: once to reduce what
 * has to be made, and again to reduce the shortfall of the very same item in
 * the material list. A bought-in item owed 50 with 10 on the shelf came out
 * as "make 40" and then "short 30" -- the ten counted against both, and the
 * plan under-ordered by exactly the stock on hand.
 *
 * So there is one pool, `available`, and exactly one rule about who draws
 * from it:
 *
 *   an item that WILL BE MADE     draws from the pool here, and the pool is
 *                                 decremented, because that stock is now
 *                                 spoken for
 *   an item that is BOUGHT IN     does not draw here at all. Its full
 *                                 demand goes into the material list and the
 *                                 netting happens there, once
 *
 * The same pool is what the material list nets against, so an item that is
 * both made for customers AND consumed by something else cannot have its
 * stock promised to both.
 */

import { QTY_EPSILON, roundQty } from "./orderStatus.mjs";
import { round2 } from "./balance.mjs";
import { byOutputItem, explode, mergeLines, bomsFor } from "./bom.mjs";

const text = (value) => String(value ?? "").trim();
const key = (value) => text(value).toLowerCase();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Sum a set of pending rows by item name, keeping the first spelling seen. */
export const demandByItem = (rows = []) => {
  const out = new Map();
  for (const row of rows) {
    const name = text(row?.item);
    if (!name) continue;
    const k = key(name);
    if (!out.has(k)) out.set(k, { item: name, quantity: 0, lines: 0, orders: new Set() });
    const entry = out.get(k);
    entry.quantity = roundQty(entry.quantity + num(row.pending));
    entry.lines += 1;
    if (row.orderNo) entry.orders.add(`${text(row.type)}#${num(row.orderNo)}`);
  }
  return out;
};

/**
 * The plan.
 *
 *   saleRows      pending lines from SALES orders    (lib/orderReports.mjs)
 *   purchaseRows  pending lines from PURCHASE orders -- material already coming
 *   boms          every formula                      (models/bomModel.js)
 *   stockOf       item name -> quantity on hand, or null when not in the master
 *   costOf        item name -> cost, for valuing the shortfall
 *   nested        explode sub-formulas; on by default
 *
 * Returns `{ make, buy, summary, warnings }`.
 */
export const productionPlan = ({
  saleRows = [],
  purchaseRows = [],
  boms = [],
  stockOf,
  costOf,
  nested = true,
} = {}) => {
  const stock = typeof stockOf === "function" ? stockOf : () => null;
  const cost = typeof costOf === "function" ? costOf : () => 0;
  const onHand = (name) => {
    const found = stock(name);
    return found === null || found === undefined ? null : roundQty(found);
  };

  const index = byOutputItem(boms);
  const demand = demandByItem(saleRows);
  const incoming = demandByItem(purchaseRows);
  const warnings = [];

  // The one pool. Decremented as stock is promised to something, so nothing
  // is promised twice. Seeded lazily, because `stockOf` may not know an item.
  const available = new Map();
  const availableFor = (name) => {
    const k = key(name);
    if (!available.has(k)) available.set(k, onHand(name));
    return available.get(k);
  };
  const draw = (name, quantity) => {
    const k = key(name);
    const have = availableFor(name);
    if (have === null) return 0;
    const taken = Math.min(have, Math.max(0, roundQty(quantity)));
    available.set(k, roundQty(have - taken));
    return taken;
  };

  // --- what has to be made, and what can be taken off the shelf ------------
  const make = [];
  const required = new Map();

  const need = (itemName, quantity, from) => {
    const name = text(itemName);
    const qty = roundQty(quantity);
    if (!name || qty <= 0) return;
    const k = key(name);
    if (!required.has(k)) required.set(k, { item: name, quantity: 0, forItems: new Set() });
    const entry = required.get(k);
    entry.quantity = roundQty(entry.quantity + qty);
    if (from) entry.forItems.add(from);
  };

  for (const entry of [...demand.values()].sort((a, b) => a.item.localeCompare(b.item))) {
    const have = availableFor(entry.item);

    const formulaCount = bomsFor(entry.item, index);
    const bom = formulaCount === 1 ? index.get(key(entry.item))[0] : null;

    // Only an item that will be MADE draws from the pool. A bought-in item's
    // stock is netted in the material list instead -- see the note above
    // about counting it twice.
    const fromStock = bom
      ? draw(entry.item, entry.quantity)
      : have === null
        ? 0
        : Math.min(have, entry.quantity);

    // The subtraction the whole plan turns on. Floored at zero: holding more
    // than is owed means making none, not making a negative number.
    const toMake = Math.max(0, roundQty(entry.quantity - fromStock));

    if (formulaCount > 1) {
      warnings.push(
        `${entry.item} has ${formulaCount} formulas, so it was left out of the material list. Delete or rename the duplicates to plan it.`
      );
    }

    let lines = [];
    if (bom && toMake > QTY_EPSILON) {
      const result = explode({ bom, outputQuantity: toMake, index, nested });
      lines = mergeLines(result.lines);
      for (const w of result.warnings) if (!warnings.includes(w)) warnings.push(w);
      for (const line of lines) {
        // A by-product is produced, not consumed, so it is not a requirement.
        // Nor is it treated as supply: counting a by-product you have not made
        // yet as stock in hand would net off a shortfall against something
        // that does not exist.
        if (line.kind === "byproduct") continue;
        need(line.itemName, line.quantity, entry.item);
      }
    }

    make.push({
      item: entry.item,
      pending: entry.quantity,
      inStock: have,
      known: have !== null,
      fromStock: roundQty(fromStock),
      toMake,
      orders: entry.orders.size,
      lines: entry.lines,
      hasFormula: Boolean(bom),
      formulaName: bom ? text(bom.name) : "",
      ambiguous: formulaCount > 1,
      materialLines: lines.filter((l) => l.kind !== "byproduct").length,
    });
  }

  // Items customers are waiting for that nothing knows how to make. They are
  // not a planning failure -- most of a trading firm's catalogue is bought in
  // -- so they appear in the material list rather than being dropped.
  //
  // The FULL pending quantity goes in, not what is left after stock. Their
  // stock was deliberately not drawn above, so the netting below is the only
  // one, and sending `toMake` here instead would subtract it a second time.
  for (const row of make) {
    if (row.hasFormula || row.ambiguous || row.pending <= QTY_EPSILON) continue;
    need(row.item, row.pending, null);
  }

  // --- what is short ------------------------------------------------------
  const buy = [...required.values()]
    .map((entry) => {
      // What is LEFT in the pool: stock already promised to something being
      // made is gone from here, so it cannot cover a material shortfall too.
      const have = availableFor(entry.item);
      const stockQty = have === null ? 0 : have;
      const ordered = incoming.get(key(entry.item))?.quantity || 0;
      // Reported as its own column, never folded into the stock figure: a
      // shortfall that is surprisingly small should be visibly small for a
      // reason.
      const short = Math.max(0, roundQty(entry.quantity - stockQty - ordered));
      const rate = num(cost(entry.item));

      return {
        item: entry.item,
        required: entry.quantity,
        inStock: have,
        known: have !== null,
        onOrder: roundQty(ordered),
        short,
        rate: round2(rate),
        value: round2(short * rate),
        // Which finished items drove this requirement, so a surprising
        // quantity can be traced without re-running anything.
        forItems: [...entry.forItems].sort(),
        // A requirement for something that is not in the item master cannot be
        // valued and probably cannot be bought either.
        unknownItem: have === null,
      };
    })
    .sort((a, b) => b.short - a.short || a.item.localeCompare(b.item));

  const unknown = buy.filter((b) => b.unknownItem).map((b) => b.item);
  if (unknown.length) {
    warnings.push(
      `${unknown.slice(0, 6).join(", ")}${unknown.length > 6 ? ", …" : ""} ${
        unknown.length === 1 ? "is" : "are"
      } not in the item master, so ${unknown.length === 1 ? "its" : "their"} stock reads as nil and ${
        unknown.length === 1 ? "it is" : "they are"
      } valued at nothing.`
    );
  }

  const noFormula = make.filter((m) => !m.hasFormula && !m.ambiguous && m.toMake > QTY_EPSILON);
  if (noFormula.length) {
    warnings.push(
      `${noFormula.length} item${noFormula.length === 1 ? "" : "s"} on order ${
        noFormula.length === 1 ? "has" : "have"
      } no formula, so ${noFormula.length === 1 ? "it is" : "they are"} listed as bought in rather than made: ${noFormula
        .slice(0, 6)
        .map((m) => m.item)
        .join(", ")}${noFormula.length > 6 ? ", …" : ""}.`
    );
  }

  const shortRows = buy.filter((b) => b.short > QTY_EPSILON);

  return {
    make,
    buy,
    warnings,
    summary: {
      itemsOnOrder: make.length,
      itemsToMake: make.filter((m) => m.toMake > QTY_EPSILON).length,
      coveredFromStock: make.filter((m) => m.toMake <= QTY_EPSILON).length,
      materials: buy.length,
      shortMaterials: shortRows.length,
      shortValue: round2(shortRows.reduce((t, b) => round2(t + b.value), 0)),
      // Worth its own figure: a plan whose shortfall is small only because a
      // lot is already on order is a different situation from one with the
      // stock in hand.
      onOrderCovering: round2(
        buy.reduce((t, b) => roundQty(t + Math.min(b.onOrder, b.required)), 0)
      ),
    },
  };
};

/** The columns the plan downloads as. */
export const PLAN_CSV_COLUMNS = {
  make: [
    { key: "item", label: "Item" },
    { key: "pending", label: "On Order" },
    { key: "inStock", label: "In Stock", value: (r) => (r.known ? r.inStock : "not in master") },
    { key: "fromStock", label: "From Stock" },
    { key: "toMake", label: "To Make" },
    { key: "formulaName", label: "Formula" },
    { key: "orders", label: "Orders" },
  ],
  buy: [
    { key: "item", label: "Material" },
    { key: "required", label: "Required" },
    { key: "inStock", label: "In Stock", value: (r) => (r.known ? r.inStock : "not in master") },
    { key: "onOrder", label: "On Purchase Order" },
    { key: "short", label: "Short" },
    { key: "rate", label: "Cost" },
    { key: "value", label: "Value Short" },
    { key: "forItems", label: "Needed For", value: (r) => (r.forItems || []).join(" | ") },
  ],
};

/** A download file name that says what it is and when it was taken. */
export const planFilename = (which, now = Date.now()) => {
  const stamp = new Date(now).toISOString().slice(0, 10);
  const part = which === "buy" ? "materials" : "to-make";
  return `production-plan-${part}-${stamp}.csv`;
};

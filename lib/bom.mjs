/**
 * Bills of material, and what a production entry does with one.
 *
 * Pure and dependency-free except for two helpers borrowed from modules that
 * are themselves pure, so `node` can run scripts/bom.test.mjs directly. Never
 * import Mongoose in here.
 *
 *
 * WHERE THIS CAME FROM
 * --------------------
 * Sigfa's Masters > Misc > Bill of Material. Internally it calls the screen the
 * Formula Master and stores it in one flat table, FMAST:
 *
 *   BOM      TEXT(25)   the formula's NAME -- the key
 *   RefNo    LONG       line serial within that formula
 *   ITCODE   LONG       the item produced     \ repeated, identically,
 *   UNIT     LONG       its unit               > on every line of the
 *   FORQTY   MONEY      how much output it makes /  same formula
 *   FCODE    LONG       the component item
 *   FUNIT    LONG       component unit
 *   FQTY     MONEY      component qty per FORQTY of output
 *   FRATE    MONEY      component rate, for costing
 *   ADDLESS  TEXT(3)    add / less
 *
 * Three departures from that, each deliberate:
 *
 *   1. The header fields live on the header. FMAST repeats ITCODE, UNIT and
 *      FORQTY on every row, so a formula whose output quantity is corrected
 *      needs every row rewritten and half-finished edits leave rows that
 *      disagree about what the formula even makes. Ours is a document with
 *      lines, so there is one place to look.
 *
 *   2. ADDLESS becomes a named kind. "Less" tells you the sign but not the
 *      reason, and the two reasons behave differently in stock: a wastage
 *      allowance is consumed and vanishes, a by-product is RECEIVED into
 *      stock as something you can sell. Sigfa's own strings carry both words
 *      (WASTAGE, ByProduct), so the distinction is theirs -- it just never
 *      made it into the column.
 *
 *   3. No FRATE. Costing reads each component's current cost from the item
 *      master instead, the same choice already made for GST rates on order
 *      lines: a rate stored on a line is a rate nobody remembers to refresh,
 *      and a formula quietly costed at last year's prices is worse than one
 *      that admits it has no price at all (see `missingCosts` below).
 *
 * A PRODUCTION ENTRY SNAPSHOTS ITS LINES, and that is why editing a formula is
 * never blocked. The voucher stores the exploded result, not a pointer to the
 * formula, for the same reason an invoice stores the buyer's address rather
 * than looking it up: what was consumed in March must keep saying so after the
 * formula changes in June.
 */

// Quantity rounding has to be ONE rule across the app -- an order pending by
// 0.0005 of a unit and a production entry consuming 0.0005 more than it has
// are the same bug -- and it already lives in orderStatus.mjs. Imported rather
// than copied, so the two cannot drift apart.
import { QTY_DECIMALS, QTY_EPSILON, roundQty } from "./orderStatus.mjs";
import { round2 } from "./balance.mjs";
import { nameKey, normalizeName } from "./uniqueName.mjs";

export { QTY_DECIMALS, QTY_EPSILON, roundQty };

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * What a line is for.
 *
 *   material   a component consumed to make the output.
 *   wastage    an allowance also consumed, but which becomes nothing. Kept
 *              apart from material so a costing can show it, and so "what
 *              does this product actually contain" has an answer.
 *   byproduct  something RECEIVED alongside the output. Its value reduces the
 *              cost of the output, and its quantity goes into stock.
 */
export const LINE_KINDS = ["material", "wastage", "byproduct"];

export const LINE_KIND_LABELS = {
  material: "Material",
  wastage: "Wastage",
  byproduct: "By-product",
};

export const isLineKind = (kind) => LINE_KINDS.includes(text(kind));

/** Unknown or missing kinds read as material -- the overwhelming majority. */
export const lineKind = (kind) => (isLineKind(kind) ? text(kind) : "material");

/**
 * Does this kind come OUT of stock?
 *
 * The one question the item ledger needs answering, and the reason the three
 * kinds exist rather than a boolean: material and wastage both issue, but they
 * are not the same thing on a costing sheet.
 */
export const consumes = (kind) => lineKind(kind) !== "byproduct";

/** Which side of the stock ledger a line lands on. */
export const stockDirection = (kind) => (consumes(kind) ? "issue" : "receipt");

/**
 * Scale a formula line to the quantity actually being made.
 *
 * `forQuantity` is the output the formula is written FOR -- components for 100
 * pieces, say -- so making 250 multiplies every line by 2.5. A formula with a
 * zero or negative forQuantity cannot be scaled at all; it returns 0 rather
 * than Infinity or NaN, and `bomProblems` refuses to let one be saved.
 */
export const scaleQty = (lineQty, outputQty, forQuantity) => {
  const per = num(forQuantity);
  if (per <= 0) return 0;
  return roundQty((num(lineQty) * num(outputQty)) / per);
};

/** The formula's own lines, cleaned up and in a predictable order. */
export const bomLines = (bom) =>
  (bom?.lines || []).filter((line) => line && text(line.itemName));

/** Lines of one kind. */
export const linesOfKind = (bom, kind) =>
  bomLines(bom).filter((line) => lineKind(line.kind) === lineKind(kind));

/**
 * What is wrong with this formula, in words a user can act on.
 *
 * Returns [] when it is fit to save. Every rule here is one Sigfa enforces too
 * -- its own messages are quoted beside the ones taken from it.
 */
export const bomProblems = (bom) => {
  const problems = [];

  const name = normalizeName(bom?.name);
  if (!name) problems.push("A formula needs a name.");
  if (name.length > 60) problems.push("The formula name is too long.");

  const output = normalizeName(bom?.outputItem);
  if (!output) problems.push("Say which item this formula makes.");

  const forQuantity = num(bom?.forQuantity);
  if (forQuantity <= 0) {
    problems.push(
      "The formula has to make some quantity -- set what the lines below produce."
    );
  }

  const lines = bomLines(bom);
  if (!lines.length) problems.push("A formula needs at least one line.");

  // A formula of nothing but wastage and by-products makes its output out of
  // thin air. Sigfa does not state this one; it falls out of the fact that
  // every formula there is entered as raw material first.
  if (lines.length && !linesOfKind(bom, "material").length) {
    problems.push("A formula needs at least one material line.");
  }

  const seen = new Map();
  lines.forEach((line, i) => {
    const where = `Line ${i + 1}`;
    const item = normalizeName(line.itemName);
    const kind = lineKind(line.kind);

    if (!isLineKind(line.kind) && text(line.kind)) {
      problems.push(`${where}: "${text(line.kind)}" is not a kind of line.`);
    }

    const qty = num(line.quantity);
    if (qty <= 0) problems.push(`${where} (${item}): the quantity must be more than zero.`);

    // Sigfa: "Item To Produce Can't be Raw Material". Blocked for every kind,
    // not just material: an item listed as its own by-product would be issued
    // and received by the same entry, and the explosion below would recurse
    // into itself forever.
    if (nameKey(item) === nameKey(output) && output) {
      problems.push(`${where}: ${item} is what this formula makes, so it cannot also be a line of it.`);
    }

    // Sigfa: "Y  Don't Allow Duplicate Item In Production." Same item twice as
    // material is an entry mistake; the same item as material AND as a
    // by-product is legitimate (recovering offcuts of what you cut), so the
    // kind is part of the key.
    const key = `${nameKey(item)}\u0000${kind}`;
    if (seen.has(key)) {
      problems.push(
        `${where}: ${item} is already on line ${seen.get(key) + 1} as ${LINE_KIND_LABELS[kind].toLowerCase()}.`
      );
    } else {
      seen.set(key, i);
    }
  });

  return problems;
};

/** Convenience: is this formula fit to save? */
export const isSaveable = (bom) => bomProblems(bom).length === 0;

/* ------------------------------------------------------------------ *
 *  Nesting
 * ------------------------------------------------------------------ */

/**
 * Index formulas by the item they make, so a component can be looked up.
 *
 * A Map of nameKey(outputItem) -> [bom, ...]. A list rather than a single
 * formula because nothing stops two formulas making the same item, and
 * pretending otherwise would make explosion depend on which one Mongo
 * happened to return first.
 */
export const byOutputItem = (boms = []) => {
  const index = new Map();
  for (const bom of boms) {
    const key = nameKey(bom?.outputItem);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(bom);
  }
  return index;
};

/**
 * The sub-formula for a component, or null.
 *
 * Deliberately refuses to choose when an item has more than one formula. The
 * explosion then treats the item as a raw component and says so in a warning,
 * which is wrong in a visible way rather than wrong in a silent one.
 */
export const subBomFor = (itemName, index) => {
  const found = index?.get?.(nameKey(itemName)) || [];
  return found.length === 1 ? found[0] : null;
};

/** How many formulas make this item (0, 1 or ambiguous). */
export const bomsFor = (itemName, index) => (index?.get?.(nameKey(itemName)) || []).length;

/**
 * The default depth limit for explosion.
 *
 * Cycles are caught by name, so this is not what stops infinite recursion --
 * it stops a legitimately deep tree from producing a page nobody can read, and
 * it is reported (`truncated`) rather than hidden.
 */
export const MAX_DEPTH = 12;

/**
 * Explode a formula into the things that actually move.
 *
 * Sigfa's "With Sub Formula": a component that has a formula of its own is
 * replaced by ITS components, down the tree. The sub-assembly itself does not
 * appear -- it is made and consumed in the same breath, so putting it in the
 * ledger would record a receipt of something that was never received.
 *
 * Its wastage and by-product lines DO come through: if you are implicitly
 * making the sub-assembly, you are implicitly producing its offcuts too.
 *
 *   nested: false  stop at the first level, whatever formulas exist below.
 *
 * Returns { lines, warnings, truncated, maxDepthSeen }, where each line is
 * { itemName, kind, quantity, unit, depth, via, path } -- `via` naming the
 * formula that contributed it and `path` the chain of items above it, so a
 * quantity nobody expected can be traced back to the line that caused it.
 */
export const explode = ({
  bom,
  outputQuantity = 0,
  index = new Map(),
  nested = true,
  maxDepth = MAX_DEPTH,
} = {}) => {
  const lines = [];
  const warnings = [];
  const state = { truncated: false, maxDepthSeen: 0 };

  const qty = num(outputQuantity);
  if (!bom || qty <= 0) return { lines, warnings, ...state };

  const walk = (current, scale, depth, chain) => {
    state.maxDepthSeen = Math.max(state.maxDepthSeen, depth);

    for (const line of bomLines(current)) {
      const itemName = normalizeName(line.itemName);
      const kind = lineKind(line.kind);
      const quantity = scaleQty(line.quantity, scale, current.forQuantity);

      // A line that scales to nothing is dropped rather than written as a
      // zero-quantity movement. Three decimals of a unit is the resolution
      // the whole app works at (QTY_DECIMALS); below that there is nothing
      // to issue.
      if (quantity <= 0) continue;

      const leaf = () =>
        lines.push({
          itemName,
          kind,
          quantity,
          unit: text(line.unit),
          depth,
          via: text(current.name),
          path: [...chain, itemName],
        });

      if (!nested) {
        leaf();
        continue;
      }

      // Only a consumed line can be made by a formula of its own. Expanding a
      // by-product would mean claiming you also produced the things IT is
      // made of, which is backwards.
      if (!consumes(kind)) {
        leaf();
        continue;
      }

      const ambiguous = bomsFor(itemName, index) > 1;
      if (ambiguous) {
        warnings.push(
          `${itemName} has more than one formula, so it was taken as a raw component. Delete or rename the duplicates to expand it.`
        );
        leaf();
        continue;
      }

      const sub = subBomFor(itemName, index);
      if (!sub) {
        leaf();
        continue;
      }

      // A cycle. Caught against the chain of items ABOVE this one, which is
      // what makes mutual recursion (A made of B made of A) visible and not
      // just self-reference. `bomProblems` blocks the one-step case at save
      // time; this catches the ones that only appear once two formulas are
      // read together.
      if (chain.some((up) => nameKey(up) === nameKey(itemName))) {
        warnings.push(
          `${[...chain, itemName].join(" > ")} loops back on itself, so ${itemName} was taken as a raw component.`
        );
        leaf();
        continue;
      }

      if (depth + 1 > maxDepth) {
        state.truncated = true;
        warnings.push(
          `${itemName} has a formula, but the tree is deeper than ${maxDepth} levels, so it was taken as a raw component.`
        );
        leaf();
        continue;
      }

      walk(sub, quantity, depth + 1, [...chain, itemName]);
    }
  };

  walk(bom, qty, 0, [normalizeName(bom.outputItem)]);

  return { lines, warnings, ...state };
};

/**
 * Combine lines that are the same item and the same kind.
 *
 * Sigfa: "Raw Material Merged In Formula Successfully." Nesting is what makes
 * this necessary -- two sub-assemblies both using the same screw produce two
 * lines for it, and issuing a screw twice in one voucher reads as a mistake
 * even though the total is right.
 *
 * Keeps the shallowest depth and every path, so a merged quantity can still be
 * traced to the places it came from.
 */
export const mergeLines = (lines = []) => {
  const buckets = new Map();

  for (const line of lines) {
    const itemName = normalizeName(line?.itemName);
    if (!itemName) continue;
    const kind = lineKind(line?.kind);
    const key = `${nameKey(itemName)}\u0000${kind}`;

    if (!buckets.has(key)) {
      buckets.set(key, {
        itemName,
        kind,
        quantity: 0,
        unit: text(line?.unit),
        depth: num(line?.depth),
        via: text(line?.via),
        paths: [],
        mergedFrom: 0,
      });
    }

    const row = buckets.get(key);
    row.quantity = roundQty(row.quantity + num(line?.quantity));
    row.depth = Math.min(row.depth, num(line?.depth));
    row.mergedFrom += 1;
    if (!row.unit) row.unit = text(line?.unit);
    if (Array.isArray(line?.path)) row.paths.push(line.path.join(" > "));
  }

  // Material first, then wastage, then by-products, alphabetical within each:
  // the order a costing sheet reads in.
  const order = { material: 0, wastage: 1, byproduct: 2 };
  return [...buckets.values()].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.itemName.localeCompare(b.itemName)
  );
};

/* ------------------------------------------------------------------ *
 *  Costing
 * ------------------------------------------------------------------ */

/**
 * What the formula costs, at today's prices.
 *
 * `costOf` is a function from item name to a rate -- in practice the item
 * master's `cost`, which is why no rate is stored on the line.
 *
 * `missingCosts` is the part worth reading. An item with no cost in the master
 * contributes nothing, so a formula half of whose components are unpriced
 * produces a confident-looking number that is simply too low. Naming them lets
 * the page say "costed on 4 of 7 lines" instead of lying by omission.
 */
export const bomCost = ({ lines = [], outputQuantity = 0, costOf } = {}) => {
  const rate = typeof costOf === "function" ? costOf : () => 0;

  let materialValue = 0;
  let wastageValue = 0;
  let byproductValue = 0;
  const missingCosts = [];
  const seenMissing = new Set();

  for (const line of lines) {
    const itemName = normalizeName(line?.itemName);
    if (!itemName) continue;

    const cost = Number(rate(itemName));
    if (!Number.isFinite(cost) || cost <= 0) {
      const key = nameKey(itemName);
      if (!seenMissing.has(key)) {
        seenMissing.add(key);
        missingCosts.push(itemName);
      }
      continue;
    }

    const value = round2(num(line?.quantity) * cost);
    const kind = lineKind(line?.kind);
    if (kind === "material") materialValue = round2(materialValue + value);
    else if (kind === "wastage") wastageValue = round2(wastageValue + value);
    else byproductValue = round2(byproductValue + value);
  }

  // Wastage is consumed, so it is a cost. A by-product is recovered, so it is
  // a credit -- which is the whole point of Sigfa's ADDLESS column.
  const netCost = round2(materialValue + wastageValue - byproductValue);
  const made = num(outputQuantity);

  return {
    materialValue,
    wastageValue,
    byproductValue,
    netCost,
    // Rounded to paise like every other money figure here. A per-unit cost of
    // a fraction of a paisa is not a number anybody acts on.
    costPerUnit: made > 0 ? round2(netCost / made) : 0,
    missingCosts,
    // Counted in lines, not in distinct items: a page saying "costed on 4 of
    // 7 lines" is answering the question the user is actually asking.
    costedLines: lines.length - countMissing(lines, missingCosts),
    totalLines: lines.length,
  };
};

const countMissing = (lines, missingCosts) => {
  const missing = new Set(missingCosts.map(nameKey));
  return lines.filter((line) => missing.has(nameKey(line?.itemName))).length;
};

/* ------------------------------------------------------------------ *
 *  What a production entry does to stock
 * ------------------------------------------------------------------ */

/**
 * The ledger key a production entry writes its stock rows under.
 *
 * NOT just the document number. `ItemLedger.invoiceNo` is a string shared by
 * every voucher type, and writing stock rows DELETES the existing rows for
 * that key first (lib/itemLedger.mjs) -- so a production entry numbered 5
 * saving its rows as "5" would wipe invoice 5's stock movements, and deleting
 * it later would wipe them again. The prefix cannot collide: invoice keys are
 * digits.
 */
export const PRODUCTION_PREFIX = "PRD-";
export const productionLedgerKey = (docNo) => `${PRODUCTION_PREFIX}${num(docNo)}`;
export const isProductionLedgerKey = (key) =>
  String(key ?? "").startsWith(PRODUCTION_PREFIX);

/**
 * The stock movements one production entry makes.
 *
 * Both sides, kept separate and each merged by item:
 *
 *   receipts   the finished item, plus any by-products.
 *   issues     every material and wastage line.
 *
 * An item appearing on both sides -- recovering offcuts of the same material
 * you cut -- stays on both sides rather than being netted off. The ledger is
 * read to answer "what happened", and "issued 100, received 4 back" is what
 * happened; a single row for 96 hides it.
 */
export const productionMovements = ({
  outputItem,
  outputQuantity = 0,
  lines = [],
} = {}) => {
  const issues = new Map();
  const receipts = new Map();

  const add = (bucket, itemName, quantity) => {
    const name = normalizeName(itemName);
    const qty = roundQty(quantity);
    if (!name || qty <= 0) return;
    const key = nameKey(name);
    if (!bucket.has(key)) bucket.set(key, { itemName: name, quantity: 0 });
    const row = bucket.get(key);
    row.quantity = roundQty(row.quantity + qty);
  };

  add(receipts, outputItem, outputQuantity);

  for (const line of lines) {
    add(consumes(line?.kind) ? issues : receipts, line?.itemName, line?.quantity);
  }

  const sort = (bucket) =>
    [...bucket.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));

  return { issues: sort(issues), receipts: sort(receipts) };
};

/**
 * Is there enough stock to run this?
 *
 * `stockOf` is a function from item name to the quantity on hand. Returns the
 * shortfalls, or [] when everything is covered.
 *
 * Deliberately a WARNING and not a block. Small Indian trading and job-work
 * shops routinely book the production that already happened on the floor
 * before the purchase bill for its raw material has been entered; refusing the
 * entry would mean refusing to record something that is physically true, and
 * the stock report already shows negatives honestly. The page says what is
 * short and lets the user decide.
 */
export const shortfalls = ({ issues = [], stockOf } = {}) => {
  const onHand = typeof stockOf === "function" ? stockOf : () => 0;
  const out = [];

  for (const row of issues) {
    const have = roundQty(onHand(row.itemName));
    const need = roundQty(row.quantity);
    // The epsilon matters: 10 on hand against a need of 10.0000001, which is
    // what three-decimal arithmetic on a scaled formula produces, is not a
    // shortage.
    if (have + QTY_EPSILON < need) {
      out.push({ itemName: row.itemName, need, have, short: roundQty(need - have) });
    }
  }

  return out;
};

/* ------------------------------------------------------------------ *
 *  Referential guards
 * ------------------------------------------------------------------ */

/**
 * Why this item cannot be deleted from the item master, or null.
 *
 * Sigfa checks the same thing -- its delete path reads
 * "Check From Salpur1,Sporder1,Quot1,Fmast,PrList,Itmast", with Fmast in the
 * list. An item removed while a formula still names it leaves a formula that
 * makes or consumes something that does not exist, and the explosion then
 * silently issues nothing for it.
 */
export const itemDeleteBlockedReason = (itemName, boms = []) => {
  const key = nameKey(itemName);
  if (!key) return null;

  const makes = boms.find((bom) => nameKey(bom?.outputItem) === key);
  if (makes) {
    return `Cannot delete "${normalizeName(itemName)}" -- the formula "${text(makes.name)}" makes it.`;
  }

  const usedIn = boms.find((bom) =>
    bomLines(bom).some((line) => nameKey(line.itemName) === key)
  );
  if (usedIn) {
    return `Cannot delete "${normalizeName(itemName)}" -- the formula "${text(usedIn.name)}" uses it.`;
  }

  return null;
};

/**
 * Why this formula cannot be deleted, or null.
 *
 * A formula that has never been produced from is free to delete. One that has
 * is still free to delete -- the production entries snapshot their own lines,
 * so nothing breaks -- but it is worth saying what is being given up, so the
 * route returns this as a confirmation rather than a refusal.
 */
export const bomDeleteNotice = (bom, productionCount = 0) => {
  const count = num(productionCount);
  if (count <= 0) return null;
  return `"${text(bom?.name)}" has been used by ${count} production ${
    count === 1 ? "entry" : "entries"
  }. Those keep the materials they recorded; only the formula goes.`;
};

/** One-line description for a list or a dropdown. */
export const bomSummary = (bom) => {
  const lines = bomLines(bom);
  const materials = lines.filter((l) => lineKind(l.kind) === "material").length;
  const extras = lines.length - materials;
  const parts = [`${materials} material${materials === 1 ? "" : "s"}`];
  if (extras) parts.push(`${extras} other`);
  return `${normalizeName(bom?.outputItem) || "?"} x ${num(bom?.forQuantity)} -- ${parts.join(", ")}`;
};

/**
 * The lines as a production entry should store them.
 *
 * Flattens the exploded, merged result into the shape productionModel declares,
 * with the rate and amount frozen at the moment of saving. The rate is NOT
 * stored on the formula -- that is the whole point of reading it live -- but it
 * IS stored here, because a voucher is a record of what a thing cost on the day
 * it happened, not a window onto today's prices.
 */
export const toProductionLines = ({ lines = [], costOf } = {}) => {
  const rate = typeof costOf === "function" ? costOf : () => 0;

  return lines.map((line) => {
    const itemName = normalizeName(line?.itemName);
    const quantity = roundQty(line?.quantity);
    const cost = Number(rate(itemName));
    const costed = Number.isFinite(cost) && cost > 0 ? round2(cost) : 0;

    return {
      itemName,
      kind: lineKind(line?.kind),
      quantity,
      unit: text(line?.unit),
      rate: costed,
      amount: round2(quantity * costed),
      // Where it came from in the tree, kept so a voucher can still explain
      // itself after the formula it came from has been edited or deleted.
      depth: num(line?.depth),
      via: text(line?.via),
      source: Array.isArray(line?.paths) ? line.paths.join(" | ") : text(line?.path),
    };
  });
};

/**
 * What is wrong with a production entry, in words. [] when it can be saved.
 */
export const productionProblems = (entry) => {
  const problems = [];

  if (!normalizeName(entry?.outputItem)) problems.push("Say which item was produced.");
  if (num(entry?.outputQuantity) <= 0) {
    problems.push("The produced quantity must be more than zero.");
  }
  if (!entry?.date) problems.push("A production entry needs a date.");

  const lines = (entry?.lines || []).filter((l) => l && normalizeName(l.itemName));
  if (!lines.length) problems.push("A production entry needs at least one material line.");

  const key = nameKey(entry?.outputItem);
  for (const line of lines) {
    if (num(line.quantity) <= 0) {
      problems.push(`${normalizeName(line.itemName)}: the quantity must be more than zero.`);
    }
    // The same rule as on the formula, re-checked here: the explosion can be
    // edited by hand on the form before saving, so the form can reintroduce
    // what `bomProblems` refused.
    if (nameKey(line.itemName) === key && key) {
      problems.push(
        `${normalizeName(line.itemName)} is what this entry produced, so it cannot also be consumed by it.`
      );
    }
  }

  return problems;
};

// `reversalSummary` lived here and has moved to lib/stockVoucher.mjs as
// `reversalOf`, which knows about all three stock vouchers rather than only
// Production. Two copies of a direction rule is how a by-product ends up
// going back INTO stock -- the exact bug this function had when it was first
// written, and a bug a second copy would be free to reintroduce.

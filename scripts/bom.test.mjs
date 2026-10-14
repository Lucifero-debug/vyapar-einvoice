/**
 * Fixture tests for bills of material and production entries.
 *
 *   node scripts/bom.test.mjs
 *
 * A formula is arithmetic plus a graph, and both halves fail quietly:
 *
 *   1. SCALING. A formula is written for a batch -- components for 100
 *      pieces -- so every quantity is a ratio, and getting the denominator
 *      wrong issues a hundred times too much without throwing anything.
 *
 *   2. THE GRAPH. Nesting means a formula can reference a formula. A loop
 *      (A made of B made of A) recurses until the stack dies; two formulas
 *      making the same item make explosion depend on which one Mongo
 *      returned first.
 *
 *   3. THE SIGN. Material and wastage leave stock; a by-product arrives in
 *      it, and its value is a credit against the cost. Getting that backwards
 *      produces a cost that is wrong by twice the by-product -- a plausible
 *      number, which is the dangerous kind.
 *
 *   4. THE LEDGER KEY. Stock rows are keyed by a string shared with invoices,
 *      and writing them DELETES the existing rows for that key first. A
 *      production entry numbered 5 saving under "5" destroys invoice 5's
 *      stock history. This one is tested hardest because it is silent,
 *      permanent, and would be found months later.
 *
 * Sigfa's own rules are cited where they are copied: FMAST's ADDLESS column,
 * "Item To Produce Can't be Raw Material", "Y  Don't Allow Duplicate Item In
 * Production.", "With Sub Formula", "Raw Material Merged In Formula
 * Successfully." and the Fmast entry in its item-delete check. What is NOT
 * copied is FRATE -- costing reads the item master live -- so nothing here
 * asserts a rate stored on a formula line.
 *
 * Note for whoever reads this next: FMAST was EMPTY in all three of the
 * client's Sigfa data files (0 rows in MCSFAST and AutoSigfa, no such table in
 * the older ones). Unlike the order module, which was measured against 212
 * real orders and 702 lines, the shape here comes from the schema and the
 * program's own strings. The numbers in these fixtures are invented.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  LINE_KINDS,
  LINE_KIND_LABELS,
  MAX_DEPTH,
  PRODUCTION_PREFIX,
  QTY_EPSILON,
  bomCost,
  bomDeleteNotice,
  bomLines,
  bomProblems,
  bomSummary,
  bomsFor,
  byOutputItem,
  consumes,
  explode,
  isLineKind,
  isProductionLedgerKey,
  isSaveable,
  itemDeleteBlockedReason,
  lineKind,
  linesOfKind,
  mergeLines,
  productionLedgerKey,
  productionMovements,
  productionProblems,
  roundQty,
  scaleQty,
  shortfalls,
  stockDirection,
  subBomFor,
  toProductionLines,
} from "../lib/bom.mjs";
import { canAccessPath, permissionForPath } from "../lib/roles.mjs";
import {
  DEFAULT_KIND,
  STOCK_KINDS,
  STOCK_KIND_CODES,
  isStockKind,
  kindOf,
  lineDirection,
  reversalOf,
  stockKind,
  stockKindProblems,
  SLIP_COLUMNS,
  SLIP_HEADER_FIELDS,
  seriesUsed,
  slipAmount,
  slipDate,
  slipDayName,
  slipTitle,
  slipTotal,
  stockLedgerKey,
  stockMovements,
} from "../lib/stockVoucher.mjs";
import { MASTER_COLLECTIONS, TRANSACTION_COLLECTIONS } from "../lib/clearData.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

/**
 * Read a project file, for the wiring checks.
 *
 * Declared HERE, with the test helper, rather than beside the first wiring
 * check that uses it -- a `const` is in its temporal dead zone until the line
 * that declares it runs, so a check added anywhere above would throw "Cannot
 * access 'read' before initialization" instead of asserting anything. That
 * exact mistake cost four silent tests in scripts/orders.test.mjs.
 */
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

/** A component line. */
const ln = (over = {}) => ({
  itemName: "MS Sheet",
  kind: "material",
  quantity: 2,
  unit: "KG",
  ...over,
});

/**
 * A formula: 1 Bracket from 2 KG of MS Sheet.
 *
 * forQuantity is deliberately 1 here so that scaling bugs show up as a wrong
 * TOTAL rather than cancelling out; the batch cases set it explicitly.
 */
const bom = (over = {}) => ({
  name: "Bracket",
  outputItem: "Bracket",
  outputUnit: "NOS",
  forQuantity: 1,
  lines: [ln()],
  ...over,
});

const costs = { "MS Sheet": 40, Bracket: 0, Paint: 200, Screw: 1.5, Scrap: 10 };
const costOf = (name) => costs[name] ?? 0;

console.log("\n--- the three kinds of line ---");

test("Sigfa's ADDLESS becomes three named kinds", () => {
  assert.deepEqual(LINE_KINDS, ["material", "wastage", "byproduct"]);
  assert.equal(isLineKind("material"), true);
  assert.equal(isLineKind("byproduct"), true);
  assert.equal(isLineKind("Material"), false, "kinds are stored lower case");
  assert.equal(isLineKind(""), false);
  assert.equal(isLineKind(undefined), false);
});

test("an unknown or missing kind reads as material", () => {
  assert.equal(lineKind(undefined), "material");
  assert.equal(lineKind(""), "material");
  assert.equal(lineKind("nonsense"), "material");
  assert.equal(lineKind("wastage"), "wastage");
});

test("material and wastage are consumed; a by-product is received", () => {
  assert.equal(consumes("material"), true);
  assert.equal(consumes("wastage"), true, "an allowance is still issued out of stock");
  assert.equal(consumes("byproduct"), false);
  assert.equal(stockDirection("material"), "issue");
  assert.equal(stockDirection("wastage"), "issue");
  assert.equal(stockDirection("byproduct"), "receipt");
});

test("every kind has a label for the screen", () => {
  for (const kind of LINE_KINDS) {
    assert.equal(typeof LINE_KIND_LABELS[kind], "string");
    assert.ok(LINE_KIND_LABELS[kind].length > 0, `${kind} has no label`);
  }
});

console.log("\n--- scaling a formula to the batch being made ---");

test("a formula for one is multiplied straight through", () => {
  assert.equal(scaleQty(2, 5, 1), 10);
});

test("a formula written for a batch divides by that batch", () => {
  // The case that matters: components for 100 pieces, making 250.
  assert.equal(scaleQty(2, 250, 100), 5);
  assert.equal(scaleQty(7, 50, 100), 3.5);
});

test("scaling rounds to the three decimals the app works at", () => {
  // 1/3 of a batch of 1 -- an irrational quantity has to land somewhere.
  assert.equal(scaleQty(1, 1, 3), 0.333);
  assert.equal(scaleQty(10, 1, 7), 1.429);
});

test("a formula that makes nothing scales to nothing, not Infinity", () => {
  // The guard that stops a zero forQuantity reaching the ledger as Infinity
  // or NaN -- a NaN quantity saves silently and makes the stock report blank.
  assert.equal(scaleQty(2, 5, 0), 0);
  assert.equal(scaleQty(2, 5, -1), 0);
  assert.equal(Number.isFinite(scaleQty(2, 5, 0)), true);
});

test("a zero or junk output quantity scales to nothing", () => {
  assert.equal(scaleQty(2, 0, 1), 0);
  assert.equal(scaleQty(2, "abc", 1), 0);
  assert.equal(scaleQty("abc", 5, 1), 0);
});

console.log("\n--- what a formula must satisfy before it saves ---");

test("a well-formed formula has nothing wrong with it", () => {
  assert.deepEqual(bomProblems(bom()), []);
  assert.equal(isSaveable(bom()), true);
});

test("a formula needs a name, an output item and a quantity it makes", () => {
  assert.ok(bomProblems(bom({ name: "" })).some((p) => /needs a name/.test(p)));
  assert.ok(bomProblems(bom({ outputItem: "" })).some((p) => /which item/.test(p)));
  assert.ok(
    bomProblems(bom({ forQuantity: 0 })).some((p) => /make some quantity/.test(p))
  );
  assert.ok(
    bomProblems(bom({ forQuantity: -5 })).some((p) => /make some quantity/.test(p)),
    "a negative batch size is as unusable as a zero one"
  );
});

test("a formula needs at least one line, and one of them material", () => {
  assert.ok(bomProblems(bom({ lines: [] })).some((p) => /at least one line/.test(p)));
  // A formula of nothing but wastage and by-products makes its output out of
  // thin air.
  const noMaterial = bom({
    lines: [ln({ kind: "wastage" }), ln({ itemName: "Scrap", kind: "byproduct" })],
  });
  assert.ok(
    bomProblems(noMaterial).some((p) => /at least one material line/.test(p)),
    "wastage and by-products alone are not a formula"
  );
});

test("a line quantity of zero or less is refused", () => {
  assert.ok(
    bomProblems(bom({ lines: [ln({ quantity: 0 })] })).some((p) => /more than zero/.test(p))
  );
  assert.ok(
    bomProblems(bom({ lines: [ln({ quantity: -2 })] })).some((p) => /more than zero/.test(p))
  );
});

test("Sigfa: Item To Produce Can't be Raw Material", () => {
  const selfRef = bom({ lines: [ln({ itemName: "Bracket" })] });
  const problems = bomProblems(selfRef);
  assert.ok(
    problems.some((p) => /what this formula makes/.test(p)),
    "an item made of itself is the one-step cycle, and the explosion would never end"
  );
});

test("the self-reference check ignores case, like every other name join", () => {
  // Names join case-insensitively everywhere in this app (lib/uniqueName.mjs),
  // so "bracket" and "Bracket" are one item -- and a check that compared
  // exactly would let the cycle straight through.
  const sneaky = bom({ outputItem: "Bracket", lines: [ln({ itemName: "bracket" })] });
  assert.ok(bomProblems(sneaky).some((p) => /what this formula makes/.test(p)));
});

test("the output item cannot be its own by-product either", () => {
  // Not just material: an item listed as its own by-product would be issued
  // and received by the same entry.
  const asByproduct = bom({
    lines: [ln(), ln({ itemName: "Bracket", kind: "byproduct" })],
  });
  assert.ok(bomProblems(asByproduct).some((p) => /what this formula makes/.test(p)));
});

test("Sigfa: Don't Allow Duplicate Item In Production", () => {
  const twice = bom({ lines: [ln(), ln()] });
  const problems = bomProblems(twice);
  assert.ok(problems.some((p) => /already on line 1/.test(p)));
});

test("the same item as material AND as by-product is allowed", () => {
  // Recovering offcuts of the very material you cut. The duplicate check keys
  // on item + kind precisely so this legitimate pair is not refused.
  const recovered = bom({
    lines: [ln({ itemName: "MS Sheet" }), ln({ itemName: "MS Sheet", kind: "byproduct" })],
  });
  assert.deepEqual(bomProblems(recovered), []);
});

test("duplicate detection ignores case too", () => {
  const twice = bom({ lines: [ln({ itemName: "MS Sheet" }), ln({ itemName: "ms sheet" })] });
  assert.ok(bomProblems(twice).some((p) => /already on line 1/.test(p)));
});

test("a line with no item name is dropped, not reported", () => {
  // Blank rows are what a grid gives you; they are noise, not errors.
  const padded = bom({ lines: [ln(), { itemName: "", quantity: 0 }, { itemName: "   " }] });
  assert.equal(bomLines(padded).length, 1);
  assert.deepEqual(bomProblems(padded), []);
});

test("an unrecognised kind is reported rather than silently treated as material", () => {
  const odd = bom({ lines: [ln({ kind: "scrap" })] });
  assert.ok(bomProblems(odd).some((p) => /not a kind of line/.test(p)));
});

test("linesOfKind splits the formula the way a costing sheet reads it", () => {
  const mixed = bom({
    lines: [ln(), ln({ itemName: "Paint", kind: "wastage" }), ln({ itemName: "Scrap", kind: "byproduct" })],
  });
  assert.equal(linesOfKind(mixed, "material").length, 1);
  assert.equal(linesOfKind(mixed, "wastage").length, 1);
  assert.equal(linesOfKind(mixed, "byproduct").length, 1);
});

console.log("\n--- the graph: finding a sub-formula ---");

const bracket = bom({
  name: "Bracket",
  outputItem: "Bracket",
  forQuantity: 1,
  lines: [ln({ itemName: "Plate", quantity: 1 }), ln({ itemName: "Screw", quantity: 4 })],
});

const plate = bom({
  name: "Plate",
  outputItem: "Plate",
  forQuantity: 10,
  lines: [ln({ itemName: "MS Sheet", quantity: 25 })],
});

test("formulas index by the item they make", () => {
  const index = byOutputItem([bracket, plate]);
  assert.equal(bomsFor("Plate", index), 1);
  assert.equal(bomsFor("plate", index), 1, "looked up case-insensitively");
  assert.equal(bomsFor("Screw", index), 0);
  assert.equal(subBomFor("Plate", index).name, "Plate");
  assert.equal(subBomFor("Screw", index), null);
});

test("two formulas for one item refuse to be chosen between", () => {
  // Nothing stops a firm having two recipes for the same thing. Picking one
  // would make the explosion depend on Mongo's return order -- the same
  // quantity issued differently on different days with no change to anything.
  const alt = bom({ name: "Plate (import)", outputItem: "Plate", lines: [ln()] });
  const index = byOutputItem([plate, alt]);
  assert.equal(bomsFor("Plate", index), 2);
  assert.equal(subBomFor("Plate", index), null);
});

test("a formula with no output item is left out of the index", () => {
  const index = byOutputItem([bom({ outputItem: "" }), plate]);
  assert.equal(index.size, 1);
});

console.log("\n--- exploding, one level ---");

test("one level scales every line to the quantity being made", () => {
  const { lines } = explode({ bom: bracket, outputQuantity: 3, nested: false });
  assert.deepEqual(
    lines.map((l) => [l.itemName, l.quantity]),
    [["Plate", 3], ["Screw", 12]]
  );
});

test("exploding nothing explodes to nothing", () => {
  assert.deepEqual(explode({ bom: bracket, outputQuantity: 0 }).lines, []);
  assert.deepEqual(explode({ bom: bracket, outputQuantity: -1 }).lines, []);
  assert.deepEqual(explode({ bom: null, outputQuantity: 5 }).lines, []);
  assert.deepEqual(explode({}).lines, []);
});

test("a line that scales below the app's resolution is dropped", () => {
  // 1 unit per 100,000 made, making 1. Three decimals is the resolution
  // everything here works at; a 0.00001 issue row is noise in the ledger.
  const tiny = bom({ forQuantity: 100000, lines: [ln({ quantity: 1 })] });
  assert.deepEqual(explode({ bom: tiny, outputQuantity: 1 }).lines, []);
});

test("each exploded line records where it came from", () => {
  const { lines } = explode({ bom: bracket, outputQuantity: 1, nested: false });
  assert.equal(lines[0].depth, 0);
  assert.equal(lines[0].via, "Bracket");
  assert.deepEqual(lines[0].path, ["Bracket", "Plate"]);
});

console.log("\n--- exploding, nested (Sigfa's 'With Sub Formula') ---");

test("a component with a formula of its own is replaced by ITS components", () => {
  // 1 Bracket needs 1 Plate; the Plate formula makes 10 from 25 KG, so one
  // Plate is 2.5 KG. The sub-assembly itself must NOT appear -- it is made
  // and consumed in the same breath, and a receipt row for it would record
  // something that was never received.
  const { lines } = explode({
    bom: bracket,
    outputQuantity: 1,
    index: byOutputItem([bracket, plate]),
  });
  const byName = Object.fromEntries(lines.map((l) => [l.itemName, l.quantity]));
  assert.deepEqual(byName, { "MS Sheet": 2.5, Screw: 4 });
  assert.equal("Plate" in byName, false, "the sub-assembly is not a movement");
});

test("a sub-formula is scaled by the quantity NEEDED, not by the top output", () => {
  // The fixtures above cannot tell these apart: Bracket needs ONE Plate, so
  // the Plates needed and the Brackets made are the same number and a scale
  // taken from the wrong one reads correctly. Two Plates per Bracket is what
  // separates them -- and a hundredfold over-issue is exactly the shape this
  // mistake takes in a real tree.
  const twoPlates = bom({
    name: "Bracket",
    outputItem: "Bracket",
    forQuantity: 1,
    lines: [ln({ itemName: "Plate", quantity: 2 })],
  });
  const { lines } = explode({
    bom: twoPlates,
    outputQuantity: 3,
    index: byOutputItem([twoPlates, plate]),
  });
  const sheet = lines.find((l) => l.itemName === "MS Sheet");
  // 3 Brackets = 6 Plates; the Plate formula makes 10 from 25 KG, so 15 KG.
  assert.equal(sheet.quantity, 15);
  assert.notEqual(sheet.quantity, 7.5, "7.5 KG is three Plates -- the top quantity, not the need");
});

test("nesting compounds the batch sizes of both formulas", () => {
  // Making 4 Brackets: 4 Plates, which is 4/10 of a batch of 25 KG = 10 KG.
  const { lines } = explode({
    bom: bracket,
    outputQuantity: 4,
    index: byOutputItem([bracket, plate]),
  });
  const sheet = lines.find((l) => l.itemName === "MS Sheet");
  assert.equal(sheet.quantity, 10);
});

test("a nested line records its depth and the chain above it", () => {
  const { lines } = explode({
    bom: bracket,
    outputQuantity: 1,
    index: byOutputItem([bracket, plate]),
  });
  const sheet = lines.find((l) => l.itemName === "MS Sheet");
  assert.equal(sheet.depth, 1);
  assert.equal(sheet.via, "Plate", "named by the formula that contributed it");
  assert.deepEqual(sheet.path, ["Bracket", "Plate", "MS Sheet"]);
});

test("nested: false stops at the first level even when sub-formulas exist", () => {
  const { lines } = explode({
    bom: bracket,
    outputQuantity: 1,
    index: byOutputItem([bracket, plate]),
    nested: false,
  });
  assert.ok(lines.some((l) => l.itemName === "Plate"));
  assert.equal(lines.some((l) => l.itemName === "MS Sheet"), false);
});

test("a by-product is never expanded into what IT is made of", () => {
  // Expanding it would claim you also produced the things it is made of,
  // which is backwards -- you produced the by-product itself.
  const withBy = bom({
    name: "Cut",
    outputItem: "Cut Part",
    forQuantity: 1,
    lines: [ln({ itemName: "MS Sheet", quantity: 3 }), ln({ itemName: "Plate", kind: "byproduct", quantity: 1 })],
  });
  const { lines } = explode({
    bom: withBy,
    outputQuantity: 1,
    index: byOutputItem([withBy, plate]),
  });
  const plateLine = lines.find((l) => l.itemName === "Plate");
  assert.ok(plateLine, "the by-product stays a by-product");
  assert.equal(plateLine.kind, "byproduct");
  assert.equal(lines.some((l) => l.itemName === "MS Sheet" && l.depth === 1), false);
});

test("a sub-formula's own wastage and by-products come through", () => {
  // If you are implicitly making the sub-assembly, you are implicitly
  // producing its offcuts too.
  const plateWithScrap = bom({
    name: "Plate",
    outputItem: "Plate",
    forQuantity: 10,
    lines: [
      ln({ itemName: "MS Sheet", quantity: 25 }),
      ln({ itemName: "Scrap", kind: "byproduct", quantity: 2 }),
    ],
  });
  const { lines } = explode({
    bom: bracket,
    outputQuantity: 10,
    index: byOutputItem([bracket, plateWithScrap]),
  });
  const scrap = lines.find((l) => l.itemName === "Scrap");
  assert.ok(scrap, "the sub-formula's by-product reaches the entry");
  assert.equal(scrap.kind, "byproduct");
  assert.equal(scrap.quantity, 2, "10 Brackets = 10 Plates = one batch = 2 Scrap");
});

test("an ambiguous component is taken as raw, and says so", () => {
  const alt = bom({ name: "Plate (import)", outputItem: "Plate", lines: [ln()] });
  const { lines, warnings } = explode({
    bom: bracket,
    outputQuantity: 1,
    index: byOutputItem([plate, alt]),
  });
  assert.ok(lines.some((l) => l.itemName === "Plate"), "left as a component");
  assert.ok(
    warnings.some((w) => /more than one formula/.test(w)),
    "wrong in a visible way rather than a silent one"
  );
});

console.log("\n--- the graph: loops ---");

test("mutual recursion is caught and does not blow the stack", () => {
  // A made of B, B made of A. bomProblems blocks the one-step case at save
  // time; this is the pair that only appears once both are read together, and
  // nothing stops a user creating them one at a time.
  const a = bom({ name: "A", outputItem: "A", lines: [ln({ itemName: "B", quantity: 1 })] });
  const b = bom({ name: "B", outputItem: "B", lines: [ln({ itemName: "A", quantity: 1 })] });
  const { lines, warnings } = explode({
    bom: a,
    outputQuantity: 1,
    index: byOutputItem([a, b]),
  });
  assert.ok(warnings.some((w) => /loops back on itself/.test(w)));
  assert.ok(lines.some((l) => l.itemName === "A"), "the loop point becomes a leaf");
});

test("the loop warning names the whole chain, not just the item", () => {
  const a = bom({ name: "A", outputItem: "A", lines: [ln({ itemName: "B", quantity: 1 })] });
  const b = bom({ name: "B", outputItem: "B", lines: [ln({ itemName: "C", quantity: 1 })] });
  const c = bom({ name: "C", outputItem: "C", lines: [ln({ itemName: "A", quantity: 1 })] });
  const { warnings } = explode({
    bom: a,
    outputQuantity: 1,
    index: byOutputItem([a, b, c]),
  });
  assert.ok(
    warnings.some((w) => w.includes("A > B > C > A")),
    `the chain is what makes a three-way loop findable; got ${JSON.stringify(warnings)}`
  );
});

test("the loop check ignores case, like every other name join here", () => {
  // Names join case-insensitively throughout this app (lib/uniqueName.mjs),
  // so "A" and "a" are one item. A case-sensitive check does not hang -- it
  // just goes one level further round the loop before noticing, which shows
  // up as a chain that has visited the same item twice.
  const a = bom({ name: "A", outputItem: "A", forQuantity: 1, lines: [ln({ itemName: "b", quantity: 1 })] });
  const b = bom({ name: "B", outputItem: "B", forQuantity: 1, lines: [ln({ itemName: "a", quantity: 1 })] });
  const { warnings } = explode({
    bom: a,
    outputQuantity: 1,
    index: byOutputItem([a, b]),
  });
  assert.ok(
    warnings.some((w) => w.includes("A > b > a loops")),
    `the loop must be caught on the first return, got ${JSON.stringify(warnings)}`
  );
  assert.equal(
    warnings.some((w) => w.includes("A > b > a > b")),
    false,
    "a chain that visits b twice means the first return was missed"
  );
});

test("the same item twice on DIFFERENT branches is not a loop", () => {
  // The check must look at the chain above a line, not at everything already
  // seen -- a screw used by two sub-assemblies is ordinary, and treating it
  // as a loop would stop expanding half the tree.
  const top = bom({
    name: "Top",
    outputItem: "Top",
    forQuantity: 1,
    lines: [ln({ itemName: "Left", quantity: 1 }), ln({ itemName: "Right", quantity: 1 })],
  });
  const left = bom({ name: "Left", outputItem: "Left", forQuantity: 1, lines: [ln({ itemName: "Screw", quantity: 2 })] });
  const right = bom({ name: "Right", outputItem: "Right", forQuantity: 1, lines: [ln({ itemName: "Screw", quantity: 3 })] });
  const { lines, warnings } = explode({
    bom: top,
    outputQuantity: 1,
    index: byOutputItem([top, left, right]),
  });
  assert.deepEqual(warnings, [], "two branches using one screw is not a cycle");
  assert.equal(lines.filter((l) => l.itemName === "Screw").length, 2);
});

test("a tree deeper than the limit stops and reports it", () => {
  // Not what prevents infinite recursion -- the loop check does that. This
  // keeps a legitimately deep tree from producing a page nobody can read.
  const chain = [];
  for (let i = 0; i < 20; i += 1) {
    chain.push(
      bom({
        name: `L${i}`,
        outputItem: `L${i}`,
        forQuantity: 1,
        lines: [ln({ itemName: `L${i + 1}`, quantity: 1 })],
      })
    );
  }
  const { truncated, warnings, maxDepthSeen } = explode({
    bom: chain[0],
    outputQuantity: 1,
    index: byOutputItem(chain),
    maxDepth: 3,
  });
  assert.equal(truncated, true);
  assert.ok(warnings.some((w) => /deeper than 3 levels/.test(w)));
  assert.equal(maxDepthSeen, 3);
});

test("the default depth limit is a number, and generous", () => {
  assert.equal(typeof MAX_DEPTH, "number");
  assert.ok(MAX_DEPTH >= 5, "a real assembly tree is several levels deep");
});

console.log("\n--- merging (Sigfa: Raw Material Merged In Formula Successfully.) ---");

test("the same item from two branches becomes one line", () => {
  const merged = mergeLines([
    { itemName: "Screw", kind: "material", quantity: 2, depth: 1, path: ["T", "L", "Screw"] },
    { itemName: "Screw", kind: "material", quantity: 3, depth: 2, path: ["T", "R", "Screw"] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].quantity, 5);
  assert.equal(merged[0].mergedFrom, 2);
  assert.equal(merged[0].depth, 1, "the shallowest, so the tree still reads top-down");
  assert.equal(merged[0].paths.length, 2, "both origins kept, so a total can be traced");
});

test("merging ADDS -- it does not take the last value", () => {
  // The mistake that reads correctly in every test where the two quantities
  // happen to be equal. Deliberately unequal, and asserted on the sum.
  const merged = mergeLines([
    { itemName: "Screw", kind: "material", quantity: 2 },
    { itemName: "Screw", kind: "material", quantity: 7 },
  ]);
  assert.equal(merged[0].quantity, 9);
  assert.notEqual(merged[0].quantity, 7, "the last value is not the answer");
  assert.notEqual(merged[0].quantity, 2, "nor the first");
});

test("the same item in different kinds stays two lines", () => {
  const merged = mergeLines([
    { itemName: "MS Sheet", kind: "material", quantity: 10 },
    { itemName: "MS Sheet", kind: "byproduct", quantity: 1 },
  ]);
  assert.equal(merged.length, 2, "issued 10 and received 1 back is what happened");
});

test("merging ignores case, and keeps the first spelling", () => {
  const merged = mergeLines([
    { itemName: "MS Sheet", kind: "material", quantity: 1 },
    { itemName: "ms sheet", kind: "material", quantity: 2 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].quantity, 3);
  assert.equal(merged[0].itemName, "MS Sheet");
});

test("merged lines come out materials, then wastage, then by-products", () => {
  const merged = mergeLines([
    { itemName: "Scrap", kind: "byproduct", quantity: 1 },
    { itemName: "Zinc", kind: "wastage", quantity: 1 },
    { itemName: "Screw", kind: "material", quantity: 1 },
    { itemName: "Bolt", kind: "material", quantity: 1 },
  ]);
  assert.deepEqual(
    merged.map((l) => [l.kind, l.itemName]),
    [["material", "Bolt"], ["material", "Screw"], ["wastage", "Zinc"], ["byproduct", "Scrap"]]
  );
});

test("merging float quantities does not leave dust", () => {
  const merged = mergeLines([
    { itemName: "Paint", kind: "material", quantity: 0.1 },
    { itemName: "Paint", kind: "material", quantity: 0.2 },
  ]);
  assert.equal(merged[0].quantity, 0.3, "0.1 + 0.2 must not be 0.30000000000000004");
});

test("merging drops nameless lines", () => {
  assert.deepEqual(mergeLines([{ itemName: "", quantity: 5 }]), []);
  assert.deepEqual(mergeLines([]), []);
});

console.log("\n--- costing, at today's prices ---");

test("the cost is material plus wastage, LESS the by-product recovered", () => {
  // The sign is the whole point of Sigfa's ADDLESS column. Getting it
  // backwards is wrong by twice the by-product -- a plausible number.
  const { materialValue, wastageValue, byproductValue, netCost } = bomCost({
    lines: [
      { itemName: "MS Sheet", kind: "material", quantity: 10 },  // 400
      { itemName: "Paint", kind: "wastage", quantity: 0.5 },     // 100
      { itemName: "Scrap", kind: "byproduct", quantity: 3 },     //  30 credit
    ],
    outputQuantity: 1,
    costOf,
  });
  assert.equal(materialValue, 400);
  assert.equal(wastageValue, 100);
  assert.equal(byproductValue, 30);
  assert.equal(netCost, 470, "400 + 100 - 30");
  assert.notEqual(netCost, 530, "a by-product is a credit, not a cost");
});

test("the per-unit cost divides by what was made", () => {
  const { costPerUnit } = bomCost({
    lines: [{ itemName: "MS Sheet", kind: "material", quantity: 10 }],
    outputQuantity: 4,
    costOf,
  });
  assert.equal(costPerUnit, 100, "400 over 4");
});

test("a per-unit cost of nothing made is zero, not Infinity", () => {
  const { costPerUnit } = bomCost({
    lines: [{ itemName: "MS Sheet", kind: "material", quantity: 10 }],
    outputQuantity: 0,
    costOf,
  });
  assert.equal(costPerUnit, 0);
  assert.equal(Number.isFinite(costPerUnit), true);
});

test("an unpriced component is NAMED rather than counted as free", () => {
  // The honest part. An item with no cost in the master contributes nothing,
  // so a formula half of whose lines are unpriced gives a confident-looking
  // number that is simply too low.
  const { netCost, missingCosts, costedLines, totalLines } = bomCost({
    lines: [
      { itemName: "MS Sheet", kind: "material", quantity: 10 },
      { itemName: "Mystery", kind: "material", quantity: 5 },
    ],
    outputQuantity: 1,
    costOf,
  });
  assert.equal(netCost, 400);
  assert.deepEqual(missingCosts, ["Mystery"]);
  assert.equal(costedLines, 1);
  assert.equal(totalLines, 2);
});

test("an item with an explicit zero cost counts as unpriced", () => {
  // `Bracket` is 0 in the fixture. A zero is indistinguishable from "nobody
  // has filled this in", and treating it as a real price is the version that
  // lies.
  const { missingCosts } = bomCost({
    lines: [{ itemName: "Bracket", kind: "material", quantity: 1 }],
    outputQuantity: 1,
    costOf,
  });
  assert.deepEqual(missingCosts, ["Bracket"]);
});

test("the same unpriced item twice is named once", () => {
  const { missingCosts, costedLines } = bomCost({
    lines: [
      { itemName: "Mystery", kind: "material", quantity: 1 },
      { itemName: "Mystery", kind: "wastage", quantity: 2 },
    ],
    outputQuantity: 1,
    costOf,
  });
  assert.deepEqual(missingCosts, ["Mystery"]);
  assert.equal(costedLines, 0, "but both LINES are uncosted");
});

test("costing with no rate source at all does not throw", () => {
  const { netCost, missingCosts } = bomCost({
    lines: [{ itemName: "MS Sheet", kind: "material", quantity: 10 }],
    outputQuantity: 1,
  });
  assert.equal(netCost, 0);
  assert.deepEqual(missingCosts, ["MS Sheet"]);
});

test("money rounds per LINE, so a voucher's total matches its own lines", () => {
  // Not a nicety. `toProductionLines` stores round2(quantity x rate) on every
  // line, and the voucher prints both those amounts and this total. If the
  // total rounded the SUM instead, the printed lines would not add up to the
  // printed total -- off by a paisa, on a document a client reconciles by
  // hand.
  //
  // 0.125 is the case that separates them: two lines round to 0.13 each
  // (0.26), while the unrounded sum of 0.25 rounds to 0.25.
  const lines = [
    { itemName: "Pin", kind: "material", quantity: 1 },
    { itemName: "Clip", kind: "material", quantity: 1 },
  ];
  const rate = () => 0.125;
  const { materialValue, netCost } = bomCost({ lines, outputQuantity: 1, costOf: rate });
  assert.equal(materialValue, 0.26);
  assert.notEqual(materialValue, 0.25, "rounding the sum instead of the lines");

  const frozen = toProductionLines({ lines, costOf: rate });
  const summed = frozen.reduce((t, l) => t + l.amount, 0);
  assert.equal(
    Math.round(summed * 100) / 100,
    netCost,
    "the stored line amounts must add up to the stored total"
  );
});

test("money is rounded to paise", () => {
  const { netCost } = bomCost({
    lines: [{ itemName: "Screw", kind: "material", quantity: 3 }],
    outputQuantity: 1,
    costOf,
  });
  assert.equal(netCost, 4.5);
});

console.log("\n--- the stock ledger key ---");

test("a production entry's ledger key is NOT a bare number", () => {
  // The silent, permanent one. ItemLedger.invoiceNo is a string shared by
  // every voucher type, and writing rows deletes the existing rows for that
  // key first (lib/itemLedger.mjs). Entry 5 saving under "5" would destroy
  // invoice 5's stock history, and deleting it later would destroy it again.
  const key = productionLedgerKey(5);
  assert.equal(key, "PRD-5");
  assert.notEqual(key, "5");
  assert.notEqual(key, 5);
  assert.equal(typeof key, "string");
});

test("the production prefix cannot collide with an invoice number", () => {
  // Invoice keys are digits, so any non-digit first character is enough -- but
  // assert the actual property rather than the literal, so changing the
  // prefix to something unsafe fails here.
  assert.equal(/^[0-9]/.test(PRODUCTION_PREFIX), false);
  assert.ok(PRODUCTION_PREFIX.length > 0);
  for (const n of [1, 5, 99, 1000]) {
    assert.equal(/^[0-9]+$/.test(productionLedgerKey(n)), false, `${n} produced a digits-only key`);
  }
});

test("a production key is recognisable as one", () => {
  assert.equal(isProductionLedgerKey(productionLedgerKey(12)), true);
  assert.equal(isProductionLedgerKey("12"), false);
  assert.equal(isProductionLedgerKey(""), false);
  assert.equal(isProductionLedgerKey(undefined), false);
});

console.log("\n--- what a production entry moves ---");

test("the finished item is received; materials are issued", () => {
  const { issues, receipts } = productionMovements({
    outputItem: "Bracket",
    outputQuantity: 4,
    lines: [
      { itemName: "MS Sheet", kind: "material", quantity: 10 },
      { itemName: "Zinc", kind: "wastage", quantity: 1 },
    ],
  });
  assert.deepEqual(receipts, [{ itemName: "Bracket", quantity: 4 }]);
  assert.deepEqual(issues, [
    { itemName: "MS Sheet", quantity: 10 },
    { itemName: "Zinc", quantity: 1 },
  ]);
});

test("a by-product is received alongside the finished item", () => {
  const { issues, receipts } = productionMovements({
    outputItem: "Bracket",
    outputQuantity: 1,
    lines: [
      { itemName: "MS Sheet", kind: "material", quantity: 10 },
      { itemName: "Scrap", kind: "byproduct", quantity: 2 },
    ],
  });
  assert.deepEqual(receipts, [
    { itemName: "Bracket", quantity: 1 },
    { itemName: "Scrap", quantity: 2 },
  ]);
  assert.deepEqual(issues, [{ itemName: "MS Sheet", quantity: 10 }]);
});

test("an item on both sides stays on both sides", () => {
  // Issuing 100 and receiving 4 back as offcuts is what happened. One net row
  // for 96 would hide it, and the ledger is read to answer "what happened".
  const { issues, receipts } = productionMovements({
    outputItem: "Cut Part",
    outputQuantity: 1,
    lines: [
      { itemName: "MS Sheet", kind: "material", quantity: 100 },
      { itemName: "MS Sheet", kind: "byproduct", quantity: 4 },
    ],
  });
  assert.deepEqual(issues, [{ itemName: "MS Sheet", quantity: 100 }]);
  assert.deepEqual(receipts, [
    { itemName: "Cut Part", quantity: 1 },
    { itemName: "MS Sheet", quantity: 4 },
  ]);
});

test("the same item twice on the same side is summed", () => {
  const { issues } = productionMovements({
    outputItem: "X",
    outputQuantity: 1,
    lines: [
      { itemName: "Screw", kind: "material", quantity: 2 },
      { itemName: "Screw", kind: "material", quantity: 3 },
    ],
  });
  assert.deepEqual(issues, [{ itemName: "Screw", quantity: 5 }]);
});

test("the movements come out in a stable order", () => {
  // Stock rows are written in this order, so an unordered result means two
  // saves of the same entry produce the ledger in different orders -- and the
  // running balance column is derived from the previous row.
  const { issues, receipts } = productionMovements({
    outputItem: "Widget",
    outputQuantity: 1,
    lines: [
      { itemName: "Zinc", kind: "material", quantity: 1 },
      { itemName: "Brass", kind: "material", quantity: 1 },
      { itemName: "Alloy", kind: "material", quantity: 1 },
      { itemName: "Swarf", kind: "byproduct", quantity: 1 },
    ],
  });
  assert.deepEqual(issues.map((r) => r.itemName), ["Alloy", "Brass", "Zinc"]);
  assert.deepEqual(receipts.map((r) => r.itemName), ["Swarf", "Widget"]);
});

test("the output item appears even with no lines at all", () => {
  const { receipts } = productionMovements({ outputItem: "Bracket", outputQuantity: 2 });
  assert.deepEqual(receipts, [{ itemName: "Bracket", quantity: 2 }]);
});

test("zero and nameless movements are left out", () => {
  const { issues, receipts } = productionMovements({
    outputItem: "",
    outputQuantity: 5,
    lines: [
      { itemName: "Screw", kind: "material", quantity: 0 },
      { itemName: "", kind: "material", quantity: 5 },
    ],
  });
  assert.deepEqual(issues, []);
  assert.deepEqual(receipts, [], "an output with no name is not a receipt");
});

console.log("\n--- short stock: a warning, not a block ---");

test("a shortfall is reported with what is needed and what is there", () => {
  const short = shortfalls({
    issues: [{ itemName: "MS Sheet", quantity: 10 }],
    stockOf: () => 4,
  });
  assert.deepEqual(short, [{ itemName: "MS Sheet", need: 10, have: 4, short: 6 }]);
});

test("enough stock reports nothing", () => {
  assert.deepEqual(
    shortfalls({ issues: [{ itemName: "MS Sheet", quantity: 10 }], stockOf: () => 10 }),
    []
  );
});

test("float dust is not a shortage", () => {
  // 10 on hand against a need of 10.00000001, which is what three-decimal
  // arithmetic on a scaled formula produces. Without the epsilon every
  // fractional formula warns on every save and the warning stops meaning
  // anything.
  const short = shortfalls({
    issues: [{ itemName: "MS Sheet", quantity: 10 + QTY_EPSILON / 2 }],
    stockOf: () => 10,
  });
  assert.deepEqual(short, []);
});

test("a genuine shortage just above the epsilon IS reported", () => {
  // The other side of the same boundary -- an epsilon wide enough to swallow
  // real shortages would be worse than none.
  const short = shortfalls({
    issues: [{ itemName: "MS Sheet", quantity: 11 }],
    stockOf: () => 10,
  });
  assert.equal(short.length, 1);
  assert.equal(short[0].short, 1);
});

test("an item with no stock at all is short by the whole quantity", () => {
  const short = shortfalls({ issues: [{ itemName: "New Item", quantity: 3 }] });
  assert.deepEqual(short, [{ itemName: "New Item", need: 3, have: 0, short: 3 }]);
});

console.log("\n--- freezing the lines onto the voucher ---");

test("production lines carry the rate and amount of the day", () => {
  // The formula stores no rate on purpose; a voucher is a record of what a
  // thing cost on the day it happened.
  const lines = toProductionLines({
    lines: [{ itemName: "MS Sheet", kind: "material", quantity: 10, unit: "KG", depth: 1, via: "Plate" }],
    costOf,
  });
  assert.equal(lines[0].rate, 40);
  assert.equal(lines[0].amount, 400);
  assert.equal(lines[0].unit, "KG");
  assert.equal(lines[0].depth, 1);
  assert.equal(lines[0].via, "Plate");
});

test("an unpriced line is frozen at zero, not left undefined", () => {
  // Mongoose would drop an undefined, and the voucher would then read its
  // own amount back as missing rather than as nil.
  const [line] = toProductionLines({
    lines: [{ itemName: "Mystery", kind: "material", quantity: 5 }],
    costOf,
  });
  assert.equal(line.rate, 0);
  assert.equal(line.amount, 0);
});

test("a voucher line's quantity is rounded before the amount is worked out", () => {
  // The form lets the exploded lines be edited by hand, so what arrives here
  // is whatever was typed -- a string, or more decimals than the app stores.
  // Rounding after multiplying would store a quantity and an amount that
  // disagree with each other.
  const [line] = toProductionLines({
    lines: [{ itemName: "MS Sheet", kind: "material", quantity: "10.0005" }],
    costOf,
  });
  assert.equal(line.quantity, 10.001);
  assert.equal(line.amount, 400.04, "40 x 10.001, not 40 x 10.0005");
});

test("a junk quantity becomes zero rather than NaN", () => {
  // A NaN saves to Mongo without complaint and makes every figure derived
  // from it blank, which is the hardest kind of bad row to find.
  const [line] = toProductionLines({
    lines: [{ itemName: "MS Sheet", kind: "material", quantity: "abc" }],
    costOf,
  });
  assert.equal(line.quantity, 0);
  assert.equal(line.amount, 0);
});

test("the merged paths survive onto the voucher as text", () =>{
  const [line] = toProductionLines({
    lines: [{ itemName: "Screw", kind: "material", quantity: 5, paths: ["T > L > Screw", "T > R > Screw"] }],
    costOf,
  });
  assert.equal(line.source, "T > L > Screw | T > R > Screw");
});

test("an explosion flows end to end into voucher lines", () => {
  const index = byOutputItem([bracket, plate]);
  const { lines } = explode({ bom: bracket, outputQuantity: 4, index });
  const frozen = toProductionLines({ lines: mergeLines(lines), costOf });
  const sheet = frozen.find((l) => l.itemName === "MS Sheet");
  assert.equal(sheet.quantity, 10);
  assert.equal(sheet.amount, 400);
});

console.log("\n--- what a production entry must satisfy ---");

const entry = (over = {}) => ({
  date: new Date("2026-10-11"),
  outputItem: "Bracket",
  outputQuantity: 4,
  lines: [{ itemName: "MS Sheet", kind: "material", quantity: 10 }],
  ...over,
});

test("a well-formed entry has nothing wrong with it", () => {
  assert.deepEqual(productionProblems(entry()), []);
});

test("an entry needs a date, an item and a quantity", () => {
  assert.ok(productionProblems(entry({ date: null })).some((p) => /needs a date/.test(p)));
  assert.ok(productionProblems(entry({ outputItem: "" })).some((p) => /which item/.test(p)));
  assert.ok(
    productionProblems(entry({ outputQuantity: 0 })).some((p) => /more than zero/.test(p))
  );
});

test("an entry needs at least one line", () => {
  assert.ok(productionProblems(entry({ lines: [] })).some((p) => /at least one material/.test(p)));
});

test("a line consuming nothing is refused on the voucher", () => {
  const zero = entry({ lines: [{ itemName: "MS Sheet", kind: "material", quantity: 0 }] });
  assert.ok(productionProblems(zero).some((p) => /more than zero/.test(p)));
});

test("the self-reference rule is re-checked on the voucher", () => {
  // The form lets the exploded lines be edited by hand before saving, so it
  // can reintroduce exactly what bomProblems refused.
  const selfRef = entry({ lines: [{ itemName: "Bracket", kind: "material", quantity: 1 }] });
  assert.ok(
    productionProblems(selfRef).some((p) => /what this entry produced/.test(p)),
    "a check only on the formula is a check the form can walk around"
  );
});

console.log("\n--- referential guards ---");

test("Sigfa's item-delete check includes Fmast, and so does this one", () => {
  const boms = [bracket, plate];
  assert.ok(/uses it/.test(itemDeleteBlockedReason("Screw", boms)));
  assert.ok(/makes it/.test(itemDeleteBlockedReason("Plate", boms)));
  assert.equal(itemDeleteBlockedReason("Unrelated", boms), null);
  assert.equal(itemDeleteBlockedReason("", boms), null);
  assert.equal(itemDeleteBlockedReason("Screw", []), null);
});

test("the delete guard names the formula, so the user can go and fix it", () => {
  assert.ok(itemDeleteBlockedReason("Screw", [bracket]).includes("Bracket"));
});

test("the delete guard ignores case", () => {
  assert.ok(itemDeleteBlockedReason("screw", [bracket]));
});

test("deleting a used formula is a notice, not a refusal", () => {
  // Production entries snapshot their own lines, so nothing breaks -- but it
  // is worth saying what is being given up.
  assert.equal(bomDeleteNotice(bracket, 0), null);
  const notice = bomDeleteNotice(bracket, 3);
  assert.ok(/3 production entries/.test(notice));
  assert.ok(/keep the materials they recorded/.test(notice));
  assert.ok(/1 production entry\b/.test(bomDeleteNotice(bracket, 1)), "singular reads properly");
});

test("a formula summarises itself for a list", () => {
  const summary = bomSummary(bracket);
  assert.ok(summary.includes("Bracket"));
  assert.ok(/2 materials/.test(summary));
});

test("the summary counts materials apart from the rest", () => {
  // Every line of `bracket` is material, so a count of ALL lines reads the
  // same there. A mixed formula is what separates them.
  const mixed = bom({
    lines: [ln(), ln({ itemName: "Zinc", kind: "wastage" }), ln({ itemName: "Scrap", kind: "byproduct" })],
  });
  const summary = bomSummary(mixed);
  assert.ok(/1 material\b/.test(summary), `got ${summary}`);
  assert.ok(/2 other/.test(summary), `got ${summary}`);
});

console.log("\n--- wiring: the pieces have to be joined up ---");

test("bom.mjs imports its quantity rounding rather than redefining it", () => {
  // An order pending by 0.0005 and a production entry consuming 0.0005 more
  // than it has are the same bug. Two rounding functions is how they drift.
  const src = read("../lib/bom.mjs");
  assert.ok(
    /import \{[^}]*roundQty[^}]*\} from "\.\/orderStatus\.mjs"/s.test(src),
    "roundQty must come from orderStatus.mjs"
  );
  assert.equal(roundQty(0.1 + 0.2), 0.3);
});

test("bom.mjs stays free of Mongoose", () => {
  const src = read("../lib/bom.mjs");
  assert.equal(/from ["']mongoose["']/.test(src), false);
  assert.equal(/\.\.\/models\//.test(src), false, "a pure module cannot import a model");
});

test("both models declare every field the rules write", () => {
  // Mongoose strict mode silently DROPS undeclared fields. This project has
  // lost an afternoon to that six times: gstAmount, the buyer block,
  // hsnTotals, uqc, the order back-reference, orderDate.
  const bomSrc = read("../models/bomModel.js");
  for (const field of ["itemName", "kind", "quantity", "unit", "outputItem", "forQuantity", "hold", "editCount"]) {
    assert.ok(new RegExp(`${field}\\s*:`).test(bomSrc), `bomModel is missing ${field}`);
  }
  const prodSrc = read("../models/productionModel.js");
  for (const field of [
    "docNo", "bomName", "outputItem", "outputQuantity", "outputUnit",
    "itemName", "kind", "quantity", "rate", "amount", "depth", "via", "source",
    "materialValue", "wastageValue", "byproductValue", "netCost", "costPerUnit",
    "missingCosts", "warnings", "partyName",
  ]) {
    assert.ok(new RegExp(`${field}\\s*:`).test(prodSrc), `productionModel is missing ${field}`);
  }
});

test("the kind enum on both models comes from LINE_KINDS, not a literal", () => {
  // A model whose enum is spelled out by hand is a model that accepts a kind
  // the rules reject, or rejects one they produce.
  for (const model of ["../models/bomModel.js", "../models/productionModel.js"]) {
    const src = read(model);
    assert.ok(/LINE_KINDS/.test(src), `${model} should use LINE_KINDS`);
    assert.ok(/from ["']\.\.\/lib\/bom\.mjs["']/.test(src), `${model} should import it from lib/bom.mjs`);
  }
});

test("both models are scoped to a firm and unique per firm", () => {
  for (const model of ["../models/bomModel.js", "../models/productionModel.js"]) {
    const src = read(model);
    assert.ok(/tenantPlugin/.test(src), `${model} is not tenant-scoped`);
    assert.ok(
      /index\(\s*\{\s*companyId:\s*1[^)]*\},\s*\{\s*unique:\s*true/s.test(src),
      `${model} has no per-firm unique index`
    );
  }
});

test("the formula's unique index is on the NAME, per firm", () => {
  const src = read("../models/bomModel.js");
  assert.ok(
    /index\(\s*\{\s*companyId:\s*1,\s*name:\s*1\s*\},\s*\{\s*unique:\s*true/.test(src),
    "two formulas of one name in a firm is the Duplicate BOM Name case"
  );
});

test("the item-delete guard has an index to use", () => {
  // Without it the guard scans every formula on every item deletion.
  const src = read("../models/bomModel.js");
  assert.ok(/"lines\.itemName"/.test(src));
});

console.log("\n--- wiring: permissions, wipes and guards ---");

test("every new API route demands a permission -- none falls through", () => {
  // The default at the bottom of PATH_RULES is `setup:write`, so an unlisted
  // route is owner-only rather than wide open. That is the safe failure, but
  // it would still lock out the accountant whose job this is, silently.
  const ROUTES = {
    "/api/bom": "master:read",
    "/api/get-bom": "master:read",
    "/api/bom-explode": "master:read",
    "/api/bom-add": "master:write",
    "/api/bom-alter": "master:write",
    "/api/delete-bom": "master:write",
    "/api/production": "voucher:read",
    "/api/get-production": "voucher:read",
    "/api/production-add": "voucher:write",
    "/api/delete-production": "voucher:write",
    "/api/next-production-no": "voucher:write",
  };
  for (const [path, expected] of Object.entries(ROUTES)) {
    assert.equal(permissionForPath(path), expected, `${path} resolves to the wrong permission`);
  }
});

test("a longer route name does not inherit the shorter rule above it", () => {
  // "/api/bom" and "/api/bom-add" is exactly the nesting that would break if
  // prefix matching stopped requiring a "/" after the prefix -- and it would
  // break in the dangerous direction, making a write reachable with read.
  assert.notEqual(permissionForPath("/api/bom-add"), permissionForPath("/api/bom"));
  assert.notEqual(
    permissionForPath("/api/production-add"),
    permissionForPath("/api/production")
  );
});

test("a biller can read a formula but change nothing, and produce nothing", () => {
  // Sigfa puts BOMAlter in the same user-right list as ItemAlter and ACCAlter,
  // so changing a recipe is master work. Production MOVES STOCK, so it is
  // voucher work -- which a biller does not have at all.
  assert.equal(canAccessPath("biller", "/api/bom"), true);
  assert.equal(canAccessPath("biller", "/api/bom-explode"), true);
  assert.equal(canAccessPath("biller", "/api/bom-add"), false);
  assert.equal(canAccessPath("biller", "/api/production"), false);
  assert.equal(canAccessPath("biller", "/api/production-add"), false);
  assert.equal(canAccessPath("accountant", "/api/production-add"), true);
  assert.equal(canAccessPath("owner", "/api/delete-production"), true);
});

test("the pages are covered too, not just the routes", () => {
  assert.equal(canAccessPath("biller", "/bom"), true);
  assert.equal(canAccessPath("biller", "/bomadd"), false);
  assert.equal(canAccessPath("biller", "/production"), false);
});

test("a formula survives a transaction clear; a production entry does not", () => {
  // The distinction clearData.mjs exists to keep straight. A formula is what
  // you typed in before going live -- losing two hundred of them to a wipe
  // meant for the books is not a migration step anybody would forgive. A
  // production entry moved stock, and its rows are in itemledgers, so leaving
  // it behind would strand vouchers claiming movements that are gone.
  assert.ok(MASTER_COLLECTIONS.includes("boms"), "boms must be a master");
  assert.ok(
    TRANSACTION_COLLECTIONS.includes("productions"),
    "productions must be cleared with the books"
  );
  assert.ok(TRANSACTION_COLLECTIONS.includes("itemledgers"));
  assert.deepEqual(
    TRANSACTION_COLLECTIONS.filter((c) => MASTER_COLLECTIONS.includes(c)),
    [],
    "a collection in both lists turns the transaction clear into the full wipe"
  );
});

test("delete-item asks the formulas before removing an item", () => {
  // Sigfa's own check: "Check From Salpur1,Sporder1,Quot1,Fmast,PrList,Itmast".
  const src = read("../app/api/delete-item/route.js");
  assert.ok(/itemDeleteBlockedReason/.test(src), "the BOM guard is not wired in");
  assert.ok(/from ["']@\/models\/bomModel["']/.test(src), "delete-item cannot see the formulas");
  // Both halves of the question, or an item a formula MAKES stays deletable.
  assert.ok(/outputItem/.test(src) && /lines\.itemName/.test(src));
});

test("delete-item still checks invoices and stock as well", () => {
  // Adding a guard must not have replaced one.
  const src = read("../app/api/delete-item/route.js");
  assert.ok(/items\.name/.test(src), "the invoice guard went missing");
  assert.ok(/ItemLedger\.findOne/.test(src), "the stock guard went missing");
});

test("the stock writer uses the prefixed key, not the bare number", () => {
  // Belt and braces over the unit tests above: this asserts the CALL SITE
  // builds its key from the shared helper, because a writer that formatted
  // the key inline would pass every test in the section above and still
  // destroy invoice 5's stock history.
  //
  // The helper is now `stockLedgerKey(kind, docNo)` -- each of the three
  // stock vouchers has its own prefix, which is what lets them share a
  // collection and still number independently.
  const src = read("../lib/itemLedger.mjs");
  assert.ok(/stockLedgerKey\(kind, docNo\)/.test(src));
  assert.equal(
    (src.match(/stockLedgerKey\(/g) || []).length,
    2,
    "the writer and the delete must both build the key the same way"
  );
  assert.equal(
    /invoiceNo:\s*docNo/.test(src),
    false,
    "the bare document number must never be used as a stock key"
  );
});

test("the production routes write inside a transaction", () => {
  // A voucher saved without its stock rows, or rows without their voucher, is
  // the partial-write corruption withTransaction exists to prevent -- and the
  // only way back is a rebuild script.
  for (const route of ["../app/api/production-add/route.js", "../app/api/delete-production/route.js"]) {
    const src = read(route);
    assert.ok(/withTransaction/.test(src), `${route} writes outside a transaction`);
    assert.ok(/\{ session \}/.test(src), `${route} has a query that escapes the session`);
  }
});

test("no production route takes a rate from the request", () => {
  // A client that could post its own rates could post a cost of zero on a
  // voucher that consumed fifty thousand rupees of steel -- and on an alter
  // it could do that to an entry that was costed correctly yesterday.
  //
  // The lookup moved into lib/productionSave.mjs when `production-alter` was
  // added, so that both routes get it from one place. This checks whichever
  // file holds it, plus that neither route reads a rate off the body.
  const shared = read("../lib/productionSave.mjs");
  assert.ok(/costOf/.test(shared), "rates must come from the item master");

  for (const route of [
    "../app/api/production-add/route.js",
    "../app/api/production-alter/route.js",
    "../lib/productionSave.mjs",
  ]) {
    assert.equal(
      /rate:\s*(Number\()?\s*(line|body)/.test(read(route)),
      false,
      `${route} reads a rate off the request`
    );
  }
});

test("the formula routes share one validation path", () => {
  // customer-add and customer-alter once held DIFFERENT duplicate-name rules,
  // so a name blocked on create could be reached by renaming. Two copies of
  // this validation would go the same way.
  for (const route of ["../app/api/bom-add/route.js", "../app/api/bom-alter/route.js"]) {
    const src = read(route);
    assert.ok(/from ["']@\/lib\/bomSave\.mjs["']/.test(src), `${route} rolls its own`);
    assert.ok(/bomProblems/.test(src));
    assert.ok(/findNameClash/.test(src));
    assert.ok(/loopFromSaving/.test(src));
  }
});

test("only the edit route excludes a record from its own name check", () => {
  // Without excludeId, re-saving a formula without touching its name collides
  // with itself; with it on the CREATE path, nothing would be excluded and the
  // argument would be a lie.
  assert.ok(/excludeId/.test(read("../app/api/bom-alter/route.js")));
  assert.equal(/excludeId/.test(read("../app/api/bom-add/route.js")), false);
});

test("every new route is wrapped in tenantRoute", () => {
  // An unwrapped route does not read another firm's rows -- its first query
  // throws, because the schema plugin refuses to run without a tenant. It just
  // throws at the user instead of at us.
  const routes = [
    "bom", "get-bom", "bom-add", "bom-alter", "delete-bom", "bom-explode",
    "production", "get-production", "production-add", "delete-production",
    "next-production-no",
  ];
  for (const name of routes) {
    const src = read(`../app/api/${name}/route.js`);
    assert.ok(/tenantRoute\(/.test(src), `app/api/${name}/route.js is not scoped to a firm`);
  }
});

test("the dashboard reaches both new screens", () => {
  const src = read("../app/page.js");
  assert.ok(/router\.push\(['"]\/bom['"]\)/.test(src), "no tile for the formulas");
  // Production moved out of Reports and into the stock vouchers under
  // Receipts & Payments, where it is a row rather than a nav-tile -- so the
  // route is reached through the row's href, not a router.push of its own.
  assert.ok(/href: '\/production'/.test(src), "no row for production");
});

console.log("\n--- every import resolves ---");

/**
 * Resolve every relative and aliased import in the app's own source, against
 * the filesystem.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * order-add and order-alter shipped with `../../../../models/custModel` --
 * four levels up from app/api/<route>/, where the repo root is three. Six
 * "Module not found" errors on the Vercel build, and nothing caught it first:
 * `node --check` parses a file without resolving what it imports, and the
 * route assertions above only grep for text.
 *
 * Carried into this suite rather than left to the order one, because these
 * eleven new routes are the same shape of file that broke last time.
 *
 * NOTE: this sweeps the files that are actually on disk. Run against a partial
 * copy of the repo it will report misses that are really just files nobody
 * checked out.
 */
const ROOT = new URL("../", import.meta.url);
const exists = (rel) => {
  try {
    return fs.statSync(new URL(rel, ROOT)).isFile();
  } catch {
    return false;
  }
};
const isDir = (rel) => {
  try {
    return fs.statSync(new URL(rel, ROOT)).isDirectory();
  } catch {
    return false;
  }
};

const sourceFiles = () => {
  const out = [];
  const walk = (dir) => {
    if (!isDir(dir)) return;
    for (const entry of fs.readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (/\.(js|mjs|jsx)$/.test(entry.name)) out.push(rel);
    }
  };
  for (const dir of ["app/", "lib/", "models/", "components/", "context/"]) walk(dir);
  return out;
};

/** The extensions Next resolves, plus the directory-index forms. */
const CANDIDATES = ["", ".js", ".mjs", ".jsx", ".ts", ".tsx", "/index.js", "/index.mjs", "/index.jsx"];
const resolves = (target) => CANDIDATES.some((ext) => exists(target + ext));
const files = sourceFiles();

test("there are source files to sweep at all", () => {
  // Guards the guard: a walk that silently finds nothing would make every
  // check below pass without testing anything.
  assert.ok(files.length > 20, `only found ${files.length} source files`);
});

test("the new files are actually in the sweep", () => {
  // And guards it more specifically. A sweep that found eighty files but none
  // of the eleven new routes would also pass the check above.
  for (const f of [
    "lib/bom.mjs",
    "lib/bomSave.mjs",
    "models/bomModel.js",
    "models/productionModel.js",
    "app/api/production-add/route.js",
    "app/bomadd/page.js",
    "app/production/page.js",
  ]) {
    assert.ok(files.includes(f), `${f} was not swept`);
  }
});

test("every relative import points at a file that exists", () => {
  const misses = [];
  for (const file of files) {
    const src = fs.readFileSync(new URL(file, ROOT), "utf8");
    const dir = file.replace(/[^/]+$/, "");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      // Joined and normalised by hand -- these are posix repo paths, not host
      // paths, so node:path would be wrong on Windows.
      const parts = (dir + m[1]).split("/");
      const stack = [];
      for (const part of parts) {
        if (part === "." || part === "") continue;
        if (part === "..") stack.pop();
        else stack.push(part);
      }
      if (!resolves(stack.join("/"))) misses.push(`${file} -> ${m[1]}`);
    }
  }
  assert.deepEqual(misses, [], `unresolved imports:\n  ${misses.join("\n  ")}`);
});

test("every @/ import points at a file that exists", () => {
  const misses = [];
  for (const file of files) {
    const src = fs.readFileSync(new URL(file, ROOT), "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']@\/([^"']+)["']/g)) {
      if (!resolves(m[1])) misses.push(`${file} -> @/${m[1]}`);
    }
  }
  assert.deepEqual(misses, [], `unresolved aliased imports:\n  ${misses.join("\n  ")}`);
});

test("no new route reaches above the repo root", () => {
  // The exact shape of the shipped bug: from app/api/<name>/ the root is three
  // levels up, so a fourth leaves the project entirely.
  const offenders = files
    .filter((f) => /^app\/api\/[^/]+\/route\.js$/.test(f))
    .filter((f) => /["']\.\.\/\.\.\/\.\.\/\.\.\//.test(fs.readFileSync(new URL(f, ROOT), "utf8")));
  assert.deepEqual(offenders, []);
});

console.log("\n--- what reversing a production entry moves ---");

const ENTRY = {
  docNo: 12,
  date: new Date("2026-10-01"),
  outputItem: "Bracket",
  outputQuantity: 10,
  outputUnit: "NOS",
  lines: [
    { itemName: "Plate", kind: "material", quantity: 20, unit: "KG" },
    { itemName: "Scrap", kind: "wastage", quantity: 2, unit: "KG" },
    { itemName: "Offcut", kind: "byproduct", quantity: 1, unit: "KG" },
  ],
};

test("a reversal is the opposite of the movement, in both directions", () => {
  // The whole point of showing this before a delete: an entry moved stock in
  // two directions at once, so undoing it moves stock in two directions
  // again. What was RECEIVED comes out; what was ISSUED goes back in.
  const { outOfStock, backIntoStock } = reversalOf(ENTRY);
  assert.deepEqual(
    outOfStock.map((r) => r.itemName),
    ["Bracket", "Offcut"],
    "the finished item and the by-product were received, so they come out"
  );
  assert.deepEqual(
    backIntoStock.map((r) => r.itemName),
    ["Plate", "Scrap"],
    "the material and the wastage were issued, so they go back"
  );
});

test("a by-product never goes back INTO stock", () => {
  // The direction this function got wrong first time, by comparing the kind
  // string by hand instead of asking `consumes`. A by-product listed as going
  // back in would tell somebody a delete ADDS stock it actually removes.
  const { outOfStock, backIntoStock } = reversalOf(ENTRY);
  assert.ok(outOfStock.some((r) => r.itemName === "Offcut"));
  assert.ok(!backIntoStock.some((r) => r.itemName === "Offcut"));
  // And the direction is decided by the shared rule, not a local comparison.
  for (const row of [...outOfStock, ...backIntoStock]) {
    assert.ok(row.why, `${row.itemName} has no reason given`);
  }
});

test("the direction agrees with the ledger's own rule for every kind", () => {
  // stockDirection is what writeProductionLedgerRows uses. A reversal that
  // disagreed with it would describe the wrong thing on screen while the
  // server did the right thing -- worse than no dialog at all.
  for (const kind of LINE_KINDS) {
    const { outOfStock, backIntoStock } = reversalOf({
      outputItem: "",
      lines: [{ itemName: "X", kind, quantity: 1, unit: "KG" }],
    });
    const wentIn = backIntoStock.some((r) => r.itemName === "X");
    const cameOut = outOfStock.some((r) => r.itemName === "X");
    assert.notEqual(wentIn, cameOut, `${kind} must move exactly one way`);
    assert.equal(
      wentIn,
      stockDirection(kind) === "issue",
      `${kind} issues on save, so a reversal must put it back`
    );
  }
});

test("an unknown kind reverses as a material, as it posts", () => {
  const { backIntoStock } = reversalOf({
    outputItem: "",
    lines: [{ itemName: "Mystery", quantity: 3, unit: "KG" }],
  });
  assert.deepEqual(backIntoStock.map((r) => r.itemName), ["Mystery"]);
});

test("blank and zero lines are left out", () => {
  // A dialog listing "0 KG of nothing" reads as a bug.
  const { backIntoStock } = reversalOf({
    outputItem: "",
    lines: [
      { itemName: "", quantity: 5 },
      { itemName: "Zero", quantity: 0 },
      { itemName: "Real", quantity: 1 },
    ],
  });
  assert.deepEqual(backIntoStock.map((r) => r.itemName), ["Real"]);
});

test("no entry at all is an empty summary, not a crash", () => {
  assert.deepEqual(reversalOf(null), { outOfStock: [], backIntoStock: [] });
  assert.deepEqual(reversalOf({}), { outOfStock: [], backIntoStock: [] });
});

test("quantities are rounded by the project's one rule", () => {
  const { outOfStock } = reversalOf({ outputItem: "A", outputQuantity: 1 / 3, lines: [] });
  assert.equal(outOfStock[0].quantity, roundQty(1 / 3));
});

console.log("\n--- altering and deleting a production entry ---");

test("there is a route to alter an entry, and it is a PATCH", () => {
  const src = read("../app/api/production-alter/route.js");
  assert.match(src, /export const PATCH = tenantRoute\(/);
  assert.doesNotMatch(src, /^export\s+async\s+function\s+PATCH\b/m, "it must be wrapped");
});

test("the alter route never changes the document number", () => {
  // The stock rows are keyed "PRD-<docNo>" and the writer deletes by that key
  // before writing. Rewriting under the entry's OWN number replaces its
  // movements exactly. Let the number change and the new rows land under a new
  // key while the old ones sit under the old one forever, counted by the stock
  // report and attached to a voucher that no longer exists.
  const src = read("../app/api/production-alter/route.js");
  assert.ok(/docNo: existing\.docNo/.test(src), "the stored number must win");
  assert.doesNotMatch(src, /docNo: Number\(body\.docNo\)|docNo = requested/, "it honours the request");
  assert.ok(/getNextProductionNo/.test(src) === false, "an alter allocates nothing");
});

test("the alter writes the entry and its stock in one transaction", () => {
  const src = read("../app/api/production-alter/route.js");
  assert.ok(/withTransaction/.test(src));
  const body = src.slice(src.indexOf("withTransaction"));
  assert.ok(/findOneAndUpdate/.test(body), "the entry is updated inside it");
  assert.ok(/writeProductionLedgerRows/.test(body), "and the stock with it");
  assert.ok(/session,/.test(body), "the session has to reach the writer");
});

test("the alter and the add share one pipeline", () => {
  // The same item lookup, the same choice between the form's lines and a
  // fresh explosion, the same validation and the same rate freezing. Two
  // copies is two chances for an alter to value a batch differently from the
  // way the original save valued it -- which is how customer-add and
  // customer-alter ended up with different duplicate-name rules.
  for (const route of ["../app/api/production-add/route.js", "../app/api/production-alter/route.js"]) {
    const src = read(route);
    assert.ok(/buildProductionEntry/.test(src), `${route} rolls its own`);
    assert.ok(/@\/lib\/productionSave\.mjs/.test(src), `${route} does not import the shared one`);
  }
  // And neither route re-implements the validation it used to hold inline.
  const add = read("../app/api/production-add/route.js");
  assert.doesNotMatch(add, /productionProblems/, "the add still validates for itself");
  assert.doesNotMatch(add, /toProductionLines/, "the add still freezes rates for itself");
});

test("rates are read from the master on an alter too", () => {
  // A client that could post its own rates could zero the cost of an entry
  // that was costed correctly yesterday.
  const src = read("../lib/productionSave.mjs");
  assert.ok(/toProductionLines\(\{ lines, costOf \}\)/.test(src));
  assert.ok(/costOf = \(itemName\) =>/.test(src), "cost comes from the item index");
});

test("who raised the entry survives an edit", () => {
  // Sigfa keeps both: LUSER for who made it, LUSERE for who last touched it.
  // The schema already carried both columns, so there was nothing to invent.
  const src = read("../app/api/production-alter/route.js");
  assert.ok(/createdBy: existing\.createdBy/.test(src), "createdBy must not be overwritten");
  assert.ok(/updatedBy: auth\?\.name/.test(src));
  assert.ok(/\$inc: \{ editCount: 1 \}/.test(src), "Sigfa counts edits on a voucher");
  // Declared on the model, or Mongoose strict mode drops it in silence.
  const model = read("../models/productionModel.js");
  assert.ok(/updatedBy: \{ type: String \}/.test(model));
  assert.ok(/editCount: \{ type: Number/.test(model));
});

test("altering an entry is a voucher write, and a biller cannot", () => {
  assert.equal(permissionForPath("/api/production-alter"), "voucher:write");
  assert.equal(canAccessPath("owner", "/api/production-alter"), true);
  assert.equal(canAccessPath("accountant", "/api/production-alter"), true);
  assert.equal(canAccessPath("biller", "/api/production-alter"), false);
  // Listed in its own right: a prefix rule matches an exact path or one
  // followed by "/", so "/api/production-alter" does NOT match
  // "/api/production" -- which demands only voucher:read.
  assert.ok(read("../lib/roles.mjs").includes('["/api/production-alter", "voucher:write"]'));
});

test("the screen can open a recorded entry, and says which one", () => {
  const src = read("../app/production/page.js");
  assert.ok(/loadForEdit/.test(src));
  assert.ok(/get-production\?id=/.test(src), "the register leaves the lines out, so it refetches");
  // Without the banner the form looks like a new entry, and Save on what
  // somebody believes is a blank form would quietly rewrite a recorded batch.
  assert.ok(/Editing <span className="font-medium">production \{editing\.docNo\}/.test(src));
  assert.ok(/Cancel edit/.test(src));
  assert.ok(/Update production \$\{editing\.docNo\}/.test(src));
});

test("an edit loads what was saved, not a fresh explosion", () => {
  // A formula edited since the batch was made must not retroactively rewrite
  // what that batch consumed. The screen's own note: a batch that actually
  // used a bit more of something should be recorded as it happened.
  const src = read("../app/production/page.js");
  const loader = src.slice(src.indexOf("const loadForEdit"), src.indexOf("const cancelEdit"));
  assert.ok(/setLines\(entry\.lines \|\| \[\]\)/.test(loader), "the stored lines");
  assert.doesNotMatch(loader, /bom-explode/, "it must not re-explode the formula");
  // The costing comes off the entry for the same reason.
  assert.ok(/materialValue: entry\.materialValue/.test(loader));
});

test("the screen sends an alter to the alter route", () => {
  const src = read("../app/production/page.js");
  assert.ok(/editing \? '\/api\/production-alter' : '\/api\/production-add'/.test(src));
  assert.ok(/editing \? 'PATCH' : 'POST'/.test(src));
  assert.ok(/editing \? \{ id: editing\._id \} : \{\}/.test(src));
  // Still not sending rates, on either path.
  const save = src.slice(src.indexOf("const save = async"));
  assert.doesNotMatch(save.slice(0, 1800), /rate:|amount:/);
});

test("deleting an entry is confirmed, and the dialog lists both directions", () => {
  // It used to be a single unconfirmed click that silently rewrote inventory
  // in two directions.
  const src = read("../app/production/page.js");
  assert.ok(/askDelete/.test(src) && /doDelete/.test(src));
  assert.ok(/reversalOf/.test(src), "the dialog must use the shared rule");
  assert.ok(/Comes back out of stock/.test(src));
  assert.ok(/Goes back into stock/.test(src));
  assert.ok(/role="dialog"/.test(src) && /aria-modal="true"/.test(src));
  // And nothing deletes without going through it.
  assert.doesNotMatch(src, /onClick=\{\(\) => deleteEntry\(/, "a direct delete button remains");
});

test("deleting the entry being edited clears the form", () => {
  // Otherwise saving it afterwards would recreate it under a number that is
  // gone, and the unique index would turn that into a failed save nobody
  // could explain.
  const src = read("../app/production/page.js");
  assert.ok(/if \(editing && editing\._id === confirming\.entry\._id\) cancelEdit\(\)/.test(src));
});

test("the formula register already offers both, and still does", () => {
  // BOM alter and delete were built with the master itself. Asserted here so
  // the production work above cannot be mistaken for having added them.
  const src = read("../app/bom/page.js");
  assert.ok(/bomadd\?id=/.test(src), "Edit goes to the form with an id");
  assert.ok(/delete-bom/.test(src));
  assert.ok(/askDelete/.test(src) && /doDelete/.test(src), "and it confirms");
  const form = read("../app/bomadd/page.js");
  assert.ok(/editingId \? '\/api\/bom-alter' : '\/api\/bom-add'/.test(form));
});

console.log("\n--- the three stock vouchers Sigfa keeps in one table ---");

const GOODS_LINES = [
  { itemName: "Plate", kind: "material", quantity: 20, unit: "KG" },
  { itemName: "Scrap", kind: "wastage", quantity: 2, unit: "KG" },
  { itemName: "Offcut", kind: "byproduct", quantity: 1, unit: "KG" },
];

test("the kinds are Sigfa's own MKEY codes", () => {
  // Read out of SIGFA105.exe, from the rows it seeds MkeyMaster with:
  //   'FR' Production, 'IS' Goods Issued, 'RS' Goods Received.
  // Its three characters rather than a prettier slug, so a row here and a row
  // there say the same thing.
  assert.deepEqual([...STOCK_KIND_CODES].sort(), ["FR", "IS", "RS"]);
  assert.equal(STOCK_KINDS.FR.label, "Production");
  assert.equal(STOCK_KINDS.IS.label, "Goods Issued");
  assert.equal(STOCK_KINDS.RS.label, "Goods Received");
});

test("an entry written before kinds existed is a production entry", () => {
  // THE MIGRATION RULE. Every row in `productions` predating this field is a
  // production entry and carries no kind at all, so an absent one must read
  // as 'FR' -- otherwise the register loses them and their stock rows are
  // looked for under the wrong prefix.
  assert.equal(DEFAULT_KIND, "FR");
  assert.equal(kindOf({}), "FR");
  assert.equal(kindOf({ kind: null }), "FR");
  assert.equal(kindOf({ kind: "" }), "FR");
  assert.equal(kindOf(undefined), "FR");
  assert.equal(kindOf({ kind: "is" }), "IS", "case does not matter on the way in");
});

test("an unknown kind reads as production but cannot be asked for", () => {
  // Reading is lenient so a row written by a future version still lists;
  // creating is strict, because treating a mistyped kind as Production would
  // write a finished item into stock on a document meant to send goods out.
  assert.equal(kindOf({ kind: "ZZ" }), "FR");
  assert.equal(isStockKind("ZZ"), false);
  assert.equal(isStockKind(""), false);
  assert.equal(isStockKind("IS"), true);
  assert.equal(isStockKind("is"), true);
});

test("production keeps the ledger prefix its rows already carry", () => {
  // Renaming it would orphan every stock row ever written by a production
  // entry -- they are keyed "PRD-<docNo>" in the database right now.
  assert.equal(stockLedgerKey("FR", 5), "PRD-5");
  assert.equal(stockLedgerKey({}, 5), "PRD-5", "and so does an unstamped one");
});

test("each kind has its own prefix, so numbers may repeat across them", () => {
  // Goods Issue 5 and Production 5 are different vouchers under different
  // keys. If they shared a key, writing one would delete the other's stock
  // rows -- writeProductionLedgerRows opens by deleting everything under the
  // key it is given.
  const keys = STOCK_KIND_CODES.map((k) => stockLedgerKey(k, 5));
  assert.deepEqual(keys, ["PRD-5", "GI-5", "GR-5"]);
  assert.equal(new Set(keys).size, 3, "two kinds share a key");
  // And no prefix is a prefix of another, or a startsWith test would match
  // the wrong kind.
  for (const a of STOCK_KIND_CODES) {
    for (const b of STOCK_KIND_CODES) {
      if (a === b) continue;
      assert.equal(
        STOCK_KINDS[a].prefix.startsWith(STOCK_KINDS[b].prefix),
        false,
        `${a}'s prefix starts with ${b}'s`
      );
    }
  }
});

test("each kind draws from its own counter", () => {
  // One series per kind, as Sigfa numbers per MKEY. A shared counter would
  // make a shop's goods-issue register read 1, 4, 9 and get reported as
  // missing documents.
  const counters = STOCK_KIND_CODES.map((k) => STOCK_KINDS[k].counter);
  assert.equal(new Set(counters).size, 3);
  assert.equal(STOCK_KINDS.FR.counter, "productionNo", "the existing counter is kept");
});

test("a goods issue sends everything out, whatever the line says", () => {
  // The VOUCHER decides, not the line. A by-product line on a goods issue
  // still leaves stock -- there is only one direction on the document.
  const { issues, receipts } = stockMovements({ kind: "IS", lines: GOODS_LINES });
  assert.deepEqual(issues.map((r) => r.itemName), ["Offcut", "Plate", "Scrap"]);
  assert.deepEqual(receipts, []);
});

test("a goods receipt brings everything in, whatever the line says", () => {
  const { issues, receipts } = stockMovements({ kind: "RS", lines: GOODS_LINES });
  assert.deepEqual(receipts.map((r) => r.itemName), ["Offcut", "Plate", "Scrap"]);
  assert.deepEqual(issues, []);
});

test("production still moves both ways, by line", () => {
  const { issues, receipts } = stockMovements({
    kind: "FR",
    outputItem: "Bracket",
    outputQuantity: 10,
    lines: GOODS_LINES,
  });
  assert.deepEqual(issues.map((r) => r.itemName), ["Plate", "Scrap"]);
  assert.deepEqual(receipts.map((r) => r.itemName), ["Bracket", "Offcut"]);
});

test("production's movements are what they always were", () => {
  // THE REGRESSION THAT MATTERS. stockMovements is a generalisation of
  // productionMovements, not a second implementation beside it: for 'FR' it
  // must return exactly what the old function returned, or every existing
  // production entry starts moving different stock.
  for (const fixture of [
    { outputItem: "Bracket", outputQuantity: 10, lines: GOODS_LINES },
    { outputItem: "A", outputQuantity: 1, lines: [] },
    { outputItem: "", outputQuantity: 0, lines: GOODS_LINES },
    { outputItem: "Plate", outputQuantity: 5, lines: GOODS_LINES },
  ]) {
    assert.deepEqual(
      stockMovements({ kind: "FR", ...fixture }),
      productionMovements(fixture),
      JSON.stringify(fixture).slice(0, 60)
    );
    // And an unstamped entry takes the same path.
    assert.deepEqual(stockMovements({ ...fixture }), productionMovements(fixture));
  }
});

test("only production has a finished item", () => {
  // A goods issue with an output would RECEIVE stock on a document whose
  // whole purpose is to send it out.
  for (const kind of ["IS", "RS"]) {
    const { issues, receipts } = stockMovements({
      kind,
      outputItem: "Bracket",
      outputQuantity: 10,
      lines: [],
    });
    assert.deepEqual([...issues, ...receipts], [], `${kind} invented a movement`);
  }
  assert.equal(stockKind("IS").hasOutput, false);
  assert.equal(stockKind("RS").hasOutput, false);
  assert.equal(stockKind("FR").hasOutput, true);
});

test("a goods voucher is refused an output, and refused no lines", () => {
  assert.match(
    stockKindProblems({ kind: "IS", outputItem: "Bracket", lines: [{}] })[0],
    /no finished item/i
  );
  assert.match(stockKindProblems({ kind: "RS", lines: [] })[0], /at least one item/i);
  assert.deepEqual(stockKindProblems({ kind: "IS", lines: [{}] }), []);
  // Production is validated by productionProblems instead, which demands the
  // output this would reject.
  assert.deepEqual(stockKindProblems({ kind: "FR", outputItem: "Bracket", lines: [{}] }), []);
});

test("a line's direction follows the voucher, except on production", () => {
  for (const line of GOODS_LINES) {
    assert.equal(lineDirection("IS", line), "issue", line.kind);
    assert.equal(lineDirection("RS", line), "receipt", line.kind);
  }
  assert.equal(lineDirection("FR", { kind: "material" }), "issue");
  assert.equal(lineDirection("FR", { kind: "wastage" }), "issue");
  assert.equal(lineDirection("FR", { kind: "byproduct" }), "receipt");
});

test("reversing a voucher is its movements, swapped", () => {
  // Derived from stockMovements rather than decided again, so there is one
  // direction rule. Deciding it separately is how the first version had
  // by-products going back INTO stock -- the one direction they never move.
  for (const entry of [
    { kind: "FR", outputItem: "Bracket", outputQuantity: 10, outputUnit: "NOS", lines: GOODS_LINES },
    { kind: "IS", lines: GOODS_LINES },
    { kind: "RS", lines: GOODS_LINES },
  ]) {
    const moves = stockMovements({ ...entry, lines: entry.lines });
    const reversal = reversalOf(entry);
    assert.deepEqual(
      reversal.outOfStock.map((r) => r.itemName),
      moves.receipts.map((r) => r.itemName),
      `${entry.kind}: what was received must come out`
    );
    assert.deepEqual(
      reversal.backIntoStock.map((r) => r.itemName),
      moves.issues.map((r) => r.itemName),
      `${entry.kind}: what was issued must go back`
    );
  }
});

test("a goods receipt reverses by taking stock OUT", () => {
  // The direction somebody reading quickly would get backwards.
  const r = reversalOf({ kind: "RS", lines: [{ itemName: "Plate", quantity: 5, unit: "KG" }] });
  assert.deepEqual(r.outOfStock.map((x) => x.itemName), ["Plate"]);
  assert.deepEqual(r.backIntoStock, []);

  const i = reversalOf({ kind: "IS", lines: [{ itemName: "Plate", quantity: 5, unit: "KG" }] });
  assert.deepEqual(i.backIntoStock.map((x) => x.itemName), ["Plate"]);
  assert.deepEqual(i.outOfStock, []);
});

test("the reversal carries the unit and a reason for the dialog", () => {
  const r = reversalOf({
    kind: "FR",
    outputItem: "Bracket",
    outputQuantity: 10,
    outputUnit: "NOS",
    lines: GOODS_LINES,
  });
  const bracket = r.outOfStock.find((x) => x.itemName === "Bracket");
  assert.equal(bracket.unit, "NOS");
  assert.equal(bracket.why, "produced");
  const plate = r.backIntoStock.find((x) => x.itemName === "Plate");
  assert.equal(plate.unit, "KG");
  assert.equal(plate.why, "material");
});

test("no entry at all is an empty reversal, not a crash", () => {
  assert.deepEqual(reversalOf(null), { outOfStock: [], backIntoStock: [] });
  assert.deepEqual(reversalOf({}), { outOfStock: [], backIntoStock: [] });
});

console.log("\n--- the three kinds are wired through, end to end ---");

test("the model carries the kind, and only production needs an output", () => {
  const src = read("../models/productionModel.js");
  assert.ok(/kind: \{/.test(src));
  assert.ok(/enum: STOCK_KIND_CODES/.test(src), "the enum comes from the shared list");
  assert.ok(/default: DEFAULT_KIND/.test(src));
  // Conditionally required, or every goods voucher fails validation.
  assert.equal(
    (src.match(/required: function requiredForProduction/g) || []).length,
    2,
    "outputItem and outputQuantity must both be conditional"
  );
});

test("the unique index is per kind, and a backfill exists for the old rows", () => {
  // (companyId, docNo) alone would stop Goods Issue 5 existing beside
  // Production 5. (companyId, kind, docNo) allows it -- but to Mongo a
  // missing kind is a distinct value, so the old rows have to be stamped or
  // two production entries could share a number.
  const src = read("../models/productionModel.js");
  assert.ok(/index\(\{ companyId: 1, kind: 1, docNo: 1 \}, \{ unique: true \}\)/.test(src));
  assert.doesNotMatch(src, /index\(\{ companyId: 1, docNo: 1 \}, \{ unique: true \}\)/);
  const backfill = read("../scripts/backfill-stock-kind.mjs");
  assert.ok(/DEFAULT_KIND/.test(backfill));
  assert.ok(/--apply/.test(backfill), "it must have a dry run");
});

test("every route that touches stock passes the kind", () => {
  // The key depends on it. A route that forgot would write a goods issue's
  // rows under "PRD-" and delete a production entry's.
  for (const route of [
    "../app/api/production-add/route.js",
    "../app/api/production-alter/route.js",
    "../app/api/delete-production/route.js",
  ]) {
    const src = read(route);
    assert.ok(/kind/.test(src), `${route} never mentions the kind`);
  }
  assert.ok(/kind,\n        docNo,/.test(read("../app/api/production-add/route.js")));
  assert.ok(/kind: kindOf\(updated\)/.test(read("../app/api/production-alter/route.js")));
  assert.ok(/kind: kindOf\(entry\)/.test(read("../app/api/delete-production/route.js")));
});

test("an alter cannot change a voucher's kind", () => {
  // Its stock rows are keyed by the kind's prefix, so the old ones would be
  // stranded under "PRD-" while the new ones landed under "GI-".
  const src = read("../app/api/production-alter/route.js");
  assert.ok(/kind: kindOf\(existing\)/.test(src));
});

test("the numbering is per kind on both the reserve and the peek", () => {
  const src = read("../lib/getNextProductionNo.js");
  assert.ok(/counterFor\(kind\)/.test(src));
  // The highest existing entry is looked for WITHIN the kind, or a firm's
  // first goods issue is numbered 48 because it has 47 production entries.
  assert.ok(/kindFilter\(kind\)/.test(src));
  // And an unstamped row counts as production, or the next production entry
  // takes a number already in the book.
  assert.ok(/\$exists: false/.test(src));
});

test("the register and the peek are both told which kind", () => {
  assert.ok(/searchParams.get\("kind"\)/.test(read("../app/api/production/route.js")));
  assert.ok(/searchParams.get\("kind"\)/.test(read("../app/api/next-production-no/route.js")));
  // An unknown kind is refused rather than quietly listing production.
  for (const route of ["../app/api/production/route.js", "../app/api/next-production-no/route.js"]) {
    assert.ok(/is not a stock voucher kind/.test(read(route)), route);
  }
});

test("one screen serves all three, and says which it is", () => {
  const src = read("../app/production/page.js");
  assert.ok(/params.get\('kind'\)/.test(src));
  // The heading is Sigfa's FORM title now -- "Issue Slip", not "Goods
  // Issued" -- while the subtitle still describes the kind.
  assert.ok(/\{slipTitle\(kind\)\}/.test(src));
  assert.ok(/\{config.blurb\}/.test(src));
  // The formula panel is production's alone.
  assert.ok(/config.usesFormula &&/.test(src));
  assert.ok(/!config.usesFormula &&/.test(src));
  // And the goods vouchers pick items with the billing screens' own search,
  // rather than a second one written here.
  assert.ok(/from '@\/components\/billing\/ItemSearch'/.test(src));
});

test("the three sit together on the dashboard", () => {
  const src = read("../app/page.js");
  assert.ok(/'\/production\?kind=IS'/.test(src));
  assert.ok(/'\/production\?kind=RS'/.test(src));
  // Out of Reports, where a voucher that moves stock did not belong.
  const reports = src.slice(src.indexOf("Reports</h2>"));
  assert.doesNotMatch(reports, /href: '\/production'/, "still under Reports");
});

test("the three stack, one per row, at every width", () => {
  // A three-across grid put all of them on one line on a desktop, which made
  // them read as a different kind of control from the Cash and Bank rows
  // directly above and left three short labels stranded in a wide row.
  const src = read("../app/page.js");
  assert.equal(
    (src.match(/renderStockVoucherRow\(\{/g) || []).length,
    3,
    "all three must go through the row renderer"
  );
  // No column grid around them -- that is what put them side by side.
  // Anchored on the WRAPPER, which is the thing that decides the layout.
  // Slicing from the "Stock, without a bill" caption forward missed it: the
  // caption is INSIDE the wrapper, so the class that would put the three on
  // one line sits just before the slice began, and the check passed with a
  // three-column grid in place.
  const at = src.indexOf("Stock, without a bill");
  assert.ok(at > 0, "the stock voucher block is gone");
  const openedAt = src.lastIndexOf('<div className="', at);
  const wrapper = src.slice(openedAt, src.indexOf(">", openedAt));
  assert.doesNotMatch(
    wrapper,
    /grid-cols-\d/,
    `a column grid puts them back on one line: ${wrapper}`
  );
  assert.ok(/space-y-/.test(wrapper), `the rows should be stacked: ${wrapper}`);
});

test("a stock voucher row looks like the cash and bank rows above it", () => {
  // Same shape, because it sits directly under them: icon square, label and
  // subtext, action on the right.
  const src = read("../app/page.js");
  const renderer = src.slice(
    src.indexOf("const renderStockVoucherRow"),
    src.indexOf("const renderModuleRow")
  );
  assert.ok(/nav-tile-icon h-8 w-8/.test(renderer), "the same icon square");
  assert.ok(/min-w-0 flex-1/.test(renderer));
  assert.ok(/truncate text-sm font-medium text-foreground/.test(renderer));
  assert.ok(/rounded-lg border border-border bg-card/.test(renderer));
  // One action, not the masters' Manage dropdown: a stock voucher is altered
  // and deleted from its own register.
  assert.doesNotMatch(renderer, /DropdownMenu/);
  assert.ok(/Open/.test(renderer));
});

test("there is only one reversal rule in the codebase", () => {
  // It lived in lib/bom.mjs first and moved to lib/stockVoucher.mjs when the
  // other two kinds arrived. Two copies of a direction rule is how a
  // by-product ends up going back into stock.
  assert.doesNotMatch(read("../lib/bom.mjs"), /export const reversalSummary/);
  assert.ok(/export const reversalOf/.test(read("../lib/stockVoucher.mjs")));
});

console.log("\n--- the slip matches Sigfa's, field for field ---");

test("the form is headed the way Sigfa heads it", () => {
  // Its MkeyMaster calls these "Goods Issued" and "Goods Received"; its FORM
  // is headed "Issue Slip" and "Receipt Slip". Both names are Sigfa's, so
  // both are kept -- the first for the register and the dashboard, the second
  // for the slip itself.
  assert.equal(slipTitle("IS"), "Issue Slip");
  assert.equal(slipTitle("RS"), "Receipt Slip");
  assert.equal(slipTitle("FR"), "Production");
  assert.equal(stockKind("IS").label, "Goods Issued", "the list name is unchanged");
});

test("the header fields are Sigfa's, in its order", () => {
  assert.deepEqual(SLIP_HEADER_FIELDS, ["Series", "Slip No.", "Date", "Store", "Party"]);
});

test("the grid columns are Sigfa's, in its order and its spelling", () => {
  // "S.No." with both full stops, as its header prints it.
  assert.deepEqual(SLIP_COLUMNS, [
    "S.No.",
    "Item Name",
    "Unit",
    "Quantity",
    "Rate",
    "Amount",
  ]);
});

test("the date reads as Sigfa prints it, day included", () => {
  // "11-10-2026 (Sun)" off its slip.
  assert.equal(slipDate("2026-10-11"), "11-10-2026");
  assert.equal(slipDayName("2026-10-11"), "Sun");
  // A SINGLE-DIGIT day and month, which the sample date hides: both are
  // padded, so the column stays aligned and the format never shrinks to
  // "5-1-2026". Dropping the padding passed every check until this was added.
  assert.equal(slipDate("2026-01-05"), "05-01-2026");
  assert.equal(slipDate("2026-12-31"), "31-12-2026");
});

test("the day is the IST day, not the server's", () => {
  // The container runs Asia/Calcutta and Vercel runs UTC, so a late-evening
  // slip would carry yesterday's day name on one of them. Checked at the
  // boundary: 18:30 UTC is already the next day in IST.
  assert.equal(slipDayName("2026-10-11T18:29:00Z"), "Sun");
  assert.equal(slipDayName("2026-10-11T18:30:00Z"), "Mon");
  assert.equal(slipDate("2026-10-11T18:30:00Z"), "12-10-2026");
});

test("a missing or unreadable date prints nothing, not Invalid Date", () => {
  for (const bad of ["", null, undefined, "rubbish"]) {
    assert.equal(slipDayName(bad), "");
    assert.equal(slipDate(bad), "");
  }
});

test("Amount is quantity times rate, and the total adds them", () => {
  // No discount, no tax, no rounding of its own: a goods slip carries none.
  assert.equal(slipAmount({ quantity: 3, rate: 12.5 }), 37.5);
  assert.equal(slipAmount({ quantity: 3 }), 0, "no rate is no amount");
  assert.equal(slipAmount({}), 0);
  assert.equal(slipTotal([{ quantity: 3, rate: 12.5 }, { quantity: 2, rate: 10 }]), 57.5);
  assert.equal(slipTotal([]), 0);
  assert.equal(slipTotal(), 0);
});

test("the series box offers back what has been used, once each", () => {
  // Sigfa backs this with a master; there is none here, so the list fills
  // itself from the slips already written.
  // Given OUT OF ORDER, so the sort is actually exercised: the first fixture
  // happened to be alphabetical already, and deleting the sort passed.
  assert.deepEqual(seriesUsed([{ series: "RMI" }, { series: "MI" }, { series: "RMI" }]), [
    "MI",
    "RMI",
  ]);
  assert.deepEqual(seriesUsed([{ series: "Z" }, { series: "A" }, { series: "M" }]), [
    "A",
    "M",
    "Z",
  ]);
  // Case-insensitively unique, but the spelling first used is offered back.
  assert.deepEqual(seriesUsed([{ series: "mi" }, { series: "MI" }]), ["mi"]);
  assert.deepEqual(seriesUsed([{ series: "" }, {}, { series: "   " }]), []);
  assert.deepEqual(seriesUsed(), []);
});

test("Series and Store are stored, and Store is honest about itself", () => {
  const model = read("../models/productionModel.js");
  assert.ok(/series: \{ type: String/.test(model));
  assert.ok(/store: \{ type: String/.test(model));

  // THE PART THAT MATTERS. Sigfa holds stock per store -- STORECODE is on its
  // RIssue and its PhyStock alike -- and this app does not. A Store box with
  // nothing said would read as segregating stock that it does not segregate.
  const page = read("../app/production/page.js");
  assert.ok(
    /Stock is held in one place/.test(page),
    "the screen must say the store does not split stock"
  );
  assert.doesNotMatch(read("../lib/itemLedger.mjs"), /store/i, "there is no store on a stock row");
});

test("the slip carries Series and Store through to the save", () => {
  const page = read("../app/production/page.js");
  // The series is sent NORMALIZED -- the box became a <select> off the series
  // master (lib/series.mjs), and its options are upper-cased codes. `store` is
  // still free text with no master behind it.
  assert.ok(/series: chosenSeries/.test(page));
  assert.ok(/const chosenSeries = normalizeSeriesCode\(form\.series\)/.test(page));
  assert.ok(/store: form\.store/.test(page));
  const save = read("../lib/productionSave.mjs");
  assert.ok(/series: text\(body\.series\)/.test(save));
  assert.ok(/store: text\(body\.store\)/.test(save));
  // And an edit loads them back, or re-saving a slip would blank them. The
  // series goes through the same normalization on the way in: a slip written
  // as "mi" before the master existed must not land on a <select> that has no
  // such option, which would show blank and then save the series cleared.
  assert.ok(/series: normalizeSeriesCode\(entry\.series\)/.test(page));
  assert.ok(/store: entry\.store \|\| ''/.test(page));
});

test("the screen builds its grid from the shared column list", () => {
  // Not retyped into the JSX, or the headings and the tests drift the first
  // time one changes.
  const page = read("../app/production/page.js");
  for (const heading of ["S.No.", "Item Name", "Unit", "Quantity", "Rate", "Amount"]) {
    assert.ok(page.includes(heading), `${heading} is missing from the slip`);
  }
  assert.ok(/slipAmount\(line\)/.test(page), "Amount must come from the shared rule");
  assert.ok(/slipTotal\(lines\)/.test(page));
});

test("the rate is shown but never sent", () => {
  // A client that could post its own rates could value a slip at nothing.
  // The browser shows the item master's cost so the Amount column is filled
  // in; the server reads the rate again on save.
  const page = read("../app/production/page.js");
  const save = page.slice(page.indexOf("const save = async"));
  const body = save.slice(0, save.indexOf("});"));
  assert.doesNotMatch(body, /rate:/, "a rate is being sent");
  assert.ok(/rate: Number\(item\.cost\) \|\| 0/.test(page), "the rate should be shown");
  assert.ok(/toProductionLines/.test(read("../lib/productionSave.mjs")));
});

test("the slip shows its number before it is saved", () => {
  // Sigfa shows Slip No. on the blank form. A peek, not a reservation:
  // opening the slip and walking away must not burn a number.
  const page = read("../app/production/page.js");
  assert.ok(/next-production-no\?kind=/.test(page));
  assert.ok(/Slip No\./.test(page));
  assert.ok(/peekNextProductionNo/.test(read("../lib/getNextProductionNo.js")));
});

console.log(`\n${passed} checks passed`);
